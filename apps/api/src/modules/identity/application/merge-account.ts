// POST /v1/auth/merge (规划/08 BR-ID-06 正文与细则「并号」「并号时的其余记录」「并号响应丢失」; 04 §6.1
// mergeAccount; 02 §18「并号」; BR-WDR-01 细则「并号」; task B1-20c, orchestrator D10-1099, D10-1103,
// D10-1097). The controller reads withdraw.dormant_reverify_days before the transaction and runs
// merge() inside platform idempotency's transactional mode (the record stores code 0 and 3xxxx
// results with the handler's writes and rolls everything back otherwise).
//
// One transaction, in this order:
//  0. the ticket is read from Redis (namespace merge_ticket, key SHA-256 of the ticket; nothing is
//     locked yet): missing or expired → 30411; Redis unavailable → 50001; a value of another app or
//     another user → 30411 and the ticket is left as it is.
//  1. the target: the account of the app holding the ticket's phone_hmac (status <> deleted), read
//     without a lock; none → 30411.
//  2. both users rows locked in ascending id order (lockUsersForUpdate: FOR NO KEY UPDATE, the
//     repository's users lock — 02 §18 writes FOR UPDATE; NO KEY UPDATE is as exclusive between
//     lockers and leaves the KEY SHARE of referencing rows alone), then the target's consent lock
//     and growth's relation write lock: users → consent → relation, the order of every login.
//  3. the request's own session read again (Codex money review r1 S0): revoked meanwhile (a ban,
//     an admin revocation committed while the merge waited for the source's row) → 10002, nothing
//     written. Both rows read again under the locks: the target must still be that row and still
//     hold the ticket's number; every BR-ID-06 condition is judged again (merge-conditions.ts, the
//     offer's judgement; the source's risk state as well as the target's) → 30411 when any fails.
//     Nothing has been written so far, so a 30411 stored by the idempotency record carries no
//     write; the ticket is not consumed.
//  4. SAVEPOINT. BR-WDR-01 细则「并号」: the target was judged for re-verification on this device
//     before the merge transaction opened (judgeTarget below, Codex money review r1 S1: its own
//     short transaction on the pool, committed first, so the flag and its trusted identities — the
//     target's own, before any identity moves — survive a refused merge). Here it is only read: a
//     judgement that would still flag (judgeTarget could not run) → 50001, nothing written, the
//     retry judges first; then the activity values are overwritten as at a login (no judgement).
//     The target flagged and this device not one of its re-verified devices → 10010 (D10-1103) with
//     the Reverify page's method: a 1xxxx, so the merge rolls back (the flag, committed before,
//     stays), the source keeps its sessions and the ticket stays, and the same ticket merges once
//     the device is re-verified.
//  5. the source's user_oauth rows move to the target (merged_from_user_id = source); the unique
//     (app_id, user_id, provider) refusing it → back to the savepoint, 30411.
//  6. linking releases the source's bindings without cooling (AccountMergePort.releaseBindings);
//     app.union_pdd_pid_filings is not touched (D10-1097: the filings stay with the tombstone).
//  7. the source becomes the tombstone: status deleted, deleted_reason merged (no deletion request,
//     no deleted_identities row, phone and nickname as they are).
//  8. every session of the source revoked (revoke_reason merged), their push tokens unbound.
//  9. the source's registration record gets merged_into_user_id = target (once; BR-ID-05 细则).
// 10. the source's open personal data copy requests are cancelled (plan T-6, as the deletion
//     cleanup does; their files expire on their own jobs).
// 11. a login of the target on this device (completeLogin's merge mode: login_merge of this
//     device's device-level consents, login_logs method merge, the BR-INV-09 review, the session
//     with login_method merge, devices.last_login_sid, the push token bound). session_scope is
//     full: a source in deletion is refused at ⑥, a target in deletion at step 3.
// 12. the ticket consumed last, by one compare-and-delete script: not deleted (consumed or expired
//     meanwhile) → back to the savepoint, 30411; Redis unavailable → 50001 (everything rolls back:
//     a consumed ticket is never restored, an unconsumed one stays for a retry).
// Before the transaction (judgeTarget, only with the switch on): the ticket read and checked as in
// step 0, the target found as in step 1 and, on a short transaction of the pool (no transaction of
// this request is open yet), its users row locked, checked again as step 3 checks the target (status
// normal, still the ticket's number; review r2 S1) and judged (flagDormantMerge: flag only). Anything
// failing there is logged and left to the merge transaction, which refuses as described.
// Lock order (Codex money review r1 S2): users → consent → relation, as login-completion takes them;
// growth's invite / landing binders take the relation lock before they update a users row, so the
// two orders already in the repository cannot both be kept by any third order. A deadlock between a
// merge and a binder is resolved by PostgreSQL rolling one back whole; the controller retries the
// merge once on deadlock_detected (retryOnDeadlock): the failed attempt's transaction, the
// idempotency claim included, rolled back with it, and the ticket — consumed only after every lock
// is held — is still there.
// The success answer is LoginResponse; the stored idempotency record keeps it with tokens null
// (D10-1099 Q-6, the controller's archive override). A retry with the same key after a lost
// response meets the revoked source session at ② (10002) and never reaches the replay.
// Nothing logs a phone number, a ticket or a token; one info line with the two user ids.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  RedisUnavailableError,
  type Clock,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import { lockUserConsents } from '../infra/consent-records.ts';
import { deviceHashOf } from '../infra/login-accounts.ts';
import { cancelOpenCopiesOfUser } from '../infra/personal-data-copies.ts';
import { lockUsersForUpdate } from '../ports/lock-users.ts';
import {
  MERGE_TICKET_NAMESPACE,
  mergeTicketKey,
  type AccountAssetsPort,
  type AccountRiskPort,
} from './bind-phone.ts';
import { completeLogin, type LoginCompletionOptions } from './login-completion.ts';
import { mergeConditionsHold, type AccountMergePort } from './merge-conditions.ts';
import { unbindRevoked } from './push-tokens.ts';
import { flagDormantMerge, isDormantUnflagged, recordLoginActivity } from './reverify-activity.ts';
import { pendingData, reverifyStanding, type ReverifyPendingData } from './reverify-gate.ts';
import { revokeSessionsByUser } from './revoke-sessions.ts';

/** The verified request: uid, app and device come from the token and the signed device only. */
export interface MergeAccountCommand {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly platform: ClientPlatform;
  readonly client_ip: string;
  readonly merge_ticket: string;
  /** The request's session (the token's sid): it must still be live under the locks. */
  readonly sid: string;
  /** withdraw.dormant_reverify_days, read before the transaction; absent: off. */
  readonly dormantReverifyDays: number | undefined;
}

export type MergeAccountResult =
  | { readonly code: 0; readonly data: Schema<'LoginData'> }
  | { readonly code: 30411 }
  | { readonly code: 10002 }
  | { readonly code: 10010; readonly data: ReverifyPendingData }
  | { readonly code: 50001 };

export interface MergeAccountOptions extends LoginCompletionOptions {
  /** The pool: judgeTarget's short transaction only, never while a merge transaction is open. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly redis: RedisHandle;
  readonly logger: RootLogger;
  readonly assets: AccountAssetsPort;
  readonly risk: AccountRiskPort;
  readonly merge: AccountMergePort;
}

export interface MergeAccountService {
  /**
   * BR-WDR-01 细则「并号」 before the merge transaction: flags the ticket's target when a login of it
   * on this device would; committed on its own. Never throws; answers nothing.
   */
  judgeTarget(command: MergeAccountCommand): Promise<void>;
  merge(trx: Transaction<DB>, command: MergeAccountCommand): Promise<MergeAccountResult>;
}

/** PostgreSQL deadlock_detected. */
export function isDeadlock(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '40P01'
  );
}

/**
 * Runs `attempt` again once when it failed with deadlock_detected (Codex money review r1 S2): the
 * failed attempt's transaction has rolled back whole, so the retry starts from nothing.
 */
export async function retryOnDeadlock<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    return attempt();
  }
}

/** The ticket value bind-phone stores (JSON {app_id, uid, phone_hmac}). */
interface TicketValue {
  readonly app_id: string;
  readonly uid: string;
  readonly phone_hmac: string;
}

/** Deletes the ticket only while it still holds the value read at the start (ARGV[1] is a TTL). */
const CONSUME_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[2] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const SAVEPOINT = 'identity_merge';

function ticketValue(raw: string): TicketValue | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { app_id: appId, uid, phone_hmac: phoneHmac } = value as Record<string, unknown>;
  if (typeof appId !== 'string' || typeof uid !== 'string' || typeof phoneHmac !== 'string') {
    return null;
  }
  return { app_id: appId, uid, phone_hmac: phoneHmac };
}

/** Only this collision means the target got a same-provider identity meanwhile. */
function providerCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === 'user_oauth_user_provider_key';
}

class MergeRefused extends Error {
  readonly result: Exclude<MergeAccountResult, { code: 0 }>;
  constructor(result: Exclude<MergeAccountResult, { code: 0 }>) {
    super('identity: merge refused');
    this.result = result;
  }
}

export function createMergeAccountService(options: MergeAccountOptions): MergeAccountService {
  const { db, clock, redis, logger, assets, risk, merge, pushTokens } = options;
  const tickets = () => redis.namespace(MERGE_TICKET_NAMESPACE);

  /** Step 0: the stored value as read (the raw string is what the consumption compares). */
  async function readTicket(
    ticket: string,
  ): Promise<{ readonly raw: string; readonly value: TicketValue } | MergeAccountResult> {
    let raw: string | null;
    try {
      raw = await tickets().get(mergeTicketKey(ticket));
    } catch (error) {
      if (error instanceof RedisUnavailableError) return { code: 50001 };
      throw error;
    }
    if (raw === null) return { code: 30411 };
    const value = ticketValue(raw);
    return value === null ? { code: 30411 } : { raw, value };
  }

  /** Steps 4–12 under the savepoint; MergeRefused rolls back to it. */
  async function execute(
    trx: Transaction<DB>,
    command: MergeAccountCommand,
    ticket: { readonly key: string; readonly raw: string },
    target: { readonly id: string; readonly parent_bind_source: string | null },
  ): Promise<Schema<'LoginData'>> {
    const { app_id: appId, user_id: sourceId, device_id: deviceId } = command;
    const now = clock.now();
    const deviceHash = (await deviceHashOf(trx, appId, deviceId)) ?? null;

    // 4. BR-WDR-01 细则「并号」: judged and committed by judgeTarget before this transaction; read
    // here only (a flag set inside this transaction would roll back with a 10010).
    const activity = {
      app_id: appId,
      user_id: target.id,
      deviceHash,
      now,
      days: command.dormantReverifyDays,
    };
    if (await isDormantUnflagged(trx, activity)) {
      logger.warn({ app_id: appId, user_id: target.id }, 'identity_merge_reverify_unjudged');
      throw new MergeRefused({ code: 50001 });
    }
    await recordLoginActivity(trx, { ...activity, days: undefined });
    const standing = await reverifyStanding(
      trx,
      { app_id: appId, user_id: target.id },
      deviceId,
      accountingDate(now),
    );
    if (!standing.settled) {
      throw new MergeRefused({ code: 10010, data: pendingData(standing.requirement) });
    }

    // 5. The source's identities move as they are, marked as merged. A unique violation aborts
    // the transaction until the caller rolls back to its savepoint (MergeRefused).
    try {
      await trx
        .updateTable('user_oauth')
        .set((eb) => ({
          user_id: target.id,
          merged_from_user_id: sourceId,
          row_version: eb('row_version', '+', 1),
          updated_at: now,
        }))
        .where('app_id', '=', appId)
        .where('user_id', '=', sourceId)
        .execute();
    } catch (error) {
      if (!providerCollision(error)) throw error;
      throw new MergeRefused({ code: 30411 });
    }

    // 6. linking: the source's bindings released without cooling.
    await merge.releaseBindings(trx, { appId, userId: sourceId, at: now });

    // 7. The tombstone (BR-ID-06: no cooling period, no deleted_identities).
    const tomb = await trx
      .updateTable('users')
      .set((eb) => ({
        status: 'deleted',
        deleted_reason: 'merged',
        row_version: eb('row_version', '+', 1),
        updated_at: now,
      }))
      .where('app_id', '=', appId)
      .where('id', '=', sourceId)
      .where('status', '=', 'normal')
      .executeTakeFirst();
    if (tomb.numUpdatedRows !== 1n) throw new Error('identity: the merge source left normal');

    // 8. Every session of the source ends; their push tokens are unbound (BR-ID-07 细则).
    await revokeSessionsByUser(
      trx,
      { app_id: appId, user_id: sourceId, reason: 'merged' },
      clock,
      pushTokens === undefined ? undefined : unbindRevoked(pushTokens),
    );

    // 9. BR-ID-05 细则: the registration record names the account it was merged into, once.
    await trx
      .updateTable('device_registrations')
      .set({ merged_into_user_id: target.id })
      .where('app_id', '=', appId)
      .where('user_id', '=', sourceId)
      .where('merged_into_user_id', 'is', null)
      .execute();

    // 10. Plan T-6: the tombstone's open personal data copy requests end.
    await cancelOpenCopiesOfUser(trx, { appId, userId: sourceId, at: now });

    // 11. A login of the target on this device.
    const tokens = await completeLogin(
      trx,
      {
        merge: true,
        app_id: appId,
        device_id: deviceId,
        platform: command.platform,
        client_ip: command.client_ip,
      },
      target,
      'full',
      'merge',
      options,
    );

    // 12. The ticket consumed last: a failure here undoes everything above.
    let consumed: unknown;
    try {
      consumed = await tickets().eval(CONSUME_SCRIPT, {
        keys: [ticket.key],
        args: [ticket.raw],
        ttlSeconds: 1,
      });
    } catch (error) {
      if (error instanceof RedisUnavailableError) throw new MergeRefused({ code: 50001 });
      throw error;
    }
    if (consumed !== 1) throw new MergeRefused({ code: 30411 });
    return { user_id: target.id, is_new_user: false, tokens };
  }

  return {
    async judgeTarget(command) {
      if (command.dormantReverifyDays === undefined) return;
      const { app_id: appId, user_id: sourceId, device_id: deviceId } = command;
      try {
        const read = await readTicket(command.merge_ticket);
        if ('code' in read) return;
        const { value } = read;
        if (value.app_id !== appId || value.uid !== sourceId) return;
        await db.transaction().execute(async (transaction) => {
          const trx = transaction.withSchema('app');
          const found = await trx
            .selectFrom('users')
            .select('id')
            .where('app_id', '=', appId)
            .where('phone_hmac', '=', value.phone_hmac)
            .where('status', '<>', 'deleted')
            .executeTakeFirst();
          if (found === undefined || found.id === sourceId) return;
          await flagDormantMerge(trx, {
            app_id: appId,
            user_id: found.id,
            deviceHash: (await deviceHashOf(trx, appId, deviceId)) ?? null,
            now: clock.now(),
            days: command.dormantReverifyDays,
            // r2 S1: judged only while the account still holds the ticket's number under the lock.
            phoneHmac: value.phone_hmac,
          });
        });
      } catch (error) {
        // The merge transaction refuses (50001) when the judgement is still owed; no detail here.
        logger.warn(
          { app_id: appId, error_name: error instanceof Error ? error.name : typeof error },
          'identity_merge_reverify_judgement_failed',
        );
      }
    },

    async merge(transaction, command) {
      const trx = transaction.withSchema('app');
      const { app_id: appId, user_id: sourceId } = command;

      // 0. The ticket, before any lock.
      const read = await readTicket(command.merge_ticket);
      if ('code' in read) return read;
      const { raw, value } = read;
      if (value.app_id !== appId || value.uid !== sourceId) return { code: 30411 };

      // 1. The target as committed now, without a lock.
      const found = await trx
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', appId)
        .where('phone_hmac', '=', value.phone_hmac)
        .where('status', '<>', 'deleted')
        .executeTakeFirst();
      if (found === undefined || found.id === sourceId) return { code: 30411 };

      // 2. users rows (ascending id) → the target's consent lock → growth's relation lock.
      await lockUsersForUpdate(trx, { appId, userIds: [sourceId, found.id] });
      await lockUserConsents(trx, appId, found.id);
      await merge.lockRelationWrites(trx, appId);

      // 3. The request's session is still live (a ban or a revocation committed while the merge
      // waited for the source's row ends it), then every condition again, on the rows as they are
      // under the locks.
      const session = await trx
        .selectFrom('sessions')
        .select('revoked_at')
        .where('app_id', '=', appId)
        .where('sid', '=', command.sid)
        .where('user_id', '=', sourceId)
        .executeTakeFirst();
      if (session === undefined || session.revoked_at !== null) return { code: 10002 };
      const rows = await trx
        .selectFrom('users')
        .select([
          'id',
          'register_method',
          'phone_hmac',
          'parent_id',
          'status',
          'parent_bind_source',
        ])
        .where('app_id', '=', appId)
        .where('id', 'in', [sourceId, found.id])
        .execute();
      const source = rows.find((row) => row.id === sourceId);
      const target = rows.find((row) => row.id === found.id);
      if (
        source === undefined ||
        target === undefined ||
        target.phone_hmac !== value.phone_hmac ||
        !(await mergeConditionsHold(trx, appId, source, target, {
          assets,
          risk,
          barriers: merge,
        }))
      ) {
        return { code: 30411 };
      }

      // 4–12 under one savepoint: a refusal stored as 3xxxx must carry none of these writes.
      await sql`SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
      try {
        const data = await execute(
          trx,
          command,
          { key: mergeTicketKey(command.merge_ticket), raw },
          { id: target.id, parent_bind_source: target.parent_bind_source },
        );
        await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
        logger.info(
          { app_id: appId, user_id: target.id, merged_from_user_id: sourceId },
          'identity_merge_done',
        );
        return { code: 0, data };
      } catch (error) {
        if (!(error instanceof MergeRefused)) throw error;
        await sql`ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
        await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
        return error.result;
      }
    },
  };
}
