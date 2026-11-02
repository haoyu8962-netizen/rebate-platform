// B2-03q (D10-565): Kysely access of the estimate port, always on the caller's transaction. Reads
// the greatest stored version; appends the amount and totals rows of a later version (both tables
// are append-only, their primary keys are the last word on idempotency). No SQL clock, no locks.
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import type { PlannedAmount, PlannedTotals, VersionPlan } from '../application/estimate-plan.ts';

export type TotalsRow = Selectable<DB['commission_split_totals']>;

/** The totals row of the greatest commission_version; undefined when the order has none. */
export async function selectLatestTotals(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<TotalsRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('commission_split_totals')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .orderBy('commission_version', 'desc')
    .limit(1)
    .executeTakeFirst();
}

export async function selectVersionAmounts(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  version: number,
): Promise<PlannedAmount[]> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('commission_split_amounts')
    .select(['user_id', 'role', 'base_fen', 'amount_fen'])
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', version)
    .execute();
  return rows.map((row) => ({ ...row, role: row.role as PlannedAmount['role'] }));
}

export interface VersionKey {
  readonly appId: string;
  readonly orderId: string;
  readonly version: number;
  readonly createdAt: Date;
}

export async function insertVersion(
  trx: Transaction<DB>,
  key: VersionKey,
  plan: VersionPlan,
): Promise<void> {
  const app = trx.withSchema('app');
  const row = {
    app_id: key.appId,
    order_id: key.orderId,
    commission_version: key.version,
    created_at: key.createdAt,
  };
  await app
    .insertInto('commission_split_amounts')
    .values(plan.amounts.map((amount) => ({ ...row, ...amount })))
    .execute();
  const totals: PlannedTotals = plan.totals;
  await app
    .insertInto('commission_split_totals')
    .values({ ...row, ...totals })
    .execute();
}
