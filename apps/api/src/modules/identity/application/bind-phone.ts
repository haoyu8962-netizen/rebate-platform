// POST /v1/me/phone, first binding (规划/04 §6.1; 08 BR-ID-06; task B1-20a, orchestrator ruling §9.3).
// The controller supplies the idempotency transaction. AccountAssetsPort is also shared with
// invite backfill; app.module assembles its read-only dependencies.
//
// Order of a first binding (the account has no phone_hmac): normalize_phone → 20001 phone_invalid
// (no code consumed) → SmsCodeService.verifyAndConsume(purpose=bind) → 20002 / 20003 → the phone
// blocklist → 44001 (code consumed) → the number belongs to another account of the app
// (status <> 'deleted', a deleting account included) → 30411 → otherwise phone_cipher and
// phone_hmac (normalised number) are written by a conditional update (phone_hmac IS NULL), inside
// the idempotency transaction. An account that already has a phone (a change) answers 10003 in
// stage ⑫ (no valid phone_change step_up_token), before this runs; see the change below.
//
// A change (B1-20b, D10-2189 / D10-2192; the account has a phone_hmac). Stage ⑫ (withStepUp in the
// controller) has already judged and reserved the phone_change step_up_token; it is consumed only
// for code 0. Under the users row lock taken first (Codex money r1 S0 #1 / #2): the request's
// session still live (else 10002) → the token ⑫ passed in this request (command.step_up) is a
// phone_change token bound to the locked current phone_hmac (phone-change-binding.ts; none, another
// action or another number → 10003); both judged on the locked row, before any code is consumed or
// anything written → the switch account.phone_change_enabled
// (phone-change-switch.ts; only the boolean false turns it off) → 30414 → normalize_phone → 20001
// phone_invalid → the normalised number equals the current one → 20001 data.fields=[phone] (no code
// consumed) → verifyAndConsume(purpose=bind) of the new number → 20002 / 20003 → the blocklist →
// 44001 (as a first binding) → another account of the app holds the number (status <> 'deleted', a
// deleting account included) → 30411 without data, never a merge offer → then in the idempotency
// transaction: users.phone_cipher / phone_hmac overwritten (a concurrent winner of the partial
// unique index → 23505 → 30411, nothing else written), the old phone_hmac into deleted_identities
// (reason phone_changed, device_hash null, 180 days as admin-profile-edit), every other session of
// the user revoked (reason phone_changed, the push token unbinding assembled with it; the request's
// own sid kept, not reissued) and one system audit row (system:self_service, user_phone_change,
// target users:<uid>, before / after only phone_masked 3 + 4). Any non-zero answer writes none of
// it. The numbers are never logged.
//
// 30411 carries data.reason=mergeable and data.merge_ticket only when all of these hold:
// the account registered with wechat / apple / huawei and has no phone; AccountAssetsPort reports
// no order, no claim and no ledger entry; parent_id is null and no user has it as parent; the
// target account is status 'normal', is not banned (readRiskState fresh; appealing after banned
// counts as banned), is not in the deletion process (identity's deletion stage: cooling or
// processing refuses; B1-20e) and has no user_oauth row of a provider the account itself has.
// B1-20c (D10-1099 Q-3 / Q-4): nor any admin_adjustments row or blocked(admin_disable) binding of
// the account. The whole judgement lives in merge-conditions.ts, shared with POST /v1/auth/merge.
// The ticket (at least 128 random bits) is stored in Redis namespace `merge_ticket`, key the SHA-256 hex of
// the ticket, value JSON {app_id, uid, phone_hmac}, 300 seconds; Redis unavailable → 50001.
// Nothing logs a phone number, a code or a ticket.
//
// AccountAssetsPort is assembled by app.module and handed to IdentityModule.forRoot as the option
// `accountAssets` (a factory provider, like `blocklist`): countOrders is a read-only count of
// app.orders rows of the user (any status); hasClaims reads app.claims (any claim of the user as
// the applicant, any status) and hasLedgerEntries the ledger's hasUserBalanceEntries (B1-20e), all on
// the caller's transaction, read only. B1-02z's invite backfill shares it.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import {
  RedisUnavailableError,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
} from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';
import { maskPhone } from '../domain/mask-phone.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import { PHONE_BLIND_INDEX_CONTEXT, PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import {
  mergeConditionsHold,
  type AccountAssetsPort,
  type AccountRiskPort,
  type MergeBarrierPort,
} from './merge-conditions.ts';
import { instantPlus } from './config-seconds.ts';
import { phoneChangeBindingMatches } from './phone-change-binding.ts';
import { PHONE_CHANGE_DISABLED, type PhoneChangeSwitch } from './phone-change-switch.ts';
import type { JudgedStepUp } from './step-up-verify.ts';
import type { SmsCodeService } from './sms-codes.ts';

/** The verified request: uid, app and device come from the token and the signed device only. */
export interface BindPhoneCommand {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id: string;
  /** The access token's session: a change keeps it and revokes the user's other sessions. */
  readonly sid?: string;
  /**
   * What stage ⑫ passed in this request (withStepUp's StepUpContext.judged(); null or absent: no
   * token was judged). A change requires a phone_change token bound to the number it replaces,
   * judged under the users row lock (B1-20b, Codex money r1 S0 #1 / #2).
   */
  readonly step_up?: JudgedStepUp | null;
  readonly body: { readonly phone: string; readonly code: string };
}

export type BindPhoneResult =
  | { readonly code: 0 }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    }
  | { readonly code: 20001; readonly data: { readonly fields: readonly ['phone'] } }
  | { readonly code: 20002 }
  | { readonly code: 20003 }
  | { readonly code: 30414 }
  | { readonly code: 44001; readonly data?: { readonly risk_msg_code: string } }
  | {
      readonly code: 30411;
      readonly data?: { readonly reason: 'mergeable'; readonly merge_ticket: string };
    }
  | { readonly code: 10002 }
  | { readonly code: 10003 }
  | { readonly code: 50001 };

// The ports shared with the merge live in merge-conditions.ts (no import cycle); re-exported here,
// where app.module and the tests have always found them.
export type { AccountAssetsPort, AccountRef, AccountRiskPort } from './merge-conditions.ts';

export interface BindPhoneOptions {
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly redis: RedisHandle;
  readonly sms: Pick<SmsCodeService, 'verifyAndConsume'>;
  readonly blocklist: BlocklistService | null;
  readonly risk: AccountRiskPort;
  readonly assets: AccountAssetsPort;
  /** D10-1099 Q-3 / Q-4 (merge-conditions.ts), assembled by app.module as `accountMerge`. */
  readonly barriers: MergeBarrierPort;
  /** The change ports (B1-20b); without them a change fails (50001) and writes nothing. */
  readonly change?: PhoneChangePorts;
}

/** The system audit actor and action of a self-service phone change (B1-20b, D10-2192). */
export const PHONE_CHANGE_AUDIT_ACTOR = 'system:self_service';
export const PHONE_CHANGE_AUDIT_ACTION = 'user_phone_change';

/** One system audit row on the change's transaction (app.module: admin's system audit writer). */
export interface PhoneChangeAuditPort {
  appendAction(
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly actor: typeof PHONE_CHANGE_AUDIT_ACTOR;
      readonly action: typeof PHONE_CHANGE_AUDIT_ACTION;
      readonly target: string;
      readonly before: { readonly phone_masked: string | null };
      readonly after: { readonly phone_masked: string };
    },
  ): Promise<void>;
}

export interface PhoneChangePorts {
  readonly switch: PhoneChangeSwitch;
  /** Every session of the user except keep_sid, with the push token unbinding, on `trx`. */
  readonly revokeOthers: (
    trx: Transaction<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      readonly keep_sid: string;
      readonly reason: 'phone_changed';
    },
  ) => Promise<readonly string[]>;
  readonly audit: PhoneChangeAuditPort;
}

/** BR-ID-06: the old phone_hmac is kept 180 days (as admin-profile-edit). */
const PHONE_CHANGED_RETENTION_MS = 180 * 86_400_000;

function isPhoneIndexConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'users_phone_hmac_key'
  );
}

export interface BindPhoneService {
  bind(trx: Transaction<DB>, command: BindPhoneCommand): Promise<BindPhoneResult>;
}

/** Record a blocklist hit only after the caller releases its transaction connection. */
export class BindPhoneBlocked extends Error {
  readonly result: Extract<BindPhoneResult, { code: 44001 }>;
  readonly record: () => Promise<void>;

  constructor(result: Extract<BindPhoneResult, { code: 44001 }>, record: () => Promise<void>) {
    super('identity: bind phone blocked');
    this.result = result;
    this.record = record;
  }
}

/** Redis namespace of merge tickets; shared with the merge (merge-account.ts). */
export const MERGE_TICKET_NAMESPACE = 'merge_ticket';
/** A ticket's key in MERGE_TICKET_NAMESPACE: the SHA-256 hex of the ticket (02 §18「并号」). */
export function mergeTicketKey(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}
/** Seconds a merge ticket lives (BR-ID-06: 5 分钟有效). */
export const MERGE_TICKET_TTL_SECONDS = 300;

const TICKET_SCRIPT = `
return redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[1] * 1000, 'NX')
`;

export function createBindPhoneService(options: BindPhoneOptions): BindPhoneService {
  const { clock, crypto, redis, sms, blocklist, assets, risk, barriers } = options;

  /** 44001 of the number, thrown so the hits are recorded after the transaction is released. */
  async function refuseBlocked(
    trx: Transaction<DB>,
    account: { readonly app_id: string; readonly user_id: string },
    phone: string,
    phoneHmac: string,
  ): Promise<void> {
    if (blocklist === null) return;
    const blocked = await blocklist.matchRegistration(trx, {
      app_id: account.app_id,
      phone_hmac: phoneHmac,
      related_phone: phone,
    });
    if (blocked === null) return;
    throw new BindPhoneBlocked({ code: 44001, data: blocked.data }, async () => {
      await blocklist.recordHits(
        {
          app_id: account.app_id,
          user_id: account.user_id,
          request_type: null,
          related_phone: phone,
        },
        blocked.hits,
      );
    });
  }

  /** The change branch (file header); the users row is already locked by the caller. */
  async function change(
    transaction: Transaction<DB>,
    command: BindPhoneCommand,
    current: {
      readonly phone_hmac: string;
      readonly phone_cipher: Buffer | null;
      readonly row_version: number;
    },
    ports: PhoneChangePorts,
  ): Promise<BindPhoneResult> {
    const trx = transaction.withSchema('app');
    const account = { app_id: command.app_id, user_id: command.user_id };
    const sid = command.sid;
    if (sid === undefined || sid.length === 0) return { code: 10003 };
    // Codex money r1 S0 #2: the request's session is still live under the lock (a change committed
    // while this request waited revoked it) → 10002 as stage ② answers a revoked session.
    const session = await trx
      .selectFrom('sessions')
      .select('revoked_at')
      .where('app_id', '=', account.app_id)
      .where('sid', '=', sid)
      .where('user_id', '=', account.user_id)
      .executeTakeFirst();
    if (session === undefined || session.revoked_at !== null) return { code: 10002 };
    // Codex money r1 S0 #1 / #2: the change is judged on the locked row, not on stage ⑫'s unlocked
    // read. This request must have passed a phone_change token (a first binding that lost the race
    // to another first binding passed none), issued by SMS for the number being replaced (a token
    // for a number already changed away does not prove this one) → else 10003.
    const judged = command.step_up;
    if (
      judged === undefined ||
      judged === null ||
      judged.action !== 'phone_change' ||
      !phoneChangeBindingMatches(judged, current.phone_hmac)
    ) {
      return { code: 10003 };
    }
    if (!(await ports.switch.enabled(account.app_id, transaction))) return PHONE_CHANGE_DISABLED;
    const normalized = normalize_phone(command.body.phone);
    if (normalized.code !== 0) {
      return { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } };
    }
    const phone = normalized.phone;
    const phoneHmac = crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT);
    // The same number after normalisation is not a change: nothing consumed or written.
    if (phoneHmac === current.phone_hmac) return { code: 20001, data: { fields: ['phone'] } };
    const verified = await sms.verifyAndConsume({
      app_id: account.app_id,
      phone,
      purpose: 'bind',
      code: command.body.code,
    });
    if (verified.code !== 0) return { code: verified.code };
    await refuseBlocked(trx, account, phone, phoneHmac);
    const holder = await trx
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', account.app_id)
      .where('phone_hmac', '=', phoneHmac)
      .where('status', '<>', 'deleted')
      .where('id', '<>', account.user_id)
      .executeTakeFirst();
    // A change never offers a merge (BR-ID-06: accounts are never merged here).
    if (holder !== undefined) return { code: 30411 };
    const now = clock.now();
    // The first write of the change: a concurrent account can win the phone's partial unique index
    // after the lookup; recover only that conflict so the outer transaction persists the 30411.
    await sql`SAVEPOINT identity_change_phone`.execute(trx);
    try {
      const written = await trx
        .updateTable('users')
        .set({
          phone_cipher: Buffer.from(crypto.encrypt(phone, PHONE_CIPHER_CONTEXT), 'utf8'),
          phone_hmac: phoneHmac,
          updated_at: now,
          row_version: current.row_version + 1,
        })
        .where('app_id', '=', account.app_id)
        .where('id', '=', account.user_id)
        .where('phone_hmac', '=', current.phone_hmac)
        .where('row_version', '=', current.row_version)
        .executeTakeFirst();
      await sql`RELEASE SAVEPOINT identity_change_phone`.execute(trx);
      // Unreachable under the row lock; never record a change that did not happen.
      if (written.numUpdatedRows !== 1n) {
        throw new Error('identity: phone change lost its locked users row');
      }
    } catch (error) {
      if (!isPhoneIndexConflict(error)) throw error;
      await sql`ROLLBACK TO SAVEPOINT identity_change_phone`.execute(trx);
      await sql`RELEASE SAVEPOINT identity_change_phone`.execute(trx);
      return { code: 30411 };
    }
    await trx
      .insertInto('deleted_identities')
      .values({
        app_id: account.app_id,
        reason: 'phone_changed',
        phone_hmac: current.phone_hmac,
        device_hash: null,
        deleted_at: now,
        expire_at: instantPlus(now, PHONE_CHANGED_RETENTION_MS),
      })
      .execute();
    await ports.revokeOthers(transaction, {
      app_id: account.app_id,
      user_id: account.user_id,
      keep_sid: sid,
      reason: 'phone_changed',
    });
    const old =
      current.phone_cipher === null
        ? null
        : crypto.decrypt(current.phone_cipher.toString('utf8'), PHONE_CIPHER_CONTEXT);
    await ports.audit.appendAction(transaction, {
      appId: account.app_id,
      actor: PHONE_CHANGE_AUDIT_ACTOR,
      action: PHONE_CHANGE_AUDIT_ACTION,
      target: `users:${account.user_id}`,
      before: { phone_masked: old === null ? null : maskPhone(old) },
      after: { phone_masked: maskPhone(phone) },
    });
    return { code: 0 };
  }

  return {
    async bind(transaction, command) {
      const trx = transaction.withSchema('app');
      const account = { app_id: command.app_id, user_id: command.user_id };
      // Serialize first bindings by this user, even with different idempotency keys.
      const current = await trx
        .selectFrom('users')
        .select([
          'phone_hmac',
          'phone_cipher',
          'register_method',
          'parent_id',
          'status',
          'row_version',
        ])
        .where('app_id', '=', account.app_id)
        .where('id', '=', account.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.phone_hmac !== null) {
        // A change never runs unchecked: without its ports the request fails closed (50001).
        if (options.change === undefined) {
          throw new Error('identity: a phone change needs the switch, revocation and audit ports');
        }
        return change(
          transaction,
          command,
          {
            phone_hmac: current.phone_hmac,
            phone_cipher: current.phone_cipher,
            row_version: current.row_version,
          },
          options.change,
        );
      }
      const normalized = normalize_phone(command.body.phone);
      if (normalized.code !== 0) {
        return { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } };
      }
      const phone = normalized.phone;
      const verified = await sms.verifyAndConsume({
        app_id: account.app_id,
        phone,
        purpose: 'bind',
        code: command.body.code,
      });
      if (verified.code !== 0) return { code: verified.code };
      const phoneHmac = crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT);
      await refuseBlocked(trx, account, phone, phoneHmac);
      const target = await trx
        .selectFrom('users')
        .select(['id', 'status'])
        .where('app_id', '=', account.app_id)
        .where('phone_hmac', '=', phoneHmac)
        .where('status', '<>', 'deleted')
        .executeTakeFirst();
      if (target !== undefined) {
        // BR-ID-06 merge conditions, the same judgement the merge applies again (merge-conditions.ts).
        if (
          !(await mergeConditionsHold(
            trx,
            account.app_id,
            { ...current, id: account.user_id },
            target,
            { assets, risk, barriers },
          ))
        )
          return { code: 30411 };
        const ticket = randomBytes(32).toString('hex');
        try {
          const stored = await redis.namespace(MERGE_TICKET_NAMESPACE).eval(TICKET_SCRIPT, {
            keys: [mergeTicketKey(ticket)],
            args: [
              JSON.stringify({
                app_id: account.app_id,
                uid: account.user_id,
                phone_hmac: phoneHmac,
              }),
            ],
            ttlSeconds: MERGE_TICKET_TTL_SECONDS,
          });
          if (stored !== 'OK') return { code: 50001 };
        } catch (error) {
          if (error instanceof RedisUnavailableError) return { code: 50001 };
          throw error;
        }
        return { code: 30411, data: { reason: 'mergeable', merge_ticket: ticket } };
      }
      // A concurrent account can win the phone's partial unique index after the lookup.
      // Recover only that conflict so the outer transaction can persist the plain 30411.
      await sql`SAVEPOINT identity_bind_phone`.execute(trx);
      try {
        const written = await trx
          .updateTable('users')
          .set({
            phone_cipher: Buffer.from(crypto.encrypt(phone, PHONE_CIPHER_CONTEXT), 'utf8'),
            phone_hmac: phoneHmac,
            updated_at: clock.now(),
            row_version: current.row_version + 1,
          })
          .where('app_id', '=', account.app_id)
          .where('id', '=', account.user_id)
          .where('phone_hmac', 'is', null)
          .where('row_version', '=', current.row_version)
          .executeTakeFirst();
        await sql`RELEASE SAVEPOINT identity_bind_phone`.execute(trx);
        return { code: written.numUpdatedRows === 1n ? 0 : 10003 };
      } catch (error) {
        if (!isPhoneIndexConflict(error)) throw error;
        await sql`ROLLBACK TO SAVEPOINT identity_bind_phone`.execute(trx);
        await sql`RELEASE SAVEPOINT identity_bind_phone`.execute(trx);
        return { code: 30411 };
      }
    },
  };
}
