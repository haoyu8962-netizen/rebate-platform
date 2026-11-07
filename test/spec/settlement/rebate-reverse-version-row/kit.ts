// B2-04zzi rule-test kit (claude-independent; FU-R6-VERSION-ROW, D10-931 ①, D10-932).
// Only synthetic setup and observations. The path under test is the production order sync of a real
// AppModule.forEntry({ entry: 'worker' }): the worker, its apps and its jd orders are those of
// ../jd-remaining-zero/kit.ts (reused, not changed), so the rebate hook is settlement's port and the
// version rows are written by commission's estimates port, as in production. Only the job queue is
// a stub; the bus still writes event_log.
// Every app has one member and one rule version: reserve 0, own share 50 %, jd deducts no service
// fee and the fixture has no subsidy, so N = 1000 → B 1000 → 500, N = 600 → 600 → 300, N = 0 → 0 → 0
// (written by hand in the tests).
// Integration tests pass the database in: this file never imports @couli/db/testing.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { App, SyncedOrder, Worker } from '../jd-remaining-zero/kit.ts';

export {
  JD_INVALID,
  TIMEOUT,
  databaseFixture,
  touched,
  withWorker,
} from '../jd-remaining-zero/kit.ts';
export type { App, SyncedOrder, Worker } from '../jd-remaining-zero/kit.ts';

/** The two rebate states before credit (BR-FUND-01: R6 books nothing from either). */
export type Unbooked = 'ESTIMATED' | 'WAITING';

/**
 * An attributed jd order of the app's member at `status`, valued once on N = 1000: commission
 * version 1. ESTIMATED after its first report, WAITING after a receipt (jd 17 with received_at).
 */
export async function unbooked(w: Worker, app: App, status: Unbooked): Promise<SyncedOrder> {
  const o = w.order(app, 'jd');
  await o.sync();
  if (status === 'WAITING') await o.sync(o.receipt(1));
  expect(await o.row()).toMatchObject({
    user_id: app.userId,
    rebate_status: status,
    platform_status: status === 'WAITING' ? 'RECEIVED' : 'PAID',
    est_commission_fen: 1000n,
    commission_version: 1,
    reason: null,
  });
  return o;
}

/** One amount row as the tests compare it. */
export interface AmountRow {
  readonly commission_version: number;
  readonly user_id: string;
  readonly role: string;
  readonly base_fen: bigint;
  readonly amount_fen: bigint;
}

/** The four amounts of one version (BR-CALC-27) as the tests compare them. */
export interface FourAmounts {
  readonly commission_version: number;
  readonly n_total_fen: bigint;
  readonly pre_base_deduct_fen: bigint;
  readonly base_fen: bigint;
  readonly user_share_total_fen: bigint;
  readonly tlj_redpacket_fen: bigint | null;
  readonly platform_est_profit_fen: bigint | null;
}

/** Every amount row and every totals row of the order, oldest version first. */
export async function versionRows(
  db: Kysely<DB>,
  app: App,
  o: SyncedOrder,
): Promise<{ readonly amounts: AmountRow[]; readonly totals: FourAmounts[] }> {
  const { order_id: orderId } = await o.row();
  const amounts = await db
    .selectFrom('commission_split_amounts')
    .select(['commission_version', 'user_id', 'role', 'base_fen', 'amount_fen'])
    .where('app_id', '=', app.appId)
    .where('order_id', '=', orderId)
    .orderBy('commission_version')
    .orderBy('role')
    .execute();
  const totals = await db
    .selectFrom('commission_split_totals')
    .select([
      'commission_version',
      'n_total_fen',
      'pre_base_deduct_fen',
      'base_fen',
      'user_share_total_fen',
      'tlj_redpacket_fen',
      'platform_est_profit_fen',
    ])
    .where('app_id', '=', app.appId)
    .where('order_id', '=', orderId)
    .orderBy('commission_version')
    .execute();
  return { amounts, totals };
}
