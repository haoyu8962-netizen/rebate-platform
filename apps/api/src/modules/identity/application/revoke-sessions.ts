// Ending every session of a user or of a device (规划/08 BR-ID-07 细则「退出登录」「被动结束会话时
// 解绑」, BR-ID-06 细则「改号后全部设备退出登录」; 04 §3.2 sessions; migration 0013). The internal
// entries other modules call through identity's index.ts: phone change (B1-27), merge (B1-20),
// the console's ban (F1-07d: risk's admin risk state command, through app.module's assembly with
// the push token unbinding), admin revocation by user or by device.
//   - The caller owns the transaction: the revocation commits or rolls back with the caller's work.
//   - Every session of the user / device in that app whose revoked_at is still empty gets
//     revoked_at = the Clock's now, the given revoke_reason and updated_at, once (`revoked_at IS
//     NULL` in the WHERE clause): a session revoked earlier keeps its time and reason.
//   - Nothing else is written: refresh tokens are judged through their session, and
//     devices.last_login_sid stays as it is (BR-ID-07 细则「旧会话终止与当前有效会话并存」).
//   - afterRevoked runs in the same transaction with the revoked sids and their app (the push
//     token unbinding of B1-12b, push-tokens.ts unbindRevoked); a failing hook rolls the
//     revocation back with the caller's transaction.
// The refresh reuse detection (refresh.ts) revokes one sid with revokeSession and the same hook.
// The self-service phone change (B1-20b) revokes every session of the user but its own sid.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type SessionRevokeReason =
  | 'logout'
  | 'refresh_reuse'
  | 'phone_changed'
  | 'merged'
  | 'banned'
  | 'admin_revoked'
  | 'device_revoked'
  /** B1-15g: the deletion cleanup (BR-ID-28). */
  | 'account_deleted';

/** The sids are sessions of `context.app_id` (sid is unique per app, 0013). */
export type AfterSessionsRevoked = (
  trx: Transaction<DB>,
  sids: readonly string[],
  context: { readonly app_id: string },
) => Promise<void>;

/** The fixed revoke_reason values (orchestrator ruling B1-02k §9.2). */
const REVOKE_REASONS: ReadonlySet<unknown> = new Set<SessionRevokeReason>([
  'logout',
  'refresh_reuse',
  'phone_changed',
  'merged',
  'banned',
  'admin_revoked',
  'device_revoked',
  'account_deleted',
]);

function checkReason(reason: unknown): void {
  if (!REVOKE_REASONS.has(reason)) {
    throw new TypeError('identity: a session revocation needs one of the fixed revoke reasons');
  }
}

async function revokeWhere(
  trx: Transaction<DB>,
  input: { app_id: string; reason: SessionRevokeReason },
  column: 'user_id' | 'device_id',
  value: string,
  clock: Clock,
  afterRevoked: AfterSessionsRevoked | undefined,
  keepSid?: string,
): Promise<string[]> {
  checkReason(input.reason);
  const now = clock.now();
  let update = trx
    .updateTable('sessions')
    .set({ revoked_at: now, revoke_reason: input.reason, updated_at: now })
    .where('app_id', '=', input.app_id)
    .where(column, '=', value)
    .where('revoked_at', 'is', null);
  if (keepSid !== undefined) update = update.where('sid', '<>', keepSid);
  const rows = await update.returning('sid').execute();
  const sids = rows.map((row) => row.sid);
  if (sids.length > 0 && afterRevoked !== undefined) {
    await afterRevoked(trx, sids, { app_id: input.app_id });
  }
  return sids;
}

/** Caller owns the transaction; the hook joins it (B1-12b). */
export async function revokeSessionsByUser(
  trx: Transaction<DB>,
  input: { app_id: string; user_id: string; reason: SessionRevokeReason },
  clock: Clock,
  afterRevoked?: AfterSessionsRevoked,
): Promise<string[]> {
  return revokeWhere(trx, input, 'user_id', input.user_id, clock, afterRevoked);
}

export async function revokeSessionsByDevice(
  trx: Transaction<DB>,
  input: { app_id: string; device_id: string; reason: SessionRevokeReason },
  clock: Clock,
  afterRevoked?: AfterSessionsRevoked,
): Promise<string[]> {
  return revokeWhere(trx, input, 'device_id', input.device_id, clock, afterRevoked);
}

/**
 * Every session of the user except `keep_sid` (B1-20b, D10-2192: a self-service phone change keeps
 * the session that made it). Caller owns the transaction; the hook joins it.
 */
export async function revokeOtherSessionsOfUser(
  trx: Transaction<DB>,
  input: { app_id: string; user_id: string; keep_sid: string; reason: SessionRevokeReason },
  clock: Clock,
  afterRevoked?: AfterSessionsRevoked,
): Promise<string[]> {
  if (typeof input.keep_sid !== 'string' || input.keep_sid.length === 0) {
    throw new TypeError('identity: revoking the other sessions needs the session to keep');
  }
  return revokeWhere(trx, input, 'user_id', input.user_id, clock, afterRevoked, input.keep_sid);
}
