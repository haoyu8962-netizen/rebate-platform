// The bank-card branch of PUT /v1/me/payout-account (规划/08 BR-WDR-02 ⑥ ⑦ and 细则「核验次数上限」,
// BR-WDR-01, BR-ID-31; task B1-13f §9.2 #2, #3, #5–#9, §9.3). Runs as the handler of the claim
// transaction `trx` of idempotency.executeInTransaction (inside withStepUp, so stage ⑫ and ⑨ were
// judged in the claim's post-miss checks before anything here, and the claim itself answered a
// second request of the same key with 40901 or its stored result — 08's「① 重查幂等键」).
//
// (a) Local checks, no lock, no write: withdraw.payout_methods without bank_card → 20001
//     fields=[payout_method]; the card number without spaces / hyphens must be 12–19 digits with
//     Luhn → 20001 fields=[card_no]; no card BIN port or no verifier assembled (staging / prod
//     today) → 50301; the BIN must be a recognised debit card → 20001 fields=[card_no] (a BIN
//     lookup that fails → 50301). Nothing is reserved for any of them.
// (b) The reservation: its own short transaction (db.transaction(), never trx, which must not lock
//     the users row before the vendor call), users row FOR NO KEY UPDATE (the save's lock), then
//     in order: ⓪ bank_card blocklist 44001, 30304, ① 30307, ② 30308, the same account as the
//     current one (200 with it, nothing written), ④ 30303 change_limit (payoutAccountChecks); the
//     record bound to this Idempotency-Key (「同一个键再次提交」): first its request fingerprint must
//     be this request's — the key resubmitted with another card (or under another real-name
//     record) is another request: 20901, nothing taken over, queried, reserved or saved (an
//     earlier 50401 left the key without a stored result, so the claim could not compare bodies);
//     then reserved → 40901, a reserved row whose lease ran out taken over to unknown first;
//     unknown → 40901; matched → save, whatever its age; mismatched → 30307;
//     expired_unresolved → 50401; never a new record for the key;
//     else the latest record of the request fingerprint (`${realname id}:${bank_card_hmac}`,
//     「同一账号再次提交」: reserved within its lease → 40901; reserved past it → taken over, then
//     rechecked; unknown → rechecked; matched within the reuse period → save without a vendor call
//     or quota); else a new verification: today's (+08:00) records that are not released against
//     withdraw.payout_account_verify_per_day → 30303 payout_account_verify_limit, or a reserved
//     record (new vendor_request_id) — then commit, which releases the lock. A partial unique
//     index violation of the insert → 40901.
// (c) The vendor call (verify, or the recheck query by the original vendor_request_id) runs after
//     that commit, outside every lock, bounded by VENDOR_CALL_TIMEOUT_MS; no answer = unknown.
// (d) Results (「落结果」, 9.2 #3 (d)): match → saveBankCard in trx (the save's own lock and
//     rereads); a 0 / 3xxxx answer (stored with the key) moves the record to matched in trx, so
//     record, account and the key's result commit together; any other answer (trx rolls back)
//     moves it to matched in an independent transaction. Mismatch → in trx: users lock, record to
//     mismatched, 30307 (stored). No answer to verify → record to unknown in an independent
//     transaction, 50401 (not stored). Recheck: match / mismatch as above; not_found → the record
//     becomes expired_unresolved and the request starts a new verification (b); still unknown →
//     40901, or past the recheck deadline expired_unresolved (alarm line) and a new verification.
//     Every record write is a CAS (payout-account-verify-attempts.ts). Quota is never refunded.
//
// Known gap (9.2 #4, 9.3): the claim transaction holds the key for the whole call, so an abandon
// during the vendor call gets 40901 instead of BR-ID-10's "abandon wins, the request rolls back
// with 20903"; recorded for the planning sync, not worked around here.
//
// Real-name corrections (B1-27a; BR-ID-25 细则「实名更正」, task §9 ④): a correction overwrites the
// realname row in place (same id), so the fingerprint alone cannot tell a record verified against
// the old identity from one of the new. Every record path — the key's own record (matched saves
// whatever its age), the fingerprint's latest record (reserved / unknown rechecked, matched
// reused) — therefore only accepts records reserved at or after the identity's lower bound
// (recordsFrom / recordedSince): the row's verified_at, which a correction sets to its instant,
// once the row was rewritten after its insert (row_version > 0: a correction, or a verification
// after a failed attempt, before which no record of the row can exist); a row verified on insert
// and never rewritten has had one identity only, so every record of its id is that identity's.
// The key's own older record is another request (20901); an older latest record is as if there
// were none (a new paid verification of the new identity).
//
// Re-verification (B1-02zq; BR-WDR-01 细则「位置与返回码」): createPayoutAccountChange judges the gate
// of reverify-gate.ts first, for both methods: the claim's post-miss checks judged the step-up token
// before the handler, and nothing is read, reserved or written after a 10010.
//
// Invariant: a record's answer only ever binds the card it verified. saveMatched and mismatched
// refuse (throw) a record whose fingerprint is not this request's; every path that reaches them
// has compared it already (the key's record above; the fingerprint's records by construction).
//
// Nothing logs or returns the card number, the HMAC, the fingerprint, the name or the ID number;
// a vendor error is never logged or rethrown.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import {
  accountingDate,
  isValidBankCardNo,
  normalizeBankCardNo,
  normalizePersonName,
} from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type FieldCrypto, type RootLogger } from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';
import { REALNAME_CONTEXT } from '../infra/realname-reader.ts';
import type { BankCardVerifierPort, CardBinPort } from '../ports/bank-card-verifier.ts';
import type { ReverifyGate, ReverifyRefusal } from './reverify-gate.ts';
import {
  BANK_CARD_CONTEXT,
  CHANGE_LIMIT_KEY,
  PAYOUT_METHODS_KEY,
  changeLimit,
  createPayoutAccountService,
  lockPayoutUser,
  payoutAccountChecks,
  payoutMethods,
  project,
  readConfig,
  type PayoutAccountConfigPort,
  type PayoutAccountRefusal,
  type PayoutAccountService,
  type PayoutAccountSubject,
  type SaveAlipayCommand,
  type SaveAlipayResult,
  type SaveBankCardResult,
} from './payout-account.ts';
import {
  RESERVATION_CONFLICTS,
  VENDOR_CALL_TIMEOUT_MS,
  VERIFY_CONFIG_KEYS,
  attemptByKey,
  callVendor,
  insertReservation,
  latestAttempt,
  leaseExpired,
  logExpired,
  occupiedToday,
  queryAttempt,
  recheckDue,
  recordedSince,
  reusable,
  settleAttempt,
  transitionAttempt,
  verifySettings,
  type VerifyAttempt,
  type VerifySettings,
} from './payout-account-verify-attempts.ts';

/** Trusted identity from the token; card number and payee name as submitted. */
export interface BankCardSubmitCommand extends PayoutAccountSubject {
  readonly cardNo: string;
  readonly payeeName: string;
  /** The request's Idempotency-Key (validated by the claim), bound to the record it reserves. */
  readonly idempotencyKey: string;
}

export type BankCardSubmitResult =
  | SaveBankCardResult
  | { readonly code: 30303; readonly data: { readonly reason: 'payout_account_verify_limit' } }
  | { readonly code: 20901 | 40901 | 50301 | 50401 };

export interface BankCardBindingOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly blocklist: Pick<BlocklistService, 'check'>;
  readonly accounts: Pick<PayoutAccountService, 'saveBankCard'>;
  readonly cardBin: CardBinPort | null;
  readonly verifier: BankCardVerifierPort | null;
  readonly config?: PayoutAccountConfigPort;
  /** Single vendor call deadline; VENDOR_CALL_TIMEOUT_MS unless a unit test shortens it. */
  readonly vendorTimeoutMs?: number;
}

export interface BankCardBinding {
  submit(trx: Transaction<DB>, command: BankCardSubmitCommand): Promise<BankCardSubmitResult>;
}

/** The verified real name the three elements use, with the instant it was (last) verified. */
interface VerifiedIdentity {
  readonly id: string;
  readonly name: string;
  readonly id_no: string;
  /** The earliest reserved_at of a record of this identity (null: any, see the file header). */
  readonly records_from: Date | null;
}

/**
 * The verified record's id (part of the fingerprint), decrypted name and ID number (only to the
 * vendor port, in memory) and the records' lower bound (file header); null unless verified.
 */
async function verifiedIdentity(
  handle: Kysely<DB>,
  crypto: FieldCrypto,
  subject: { readonly app_id: string; readonly user_id: string },
): Promise<VerifiedIdentity | null> {
  const row = await handle
    .withSchema('app')
    .selectFrom('realname')
    .select(['id', 'name_cipher', 'id_no_cipher', 'verified_at', 'row_version'])
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('status', '=', 'verified')
    .executeTakeFirst();
  if (row === undefined) return null;
  // realname_verified_check guarantees these on a verified row.
  if (row.name_cipher === null || row.id_no_cipher === null || !(row.verified_at instanceof Date)) {
    throw new Error('identity: incomplete verified realname record');
  }
  return {
    id: row.id,
    name: crypto.decrypt(Buffer.from(row.name_cipher).toString('utf8'), REALNAME_CONTEXT.name),
    id_no: crypto.decrypt(Buffer.from(row.id_no_cipher).toString('utf8'), REALNAME_CONTEXT.idNo),
    records_from: row.row_version > 0 ? row.verified_at : null,
  };
}

/** What the reservation decided (b); `fingerprint` is this request's (realname id + card). */
type Step =
  | { readonly kind: 'answer'; readonly result: BankCardSubmitResult }
  | { readonly kind: 'save'; readonly attempt: VerifyAttempt; readonly fingerprint: string }
  | { readonly kind: 'recheck'; readonly attempt: VerifyAttempt; readonly fingerprint: string }
  | {
      readonly kind: 'verify';
      readonly attempt: VerifyAttempt;
      readonly fingerprint: string;
      readonly name: string;
      readonly idNo: string;
    };

/** An unknown record to end before the next reservation pass (not_found, or past its deadline). */
interface Expiry {
  readonly attempt: VerifyAttempt;
  readonly alarm: boolean;
}

/** A reservation pass is repeated at most this often (not_found / deadline → new verification). */
const MAX_PASSES = 3;
const RESERVE_SAVEPOINT = sql.raw('identity_payout_verify_reserve');

const BUSY = { code: 40901 } as const;
/** The key's record verified another card or real name: the platform's 20901 (key, other body). */
const KEY_REUSED = { code: 20901 } as const;
const UNAVAILABLE = { code: 50301 } as const;
const OUTCOME_UNKNOWN = { code: 50401 } as const;
const MISMATCH = { code: 30307 } as const;

function refusal(result: PayoutAccountRefusal): Step {
  return { kind: 'answer', result };
}

function stored(code: number): boolean {
  return code === 0 || (code >= 30000 && code <= 39999);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    typeof error.constraint === 'string' &&
    RESERVATION_CONFLICTS.has(error.constraint)
  );
}

export function createBankCardBinding(options: BankCardBindingOptions): BankCardBinding {
  const { db, clock, crypto, logger, blocklist, accounts, cardBin, verifier } = options;
  const timeoutMs = options.vendorTimeoutMs ?? VENDOR_CALL_TIMEOUT_MS;
  const deps = { clock, crypto, blocklist };

  interface Request {
    readonly subject: PayoutAccountSubject;
    readonly command: BankCardSubmitCommand;
    readonly cardNo: string;
    readonly hmac: string;
    readonly payeeName: string;
    readonly limit: number;
    readonly settings: VerifySettings;
    readonly bank: { readonly bank_name: string; readonly bin: string };
  }

  /** (b): one pass of the reservation critical section in its own short transaction. */
  async function reserve(request: Request, expiry: Expiry | undefined): Promise<Step> {
    const { subject, command, settings } = request;
    const owner = { appId: subject.appId, userId: subject.userId };
    return db.transaction().execute(async (tx) => {
      const handle = tx.withSchema('app');
      const user = await lockPayoutUser(handle, subject);
      const now = clock.now();
      if (expiry !== undefined) {
        // Conditional: a recheck that landed meanwhile (background or another request) wins.
        const ended = await transitionAttempt(handle, expiry.attempt, 'expired_unresolved', now);
        if (ended !== undefined && expiry.alarm) logExpired(logger, ended);
      }

      const checks = await payoutAccountChecks(
        handle,
        deps,
        subject,
        user,
        { method: 'bank_card', hmac: request.hmac, payeeName: request.payeeName },
        request.limit,
        (h) => verifiedIdentity(h, crypto, { app_id: owner.appId, user_id: owner.userId }),
      );
      if (checks.kind === 'refused') return refusal(checks.result);
      if (checks.kind === 'same') {
        const data = project(checks.current, crypto, checks.remaining);
        if (data.payout_method !== 'bank_card') throw new Error('identity: not a bank card');
        return { kind: 'answer', result: { code: 0, data } };
      }

      // 「同一个键再次提交」: the key's own record, whatever its status; never a second one. It is
      // reused only for the very card and real-name record it verified: the key sent again with
      // another card is another request (20901), whatever the record's status.
      const fingerprint = `${checks.realname.id}:${request.hmac}`;
      // Only records of the current identity (see the file header: real-name corrections).
      const since = checks.realname.records_from;
      const own = await attemptByKey(handle, owner, command.idempotencyKey);
      if (own !== undefined) {
        if (own.request_fingerprint !== fingerprint || !recordedSince(own, since)) {
          return { kind: 'answer', result: KEY_REUSED };
        }
        switch (own.status) {
          case 'reserved':
            if (leaseExpired(own, now, settings.inflightSeconds)) {
              await transitionAttempt(handle, own, 'unknown', now);
            }
            return { kind: 'answer', result: BUSY };
          case 'unknown':
            return { kind: 'answer', result: BUSY };
          case 'matched':
            return { kind: 'save', attempt: own, fingerprint };
          case 'mismatched':
            return { kind: 'answer', result: MISMATCH };
          default:
            // expired_unresolved (released is never written): the key stays undecided.
            return { kind: 'answer', result: OUTCOME_UNKNOWN };
        }
      }

      // 「同一账号再次提交」: the fingerprint's latest record (so of this very card).
      const found = await latestAttempt(handle, owner, fingerprint);
      const latest = found !== undefined && recordedSince(found, since) ? found : undefined;
      if (latest?.status === 'reserved') {
        if (!leaseExpired(latest, now, settings.inflightSeconds)) {
          return { kind: 'answer', result: BUSY };
        }
        const taken = await transitionAttempt(handle, latest, 'unknown', now);
        return taken === undefined
          ? { kind: 'answer', result: BUSY }
          : { kind: 'recheck', attempt: taken, fingerprint };
      }
      if (latest?.status === 'unknown') return { kind: 'recheck', attempt: latest, fingerprint };
      if (latest !== undefined && reusable(latest, now, settings.reuseHours)) {
        return { kind: 'save', attempt: latest, fingerprint };
      }

      // A new paid verification: reserve one of today's quota first.
      const verifyDate = accountingDate(now);
      if ((await occupiedToday(handle, owner, verifyDate)) >= settings.perDay) {
        return {
          kind: 'answer',
          result: { code: 30303, data: { reason: 'payout_account_verify_limit' } },
        };
      }
      await sql`SAVEPOINT ${RESERVE_SAVEPOINT}`.execute(handle);
      try {
        const attempt = await insertReservation(handle, {
          ...owner,
          id: newUuidV7(now),
          verifyDate,
          vendorRequestId: newUuidV7(now),
          fingerprint,
          idempotencyKey: command.idempotencyKey,
          now,
        });
        await sql`RELEASE SAVEPOINT ${RESERVE_SAVEPOINT}`.execute(handle);
        return {
          kind: 'verify',
          attempt,
          fingerprint,
          name: checks.realname.name,
          idNo: checks.realname.id_no,
        };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A reservation the users lock could not see (defence in depth): in flight.
        await sql`ROLLBACK TO SAVEPOINT ${RESERVE_SAVEPOINT}`.execute(handle);
        await sql`RELEASE SAVEPOINT ${RESERVE_SAVEPOINT}`.execute(handle);
        return { kind: 'answer', result: BUSY };
      }
    });
  }

  /** A record write in its own short transaction (autocommit); a failure leaves it to B1-13g. */
  async function settleAlone(attempt: VerifyAttempt, to: 'matched' | 'unknown'): Promise<void> {
    try {
      await settleAttempt(db, attempt, to, clock.now());
    } catch {
      logger.warn(
        { user_id: attempt.user_id, vendor_request_id: attempt.vendor_request_id, status: to },
        'payout_account_verify_settle_failed',
      );
    }
  }

  /** The invariant of the file header: never apply a record to a card it did not verify. */
  function assertOwnCard(attempt: VerifyAttempt, fingerprint: string): void {
    if (attempt.request_fingerprint !== fingerprint) {
      throw new Error('identity: verification record of another card or real name');
    }
  }

  /** (d) match: save in trx; the record follows the key's result (or alone when not stored). */
  async function saveMatched(
    trx: Transaction<DB>,
    request: Request,
    attempt: VerifyAttempt,
    fingerprint: string,
  ): Promise<BankCardSubmitResult> {
    assertOwnCard(attempt, fingerprint);
    const settle = attempt.status !== 'matched';
    let result: SaveBankCardResult;
    try {
      result = await accounts.saveBankCard(trx, {
        appId: request.subject.appId,
        userId: request.subject.userId,
        cardNo: request.cardNo,
        payeeName: request.command.payeeName,
        bankName: request.bank.bank_name,
        cardBin: request.bank.bin,
      });
    } catch (error) {
      // trx rolls back: the vendor's answer is still recorded.
      if (settle) await settleAlone(attempt, 'matched');
      throw error;
    }
    if (!settle) return result;
    if (stored(result.code)) {
      // The record leaves reserved / unknown only with the account and the key's result.
      if (await settleAttempt(trx, attempt, 'matched', clock.now())) return result;
      // Another writer ended the record otherwise: no binding on it (trx rolls back).
      return BUSY;
    }
    await settleAlone(attempt, 'matched');
    return result;
  }

  /** (d) mismatch: users lock, record to mismatched, 30307 stored with the key. */
  async function mismatched(
    trx: Transaction<DB>,
    request: Request,
    attempt: VerifyAttempt,
    fingerprint: string,
  ): Promise<BankCardSubmitResult> {
    assertOwnCard(attempt, fingerprint);
    const handle = trx.withSchema('app');
    await lockPayoutUser(handle, request.subject);
    return (await settleAttempt(handle, attempt, 'mismatched', clock.now())) ? MISMATCH : BUSY;
  }

  async function verifyOutcome(
    port: BankCardVerifierPort,
    attempt: VerifyAttempt,
    input: { readonly name: string; readonly idNo: string; readonly cardNo: string },
  ): Promise<'match' | 'mismatch' | 'unknown'> {
    const result = await callVendor(
      () =>
        port.verify({
          vendor_request_id: attempt.vendor_request_id,
          name: input.name,
          id_no: input.idNo,
          card_no: input.cardNo,
        }),
      timeoutMs,
    );
    if ('failure' in result) {
      logger.warn(
        {
          user_id: attempt.user_id,
          vendor_request_id: attempt.vendor_request_id,
          failure: result.failure,
        },
        'payout_account_verify_failed',
      );
      return 'unknown';
    }
    const value: unknown = result.value;
    if (value === 'match' || value === 'mismatch') return value;
    logger.warn(
      { user_id: attempt.user_id, vendor_request_id: attempt.vendor_request_id },
      'payout_account_verify_unexpected',
    );
    return 'unknown';
  }

  return Object.freeze({
    async submit(
      transaction: Transaction<DB>,
      command: BankCardSubmitCommand,
    ): Promise<BankCardSubmitResult> {
      const trx = transaction.withSchema('app');
      const subject: PayoutAccountSubject = { appId: command.appId, userId: command.userId };

      // (a) Local checks: no lock, no write, no quota.
      const config = await readConfig(
        trx,
        subject.appId,
        [PAYOUT_METHODS_KEY, CHANGE_LIMIT_KEY, ...VERIFY_CONFIG_KEYS],
        options.config,
      );
      const methods = payoutMethods(config, logger);
      const limit = changeLimit(config, logger);
      const settings = verifySettings(config, logger);
      if (!methods.has('bank_card')) return { code: 20001, data: { fields: ['payout_method'] } };
      const cardNo = normalizeBankCardNo(command.cardNo);
      if (!isValidBankCardNo(cardNo)) return { code: 20001, data: { fields: ['card_no'] } };
      if (cardBin === null || verifier === null) return UNAVAILABLE;
      let bin: Awaited<ReturnType<CardBinPort['lookup']>>;
      try {
        bin = await cardBin.lookup(cardNo);
      } catch {
        logger.warn({ user_id: subject.userId }, 'payout_account_card_bin_failed');
        return UNAVAILABLE;
      }
      if (bin === null || bin.card_type !== 'debit') {
        return { code: 20001, data: { fields: ['card_no'] } };
      }
      const request: Request = {
        subject,
        command,
        cardNo,
        hmac: crypto.blindIndex(cardNo, BANK_CARD_CONTEXT),
        payeeName: normalizePersonName(command.payeeName),
        limit,
        settings,
        bank: { bank_name: bin.bank_name, bin: bin.bin },
      };

      let expiry: Expiry | undefined;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const step = await reserve(request, expiry);
        expiry = undefined;
        if (step.kind === 'answer') return step.result;
        if (step.kind === 'save') {
          return saveMatched(transaction, request, step.attempt, step.fingerprint);
        }

        if (step.kind === 'verify') {
          // (c) after the reservation committed; outside every lock.
          const outcome = await verifyOutcome(verifier, step.attempt, {
            name: step.name,
            idNo: step.idNo,
            cardNo,
          });
          if (outcome === 'match') {
            return saveMatched(transaction, request, step.attempt, step.fingerprint);
          }
          if (outcome === 'mismatch') {
            return mismatched(transaction, request, step.attempt, step.fingerprint);
          }
          await settleAlone(step.attempt, 'unknown');
          return OUTCOME_UNKNOWN;
        }

        // step.kind === 'recheck': by the original vendor_request_id, never a new verify.
        const outcome = await queryAttempt(verifier, step.attempt, logger, timeoutMs);
        if (outcome === 'match') {
          return saveMatched(transaction, request, step.attempt, step.fingerprint);
        }
        if (outcome === 'mismatch') {
          return mismatched(transaction, request, step.attempt, step.fingerprint);
        }
        if (outcome === 'not_found') {
          expiry = { attempt: step.attempt, alarm: false };
        } else if (recheckDue(step.attempt, clock.now(), settings.recheckMinutes)) {
          expiry = { attempt: step.attempt, alarm: true };
        } else {
          return BUSY;
        }
      }
      return BUSY;
    },
  });
}

/** PUT /v1/me/payout-account's two bodies, as the controller calls them inside the claim. */
export interface PayoutAccountChange {
  /** B1-13e's Alipay save, unchanged (9.2 #1), behind the re-verification gate. */
  saveAlipay(
    trx: Transaction<DB>,
    command: SaveAlipayCommand & PayoutAccountDevice,
  ): Promise<SaveAlipayResult | ReverifyRefusal>;
  submitBankCard(
    trx: Transaction<DB>,
    command: BankCardSubmitCommand & PayoutAccountDevice,
  ): Promise<BankCardSubmitResult | ReverifyRefusal>;
}

/** The token's device: the re-verification gate is judged per device. */
export interface PayoutAccountDevice {
  readonly deviceId: string;
}

export function createPayoutAccountChange(
  options: Omit<BankCardBindingOptions, 'accounts'> & { readonly reverify: ReverifyGate },
): PayoutAccountChange {
  const { reverify } = options;
  const accounts = createPayoutAccountService({
    db: options.db,
    clock: options.clock,
    crypto: options.crypto,
    logger: options.logger,
    blocklist: options.blocklist,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  const binding = createBankCardBinding({ ...options, accounts });
  return Object.freeze({
    saveAlipay: async (trx: Transaction<DB>, command: SaveAlipayCommand & PayoutAccountDevice) =>
      (await reverify.check(trx, command)) ?? accounts.save(trx, command),
    submitBankCard: async (
      trx: Transaction<DB>,
      command: BankCardSubmitCommand & PayoutAccountDevice,
    ) => (await reverify.check(trx, command)) ?? binding.submit(trx, command),
  });
}
