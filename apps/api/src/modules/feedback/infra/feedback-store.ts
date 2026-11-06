// B1-28p: feedback's only access to app.product_feedbacks (migration 0125; feedback is the table's
// single writer), plus the read lock of the submitting user's app.users row (lockUserForShare).
// Raw SQL over the caller's transaction for app.product_feedbacks, every statement naming the
// table in full.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

export interface NewProductFeedback {
  readonly id: string;
  readonly appId: string;
  readonly deviceId: string;
  readonly userId: string | null;
  readonly platform: string;
  readonly productKey: string;
  readonly itemRef: string | null;
  readonly linkId: string;
  readonly shownFinalPriceFen: bigint;
  readonly shownRebateFen: bigint | null;
  readonly quotedAt: Date;
  readonly reason: string;
  readonly note: string | null;
  readonly createdAt: Date;
}

/**
 * The transaction-scoped advisory lock of one device's feedback in one app, held until the
 * caller's commit or rollback: the daily count and the insert of concurrent submissions of the
 * same device run one after the other, so the limit is never passed (brief §9.2 ③).
 */
export async function lockDeviceFeedback(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
): Promise<void> {
  const name = `feedback.product_feedbacks.device:${appId}:${deviceId.toLowerCase()}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`.execute(trx);
}

/**
 * Money r1 S1 (BR-ID-28): the submitting user's app.users row FOR SHARE, held until the caller's
 * commit or rollback; true when the row exists in the app. A read lock only (feedback never writes
 * users), the same lock push token reporting takes (D10-318): it conflicts with the deletion
 * cleanup's lock of the row (identity's lockUsersForUpdate, FOR NO KEY UPDATE) and with the
 * status change to deleting, so the status read after it is the committed one and a cleanup can
 * neither start nor commit while this submission is between that read and its commit; two
 * submissions (FOR SHARE) and the foreign-key checks of rows referencing users (FOR KEY SHARE)
 * never wait on it.
 */
export async function lockUserForShare(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .forShare()
    .executeTakeFirst();
  return row !== undefined;
}

/** The device's records with created_at in [start, end). */
export async function countDeviceFeedback(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n
    FROM app.product_feedbacks
    WHERE app_id = ${appId} AND device_id = ${deviceId}::uuid
      AND created_at >= ${start} AND created_at < ${end}`.execute(trx);
  return Number(rows[0]?.n ?? '0');
}

export async function insertFeedback(trx: Transaction<DB>, row: NewProductFeedback): Promise<void> {
  await sql`INSERT INTO app.product_feedbacks (id, app_id, device_id, user_id, platform,
      product_key, item_ref, link_id, shown_final_price_fen, shown_rebate_fen, quoted_at, reason,
      note, created_at)
    VALUES (${row.id}::uuid, ${row.appId}, ${row.deviceId}::uuid, ${row.userId}::uuid,
      ${row.platform}, ${row.productKey}, ${row.itemRef}, ${row.linkId}::uuid,
      ${row.shownFinalPriceFen.toString()}::bigint,
      ${row.shownRebateFen === null ? null : row.shownRebateFen.toString()}::bigint,
      ${row.quotedAt}, ${row.reason}, ${row.note}, ${row.createdAt})`.execute(trx);
}

/** Deletes every record carrying `userId` in the app; guest rows (user_id NULL) never match. */
export async function deleteUserFeedback(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  await sql`DELETE FROM app.product_feedbacks
    WHERE app_id = ${appId} AND user_id = ${userId}::uuid`.execute(trx);
}
