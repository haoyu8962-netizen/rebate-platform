// B2-04zzd rule-test kit (claude-independent; BR-FUND-09 细则「补差负向时发站内信并附原因」, D10-773 B,
// D10-816 ②, D10-817). Setup is the B2-04zi kit (settle-diff-sync, the assembled worker: real
// pipeline, real settle handler, real event bus writing event_log; only the job queue is a stub).
// This file adds observations only: what the app published, read back from event_log.
//
// order.settle_adjusted payload pinned by these tests (D10-773 ④ consumer shape, D10-817):
//   { order_id, order_key, settle_seq (integer, the record's seq), sub_type 'SETTLE_DIFF',
//     beneficiaries: [{ user_id, role, adjust_fen (signed integer fen, decimal string — like
//     order.clawed_back's clawback_fen), bucket ('user_available' | 'bad_debt' = the posting) }] }
// Only beneficiaries with a non-zero difference are listed; the platform difference never is.
// Author's choice (D10-817 ① left it to the rule tests): an R10 negative difference whose
// beneficiary rows are all zero (only the platform moves) still publishes, with beneficiaries [].
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { App } from '../settle-diff-sync/kit.ts';

export {
  MEMBER_ROLE,
  SETTLED_LATER,
  TIMEOUT,
  capture,
  credited,
  databaseFixture,
  settled,
  touched,
  withSync,
} from '../settle-diff-sync/kit.ts';
export type { App, Worker } from '../settle-diff-sync/kit.ts';

export const SETTLE_ADJUSTED = 'order.settle_adjusted';
export const CLAWED_BACK = 'order.clawed_back';

/** The data of every event `name` the app published, oldest first (event_log payload {v, data}). */
export async function published(
  db: Kysely<DB>,
  app: App,
  name: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('event_log')
    .select('payload')
    .where('app_id', '=', app.appId)
    .where('name', '=', name)
    .orderBy('id')
    .execute();
  return rows.map((row) => (row.payload as unknown as { data: Record<string, unknown> }).data);
}

/** One beneficiary row of order.settle_adjusted, amounts written by hand in the tests. */
export function adjusted(
  userId: string,
  role: string,
  adjustFen: string,
  bucket: 'user_available' | 'bad_debt',
): Record<string, unknown> {
  return { user_id: userId, role, adjust_fen: adjustFen, bucket };
}
