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
// this task, with or without X-Step-Up-Token, before any code is consumed (B1-20b does changes).
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
import { normalize_phone } from '../domain/normalize-phone.ts';
import { PHONE_BLIND_INDEX_CONTEXT, PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import {
  mergeConditionsHold,
  type AccountAssetsPort,
  type AccountRiskPort,
  type MergeBarrierPort,
} from './merge-conditions.ts';
import type { SmsCodeService } from './sms-codes.ts';

/** The verified request: uid, app and device come from the token and the signed device only. */
export interface BindPhoneCommand {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly body: { readonly phone: string; readonly code: string };
}

export type BindPhoneResult =
  | { readonly code: 0 }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    }
  | { readonly code: 20002 }
  | { readonly code: 20003 }
  | { readonly code: 44001; readonly data?: { readonly risk_msg_code: string } }
  | {
      readonly code: 30411;
      readonly data?: { readonly reason: 'mergeable'; readonly merge_ticket: string };
    }
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
  return {
    async bind(transaction, command) {
      const trx = transaction.withSchema('app');
      const account = { app_id: command.app_id, user_id: command.user_id };
      // Serialize first bindings by this user, even with different idempotency keys.
      const current = await trx
        .selectFrom('users')
        .select(['phone_hmac', 'register_method', 'parent_id', 'status', 'row_version'])
        .where('app_id', '=', account.app_id)
        .where('id', '=', account.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.phone_hmac !== null) return { code: 10003 };
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
      if (blocklist !== null) {
        const blocked = await blocklist.matchRegistration(trx, {
          app_id: account.app_id,
          phone_hmac: phoneHmac,
          related_phone: phone,
        });
        if (blocked !== null) {
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
      }
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
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== '23505' ||
          !('constraint' in error) ||
          error.constraint !== 'users_phone_hmac_key'
        )
          throw error;
        await sql`ROLLBACK TO SAVEPOINT identity_bind_phone`.execute(trx);
        await sql`RELEASE SAVEPOINT identity_bind_phone`.execute(trx);
        return { code: 30411 };
      }
    },
  };
}
