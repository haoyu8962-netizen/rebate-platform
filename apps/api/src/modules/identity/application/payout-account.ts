// 收款账号 (规划/08 BR-WDR-02, BR-WDR-01, BR-ID-31, BR-ID-33; 04 §6.1; task B1-13e §9.2).
//
// createPayoutAccountReader — GET /v1/me/payout-account: the current row (is_current) of the user
// in the app, masked (BR-ID-33 细则「收款账号的脱敏格式」), with payout_account_id = that row's id
// (the step-up summary of a withdrawal, CT-26c; a change writes a new row, so the id changes),
// plus change_remaining_this_month =
// max(0, monthly limit − rows of payout_account_changes of this user and app whose changed_at lies
// in the +08:00 natural month of the injected Clock and whose limit_exempt_reason is NULL: the rows
// a realname correction wrote (B2-05j, application/payout-account-invalidation.ts) are not counted). No current row → {} (EmptyData). The
// decrypted logon id or card number lives only in memory long enough to be masked.
//
// createPayoutAccountService().save — the Alipay binding / change, run by B1-13f's PUT controller
// inside its idempotency / withStepUp transaction (this service neither reads nor settles the
// step_up_token: any refusal here makes the caller release it, BR-WDR-01). Order:
//   before the lock (no row written, no lock taken): withdraw.payout_methods without alipay →
//   20001 fields=[payout_method]; logon id normalisation (domain/alipay-logon.ts) → 20001
//   fields=[alipay_logon_id] (reason phone_invalid for the phone form);
//   users row lock, then inside it, each read fresh: ⓪ the alipay blocklist (risk) → 44001;
//   no verified realname → 30304; ① normalised payee name ≠ normalised realname name → 30307;
//   ② the alipay_hmac is another member's current binding in the app → 30308; the current binding
//   and this month's change rows; the same account (payout_method + HMAC) → 0 with the current
//   binding, nothing written, not counted; ④ a change with this month's rows ≥ the limit → 30303
//   data.reason=payout_account_change_limit; otherwise (a savepoint around the writes) the old
//   current row is set is_current=false (row_version CAS) and a payout_account_changes row is
//   appended (a first binding writes none), then the new current row is inserted. A unique
//   violation of payout_accounts_current_alipay_key (a concurrent binding the occupancy read could
//   not see) rolls back to the savepoint and answers 30308, leaving the caller's transaction
//   usable. Nothing is deleted; payout_account_changes is append-only.
//
// The user lock is `SELECT … FROM users … FOR NO KEY UPDATE`: it conflicts with every FOR UPDATE /
// FOR NO KEY UPDATE holder of the row (the other payout saves, BR-WDR-07 ① withdrawal creation,
// the verification reservation), so the saves of one user are serialised and the monthly limit
// cannot be overrun (BR-WDR-02 细则「保存在用户级锁内」). FOR UPDATE itself would deadlock: a
// blocklist hit is recorded by risk in an independent short transaction whose risk_hits row
// references users, and that foreign-key check takes FOR KEY SHARE on this very row, which FOR
// UPDATE blocks while this transaction waits for the record (login-completion.ts precedent).
// No balance row and no advisory lock are taken. Callers must not hold FOR UPDATE on the users row
// before calling save, for the same reason.
//
// Configuration (orchestrator ruling E40): withdraw.payout_methods (a non-empty set drawn from
// alipay / bank_card / wechat, default [alipay, bank_card]) and
// withdraw.payout_account_change_per_month (a whole number ≥ 0, default 2), read through the
// injected PayoutAccountConfigPort on the caller's handle (app.module binds content's reader to it,
// B1-11d precedent: no second pooled connection while the transaction is held); a missing or
// malformed value takes the default with a pino warning that carries only config_key.
// TODO(规划/11 §2.3): drop the direct config_items read used when no port is injected — blocked on
// the B1-13e rule tests, which build the service without a config port and still expect
// withdraw.payout_methods / the monthly limit to be honoured (AC-B1-13e#13, #31).
//
// createPayoutAccountService().saveBankCard — the bank-card binding / change of B1-13f (BR-WDR-02 ⑥,
// 细则「核验结果与保存分开」): called only after the three-element verification matched (or a
// matched record is reused), in the claim's transaction. The same lock and order as the Alipay
// save — withdraw.payout_methods without bank_card → 20001 fields=[payout_method]; the card number
// again normalised and checked (12–19 digits, Luhn) → 20001 fields=[card_no]; the users row lock;
// ⓪ the bank_card blocklist → 44001; 30304; ① → 30307; ② bank_card_hmac held by another member →
// 30308; the same account → 0, nothing written; ④ → 30303 — every value reread inside the lock,
// so what changed while the vendor answered is judged here. bank_name and card_bin come from the
// card BIN (the caller's lookup), never from the request body. A unique violation of
// payout_accounts_current_bank_card_key answers 30308 as for Alipay.
// A real-name correction during the vendor call (B1-27l; BR-ID-25 细则「实名更正」): the correction
// takes this same users row lock, so only a read after the lock can see it. With the record's
// attemptReservedAt, once every check has passed and just before the writes, a realname row rewritten
// after its insert (row_version > 0) whose verified_at is later than that instant means the answer
// was about the old identity: nothing is written and ATTEMPT_PREDATES_CORRECTION is returned, an
// internal result the caller turns into its own answer. A record reserved at the very instant of
// the correction is the new identity's. Callers without a record (attemptReservedAt absent) are
// not compared.
// payoutAccountChecks / lockPayoutUser are the lock-phase checks themselves (⓪ ① ② same ④, no
// write): the verification reservation (payout-bank-card.ts) runs them in its own short
// transaction before it reserves the day's quota (BR-WDR-02 细则「顺序」).
//
// Cipher AAD and blind-index context of the logon id: payout_accounts.alipay (the card number:
// payout_accounts.bank_card), the contexts risk's blocklist hashes with (blocklistHmacContexts),
// so blocklist entries and the partial unique index see the same digest. payee_name stores the
// normalised name. No plaintext, cipher text or HMAC is logged or returned.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import {
  chinaMonth,
  chinaMonthRange,
  isValidBankCardNo,
  normalizeBankCardNo,
  normalizePersonName,
} from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type FieldCrypto, type RootLogger } from '../../platform/index.ts';
import { blocklistHmacContexts, type BlocklistService } from '../../risk/index.ts';
import { normalizeAlipayLogonId } from '../domain/alipay-logon.ts';
import {
  maskAlipayLogonId,
  maskBankCardTail,
  maskPayeeName,
} from '../domain/mask-payout-account.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import { createRealnameReader } from '../infra/realname-reader.ts';

export interface PayoutAccountSubject {
  readonly appId: string;
  readonly userId: string;
}

/** Trusted identity is supplied by the caller, never taken from the HTTP body. */
export interface SaveAlipayCommand extends PayoutAccountSubject {
  readonly alipayLogonId: string;
  readonly payeeName: string;
}

export type SaveAlipayResult =
  | { readonly code: 0; readonly data: components['schemas']['PayoutAccountAlipay'] }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly string[]; readonly reason?: 'phone_invalid' };
    }
  | { readonly code: 30304 | 30307 | 30308 }
  | { readonly code: 30303; readonly data: { readonly reason: 'payout_account_change_limit' } }
  | { readonly code: 44001; readonly data: { readonly risk_msg_code: string } };

/** B1-13f: a bank card whose three-element verification matched; bank data from its BIN. */
export interface SaveBankCardCommand extends PayoutAccountSubject {
  /** As submitted; normalised and checked again here. */
  readonly cardNo: string;
  readonly payeeName: string;
  /** The opening bank of the card BIN (CardBinPort), never the request body's bank_name. */
  readonly bankName: string;
  readonly cardBin: string;
  /** reserved_at of the verification record this save rests on (file header: B1-27l). */
  readonly attemptReservedAt?: Date;
}

/** The refusals of the lock phase, shared by both methods and the verification reservation. */
export type PayoutAccountRefusal =
  | { readonly code: 30304 | 30307 | 30308 }
  | { readonly code: 30303; readonly data: { readonly reason: 'payout_account_change_limit' } }
  | { readonly code: 44001; readonly data: { readonly risk_msg_code: string } };

export type SaveBankCardResult =
  | { readonly code: 0; readonly data: components['schemas']['PayoutAccountBankCard'] }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | PayoutAccountRefusal;

/** The record predates a real-name correction (file header); internal, never a response code. */
export const ATTEMPT_PREDATES_CORRECTION = Object.freeze({
  code: 'attempt_predates_correction',
} as const);
export type AttemptPredatesCorrection = typeof ATTEMPT_PREDATES_CORRECTION;

/** Business configuration of one app, read on the caller's handle (content's reader). */
export interface PayoutAccountConfigPort {
  configValue(
    appId: string,
    key: string,
    handle: Kysely<DB>,
  ): Promise<{ readonly value: unknown } | null>;
}

export interface PayoutAccountServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly blocklist: Pick<BlocklistService, 'check'>;
  readonly config?: PayoutAccountConfigPort;
}

export interface PayoutAccountService {
  /**
   * B1-13e: use this exact caller transaction; users FOR UPDATE before mutable reads.
   * Refusals leave payout rows unchanged. No step-up or idempotency settlement here:
   * B1-13f calls save inside its existing idempotency / withStepUp transaction.
   * Cipher AAD is payout_accounts.alipay (bank read: payout_accounts.bank_card),
   * also the blind-index domain shared with risk. Never return plaintext or HMAC.
   * (The row lock is taken FOR NO KEY UPDATE; see the file header.)
   */
  save(trx: Transaction<DB>, command: SaveAlipayCommand): Promise<SaveAlipayResult>;
  /**
   * B1-13f: the bank-card save after a matched verification, in the caller's transaction; the
   * same lock and order as save (see the file header). Never verifies or reserves anything.
   */
  saveBankCard(
    trx: Transaction<DB>,
    command: SaveBankCardCommand,
  ): Promise<SaveBankCardResult | AttemptPredatesCorrection>;
}

/** GET /v1/me/payout-account data: the masked current account, or {} when nothing is bound. */
export type PayoutAccountView =
  components['schemas']['PayoutAccount'] | components['schemas']['EmptyData'];

export interface PayoutAccountReaderOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly config?: PayoutAccountConfigPort;
}

export interface PayoutAccountReader {
  read(subject: PayoutAccountSubject): Promise<PayoutAccountView>;
}

export const PAYOUT_METHODS_KEY = 'withdraw.payout_methods';
export const CHANGE_LIMIT_KEY = 'withdraw.payout_account_change_per_month';
/** BR-WDR-02 defaults (D12; ④). */
const DEFAULT_PAYOUT_METHODS: ReadonlySet<string> = new Set(['alipay', 'bank_card']);
const DEFAULT_CHANGE_LIMIT = 2;
const KNOWN_PAYOUT_METHODS: ReadonlySet<string> = new Set(['alipay', 'bank_card', 'wechat']);

const ALIPAY_CONTEXT = blocklistHmacContexts().alipay;
/** Cipher AAD and blind-index context of the card number (= risk's bank_card dimension). */
export const BANK_CARD_CONTEXT = blocklistHmacContexts().bank_card;
const CURRENT_ALIPAY_KEY = 'payout_accounts_current_alipay_key';
const CURRENT_BANK_CARD_KEY = 'payout_accounts_current_bank_card_key';
const SAVEPOINT = sql.raw('identity_payout_account_save');

export interface CurrentAccount {
  readonly id: string;
  readonly payout_method: string;
  readonly alipay_hmac: string | null;
  readonly alipay_logon_id_cipher: Buffer | null;
  readonly bank_card_hmac: string | null;
  readonly bank_card_no_cipher: Buffer | null;
  readonly bank_name: string | null;
  readonly payee_name: string;
  readonly row_version: number;
}

type Config = ReadonlyMap<string, unknown>;

/** The values of `keys` (absent keys are missing from the map), on the caller's handle. */
export async function readConfig(
  handle: Kysely<DB>,
  appId: string,
  keys: readonly string[],
  port: PayoutAccountConfigPort | undefined,
): Promise<Config> {
  if (port !== undefined) {
    const values = new Map<string, unknown>();
    for (const key of keys) {
      const entry = await port.configValue(appId, key, handle);
      if (entry !== null) values.set(key, entry.value);
    }
    return values;
  }
  const rows = await handle
    .withSchema('app')
    .selectFrom('config_items')
    .select(['key', 'value'])
    .where('app_id', '=', appId)
    .where('key', 'in', keys)
    .execute();
  return new Map<string, unknown>(rows.map((row) => [row.key, row.value]));
}

/** withdraw.payout_methods: a non-empty array of distinct known methods, else the default. */
export function payoutMethods(config: Config, logger: RootLogger): ReadonlySet<string> {
  const value = config.get(PAYOUT_METHODS_KEY);
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && KNOWN_PAYOUT_METHODS.has(entry)) &&
    new Set(value).size === value.length
  ) {
    return new Set(value as string[]);
  }
  logger.warn({ config_key: PAYOUT_METHODS_KEY }, 'payout_account_config_default');
  return DEFAULT_PAYOUT_METHODS;
}

/** withdraw.payout_account_change_per_month: a whole number ≥ 0, else the default. */
export function changeLimit(config: Config, logger: RootLogger): number {
  const value = config.get(CHANGE_LIMIT_KEY);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  logger.warn({ config_key: CHANGE_LIMIT_KEY }, 'payout_account_config_default');
  return DEFAULT_CHANGE_LIMIT;
}

async function currentAccount(
  handle: Kysely<DB>,
  subject: PayoutAccountSubject,
): Promise<CurrentAccount | undefined> {
  return handle
    .withSchema('app')
    .selectFrom('payout_accounts')
    .select([
      'id',
      'payout_method',
      'alipay_hmac',
      'alipay_logon_id_cipher',
      'bank_card_hmac',
      'bank_card_no_cipher',
      'bank_name',
      'payee_name',
      'row_version',
    ])
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('is_current', '=', true)
    .executeTakeFirst();
}

/** Rows of payout_account_changes of the subject in the +08:00 natural month of `now`. */
async function changesThisMonth(
  handle: Kysely<DB>,
  subject: PayoutAccountSubject,
  now: Date,
): Promise<number> {
  const month = chinaMonthRange(chinaMonth(now));
  const row = await handle
    .withSchema('app')
    .selectFrom('payout_account_changes')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('n'))
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('changed_at', '>=', sql<Date>`${month.start}::timestamptz`)
    .where('changed_at', '<', sql<Date>`${month.end}::timestamptz`)
    // B2-05j (BR-WDR-02 细则「实名更正后的失效与重绑」): rows the realname correction wrote
    // (limit_exempt_reason) do not count. Plain SQL until the schema snapshot adds the column type.
    .where(sql<boolean>`limit_exempt_reason IS NULL`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

function cipherText(cipher: Buffer | null): string {
  // payout_accounts_details_check guarantees the cipher of the row's own method.
  if (cipher === null) throw new Error('identity: payout account row without its cipher');
  return Buffer.from(cipher).toString('utf8');
}

/** The masked projection of a stored alipay row. */
function projectAlipay(
  row: CurrentAccount,
  crypto: FieldCrypto,
  changeRemaining: number,
): components['schemas']['PayoutAccountAlipay'] {
  const logon = crypto.decrypt(cipherText(row.alipay_logon_id_cipher), ALIPAY_CONTEXT);
  return {
    payout_account_id: row.id,
    payout_method: 'alipay',
    masked_account: maskAlipayLogonId(logon),
    masked_payee_name: maskPayeeName(row.payee_name),
    change_remaining_this_month: changeRemaining,
  };
}

/** The masked projection of a stored row (GET and the same-account answer). */
export function project(
  row: CurrentAccount,
  crypto: FieldCrypto,
  changeRemaining: number,
): components['schemas']['PayoutAccount'] {
  if (row.payout_method === 'alipay') return projectAlipay(row, crypto, changeRemaining);
  if (row.payout_method === 'bank_card') {
    const cardNo = crypto.decrypt(cipherText(row.bank_card_no_cipher), BANK_CARD_CONTEXT);
    if (row.bank_name === null) throw new Error('identity: bank card row without bank_name');
    return {
      payout_account_id: row.id,
      payout_method: 'bank_card',
      masked_account: maskBankCardTail(cardNo),
      bank_name: row.bank_name,
      masked_payee_name: maskPayeeName(row.payee_name),
      change_remaining_this_month: changeRemaining,
    };
  }
  throw new Error('identity: unknown payout_method on the current payout account');
}

/** The HMAC that identifies a stored account (alipay_hmac or bank_card_hmac). */
function accountHmac(row: CurrentAccount): string {
  const hmac = row.payout_method === 'alipay' ? row.alipay_hmac : row.bank_card_hmac;
  if (hmac === null) throw new Error('identity: payout account row without its HMAC');
  return hmac;
}

function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

export function createPayoutAccountReader(
  options: PayoutAccountReaderOptions,
): PayoutAccountReader {
  const { db, clock, crypto, logger, config } = options;
  return Object.freeze({
    async read(subject: PayoutAccountSubject): Promise<PayoutAccountView> {
      const current = await currentAccount(db, subject);
      if (current === undefined) return {};
      const limit = changeLimit(
        await readConfig(db, subject.appId, [CHANGE_LIMIT_KEY], config),
        logger,
      );
      const used = await changesThisMonth(db, subject, clock.now());
      return project(current, crypto, remaining(limit, used));
    },
  });
}

/** The users row lock of the payout saves and the reservation (FOR NO KEY UPDATE, file header). */
export async function lockPayoutUser(
  handle: Kysely<DB>,
  subject: PayoutAccountSubject,
): Promise<{ readonly phone_cipher: Buffer | null }> {
  const user = await handle
    .withSchema('app')
    .selectFrom('users')
    .select('phone_cipher')
    .where('app_id', '=', subject.appId)
    .where('id', '=', subject.userId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (user === undefined) throw new Error('identity: payout account save for an unknown user');
  return user;
}

/** The account a request asks for: its method, blind index and normalised payee name. */
export interface PayoutAccountTarget {
  readonly method: 'alipay' | 'bank_card';
  readonly hmac: string;
  readonly payeeName: string;
}

export interface PayoutAccountCheckDeps {
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly blocklist: Pick<BlocklistService, 'check'>;
}

export type PayoutAccountChecks<R> =
  | { readonly kind: 'refused'; readonly result: PayoutAccountRefusal }
  | { readonly kind: 'same'; readonly current: CurrentAccount; readonly remaining: number }
  | {
      readonly kind: 'open';
      readonly realname: R;
      readonly current: CurrentAccount | undefined;
      readonly used: number;
      readonly now: Date;
    };

/**
 * The lock phase of BR-WDR-02 (⓪ ① ② the same account ④), each value read fresh on `handle`, which
 * must already hold lockPayoutUser's lock. Writes nothing (a blocklist hit is recorded by risk in
 * its own short transaction). `readRealname` reads the verified real name (30304 when null).
 */
export async function payoutAccountChecks<R extends { readonly name: string }>(
  handle: Kysely<DB>,
  deps: PayoutAccountCheckDeps,
  subject: PayoutAccountSubject,
  user: { readonly phone_cipher: Buffer | null },
  target: PayoutAccountTarget,
  limit: number,
  readRealname: (handle: Kysely<DB>) => Promise<R | null>,
): Promise<PayoutAccountChecks<R>> {
  const { clock, crypto, blocklist } = deps;
  const app = handle.withSchema('app');
  // ⓪ BR-ID-31: checked after the lock, so an entry registered while waiting still hits.
  const hit = await blocklist.check({
    app_id: subject.appId,
    dimension: target.method,
    value_hmac: target.hmac,
    request_type: 'payout_account',
    user_id: subject.userId,
    // The blocked request's related phone (risk stores only its HMAC and masked form).
    related_phone:
      user.phone_cipher === null
        ? ''
        : crypto.decrypt(Buffer.from(user.phone_cipher).toString('utf8'), PHONE_CIPHER_CONTEXT),
  });
  if (hit !== null) {
    return {
      kind: 'refused',
      result: { code: 44001, data: { risk_msg_code: hit.data.risk_msg_code } },
    };
  }

  // ① the payee name against the verified real name, both normalised.
  const realname = await readRealname(app);
  if (realname === null) return { kind: 'refused', result: { code: 30304 } };
  if (normalizePersonName(realname.name) !== target.payeeName) {
    return { kind: 'refused', result: { code: 30307 } };
  }

  // ② another member's current binding of the same account in this app.
  const occupied = await app
    .selectFrom('payout_accounts')
    .select('id')
    .where('app_id', '=', subject.appId)
    .where(target.method === 'alipay' ? 'alipay_hmac' : 'bank_card_hmac', '=', target.hmac)
    .where('is_current', '=', true)
    .where('user_id', '<>', subject.userId)
    .executeTakeFirst();
  if (occupied !== undefined) return { kind: 'refused', result: { code: 30308 } };

  const now = clock.now();
  const current = await currentAccount(app, subject);
  const used = await changesThisMonth(app, subject, now);
  if (
    current !== undefined &&
    current.payout_method === target.method &&
    accountHmac(current) === target.hmac
  ) {
    // The same account: nothing written, not counted, never over the limit.
    return { kind: 'same', current, remaining: remaining(limit, used) };
  }
  // ④ only a change of an existing binding counts; a first binding does not.
  if (current !== undefined && used >= limit) {
    return {
      kind: 'refused',
      result: { code: 30303, data: { reason: 'payout_account_change_limit' } },
    };
  }
  return { kind: 'open', realname, current, used, now };
}

/** The new row's method-specific columns (the other method's are null). */
interface AccountColumns {
  readonly alipay_logon_id_cipher: Buffer | null;
  readonly alipay_hmac: string | null;
  readonly bank_card_no_cipher: Buffer | null;
  readonly bank_card_hmac: string | null;
  readonly bank_name: string | null;
  readonly card_bin: string | null;
}

/**
 * The writes of a change or first binding (inside a savepoint): the old current row is set
 * is_current=false (row_version CAS) with one payout_account_changes row, then the new current row.
 * Returns the new current row's id (payout_account_id, CT-26c), or 'occupied' when the method's
 * partial unique index saw a concurrent binding (rolled back to the savepoint, the caller's
 * transaction stays usable).
 */
async function writeAccount(
  trx: Kysely<DB>,
  subject: PayoutAccountSubject,
  target: PayoutAccountTarget,
  open: { readonly current: CurrentAccount | undefined; readonly now: Date },
  columns: AccountColumns,
): Promise<{ readonly id: string } | 'occupied'> {
  const { current, now } = open;
  const id = newUuidV7(now);
  await sql`SAVEPOINT ${SAVEPOINT}`.execute(trx);
  try {
    if (current !== undefined) {
      const retired = await trx
        .updateTable('payout_accounts')
        .set({ is_current: false, row_version: current.row_version + 1, updated_at: now })
        .where('app_id', '=', subject.appId)
        .where('id', '=', current.id)
        .where('is_current', '=', true)
        .where('row_version', '=', current.row_version)
        .executeTakeFirst();
      // Under the user lock nobody else writes this user's accounts.
      if (retired.numUpdatedRows !== 1n) {
        throw new Error('identity: current payout account changed under the user lock');
      }
      await trx
        .insertInto('payout_account_changes')
        .values({
          app_id: subject.appId,
          user_id: subject.userId,
          old_payout_method: current.payout_method,
          old_hmac: accountHmac(current),
          new_payout_method: target.method,
          new_hmac: target.hmac,
          operator: `user:${subject.userId}`,
          changed_at: now,
          created_at: now,
        })
        .execute();
    }
    await trx
      .insertInto('payout_accounts')
      .values({
        id,
        app_id: subject.appId,
        user_id: subject.userId,
        payout_method: target.method,
        ...columns,
        payee_name: target.payeeName,
        is_current: true,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
  } catch (error) {
    const constraint = target.method === 'alipay' ? CURRENT_ALIPAY_KEY : CURRENT_BANK_CARD_KEY;
    if (!isUniqueViolationOf(error, constraint)) throw error;
    // A concurrent binding of the same account won the partial unique index after ②.
    await sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
    return 'occupied';
  }
  return { id };
}

/**
 * Whether a record reserved at `reservedAt` predates a real-name correction (file header). `handle`
 * must already hold lockPayoutUser's lock: the correction commits under that same lock.
 */
async function predatesCorrection(
  handle: Kysely<DB>,
  subject: PayoutAccountSubject,
  reservedAt: Date,
): Promise<boolean> {
  const row = await handle
    .withSchema('app')
    .selectFrom('realname')
    .select(['verified_at', 'row_version'])
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('status', '=', 'verified')
    .executeTakeFirst();
  // The lock phase has just read this verified row, and its writers need the same lock.
  if (row === undefined || !(row.verified_at instanceof Date)) {
    throw new Error('identity: verified realname record missing under the user lock');
  }
  return row.row_version > 0 && reservedAt.getTime() < row.verified_at.getTime();
}

/** The masked projection of a stored bank-card row. */
function projectBankCard(
  row: CurrentAccount,
  crypto: FieldCrypto,
  changeRemaining: number,
): components['schemas']['PayoutAccountBankCard'] {
  const projected = project(row, crypto, changeRemaining);
  if (projected.payout_method !== 'bank_card') {
    throw new Error('identity: expected a bank card payout account');
  }
  return projected;
}

export function createPayoutAccountService(
  options: PayoutAccountServiceOptions,
): PayoutAccountService {
  const { clock, crypto, logger, blocklist, config: configPort } = options;
  const realname = createRealnameReader(crypto);
  const deps: PayoutAccountCheckDeps = { clock, crypto, blocklist };
  return Object.freeze({
    async save(
      transaction: Transaction<DB>,
      command: SaveAlipayCommand,
    ): Promise<SaveAlipayResult> {
      const trx = transaction.withSchema('app');
      const subject: PayoutAccountSubject = { appId: command.appId, userId: command.userId };

      // Local checks before the lock: they read no user state and write nothing.
      const config = await readConfig(
        trx,
        subject.appId,
        [PAYOUT_METHODS_KEY, CHANGE_LIMIT_KEY],
        configPort,
      );
      const methods = payoutMethods(config, logger);
      const limit = changeLimit(config, logger);
      if (!methods.has('alipay')) return { code: 20001, data: { fields: ['payout_method'] } };
      const normalized = normalizeAlipayLogonId(command.alipayLogonId);
      if (normalized.code !== 0) return { code: 20001, data: normalized.data };
      const logon = normalized.logon;
      const target: PayoutAccountTarget = {
        method: 'alipay',
        hmac: crypto.blindIndex(logon, ALIPAY_CONTEXT),
        payeeName: normalizePersonName(command.payeeName),
      };

      // The user lock (see the file header for FOR NO KEY UPDATE); everything after is reread.
      const user = await lockPayoutUser(trx, subject);
      const checks = await payoutAccountChecks(trx, deps, subject, user, target, limit, (h) =>
        realname.verified(h, { app_id: subject.appId, user_id: subject.userId }),
      );
      if (checks.kind === 'refused') return checks.result;
      if (checks.kind === 'same') {
        return { code: 0, data: projectAlipay(checks.current, crypto, checks.remaining) };
      }

      const written = await writeAccount(trx, subject, target, checks, {
        alipay_logon_id_cipher: Buffer.from(crypto.encrypt(logon, ALIPAY_CONTEXT), 'utf8'),
        alipay_hmac: target.hmac,
        bank_card_no_cipher: null,
        bank_card_hmac: null,
        bank_name: null,
        card_bin: null,
      });
      if (written === 'occupied') return { code: 30308 };
      return {
        code: 0,
        data: {
          payout_account_id: written.id,
          payout_method: 'alipay',
          masked_account: maskAlipayLogonId(logon),
          masked_payee_name: maskPayeeName(target.payeeName),
          change_remaining_this_month: remaining(
            limit,
            checks.used + (checks.current === undefined ? 0 : 1),
          ),
        },
      };
    },

    async saveBankCard(
      transaction: Transaction<DB>,
      command: SaveBankCardCommand,
    ): Promise<SaveBankCardResult | AttemptPredatesCorrection> {
      const trx = transaction.withSchema('app');
      const subject: PayoutAccountSubject = { appId: command.appId, userId: command.userId };

      // Local checks before the lock: they read no user state and write nothing.
      const config = await readConfig(
        trx,
        subject.appId,
        [PAYOUT_METHODS_KEY, CHANGE_LIMIT_KEY],
        configPort,
      );
      const methods = payoutMethods(config, logger);
      const limit = changeLimit(config, logger);
      if (!methods.has('bank_card')) return { code: 20001, data: { fields: ['payout_method'] } };
      const cardNo = normalizeBankCardNo(command.cardNo);
      if (!isValidBankCardNo(cardNo)) return { code: 20001, data: { fields: ['card_no'] } };
      const target: PayoutAccountTarget = {
        method: 'bank_card',
        hmac: crypto.blindIndex(cardNo, BANK_CARD_CONTEXT),
        payeeName: normalizePersonName(command.payeeName),
      };

      const user = await lockPayoutUser(trx, subject);
      const checks = await payoutAccountChecks(trx, deps, subject, user, target, limit, (h) =>
        realname.verified(h, { app_id: subject.appId, user_id: subject.userId }),
      );
      if (checks.kind === 'refused') return checks.result;
      if (checks.kind === 'same') {
        return { code: 0, data: projectBankCard(checks.current, crypto, checks.remaining) };
      }
      if (
        command.attemptReservedAt !== undefined &&
        (await predatesCorrection(trx, subject, command.attemptReservedAt))
      ) {
        return ATTEMPT_PREDATES_CORRECTION;
      }

      const written = await writeAccount(trx, subject, target, checks, {
        alipay_logon_id_cipher: null,
        alipay_hmac: null,
        bank_card_no_cipher: Buffer.from(crypto.encrypt(cardNo, BANK_CARD_CONTEXT), 'utf8'),
        bank_card_hmac: target.hmac,
        bank_name: command.bankName,
        card_bin: command.cardBin,
      });
      if (written === 'occupied') return { code: 30308 };
      return {
        code: 0,
        data: {
          payout_account_id: written.id,
          payout_method: 'bank_card',
          masked_account: maskBankCardTail(cardNo),
          bank_name: command.bankName,
          masked_payee_name: maskPayeeName(target.payeeName),
          change_remaining_this_month: remaining(
            limit,
            checks.used + (checks.current === undefined ? 0 : 1),
          ),
        },
      };
    },
  });
}
