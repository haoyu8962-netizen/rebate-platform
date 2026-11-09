// B2-04zzr (FU-P7-ORDER-RIGHTS-ROW; BR-FUND-01 P 表 P7 / P8, BR-FUND-02, BR-FUND-08; 编排 D10-1118 /
// D10-1124 / D10-1133): the order_rights row an order sync's platform status signal stands for,
// written by settlement (order_rights' only writer) on the sync transaction, under the order key lock
// orders already holds, before the rebate / clawback handling of the same signal.
//   - P7: from_status SETTLED and event PLATFORM_INVALID (platform_status stays SETTLED) →
//     (INVALID_AFTER_SETTLE, SUCCEEDED), platform_rights_no 'P' || the orders.row_version the sync
//     update wrote (source.sync_row_version, handed over by orders: a blacklist R6 in the same sync
//     may already have bumped the current row; the BR-FUND-08 clawback key P{row_version}). Only a
//     source without it (not built by the sync pipeline) falls back to the current row's version.
//     A new invalid report after a restore is a new sync update, a new row_version, a new row.
//   - P8 punishment: event PLATFORM_PUNISH on PAID / RECEIVED / SETTLED → (PUNISH, SUCCEEDED) with
//     no rights number: one row per order (K-2, D10-346).
//   - anything else (a pre-settlement invalid P6, rights signals, other events) → nothing.
// The row carries no amount or deduction: the money stays with R6 / R8 of the same sync, and the row
// never triggers a second clawback. Idempotency is the K-2 unique index (insertRights ON CONFLICT
// DO NOTHING); a replay of the same report never reaches settlement (content_hash). A SUCCEEDED row
// never makes rights_pending true; it is still recomputed on the same transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { OrderStatusSource, OrderUpdateChange } from '../../orders/index.ts';
import { casRightsPending, computeRightsPending } from '../clawback/clawback-store.ts';
import { readRebateOrder } from '../rebate/infra/rebate-store.ts';
import { insertRights } from './rights-store.ts';

/** order_rights.source of a row written from the order sync's status signal. */
export const SYNC_RIGHTS_SOURCE = 'SYNC';

const PUNISH_FROM: readonly string[] = ['PAID', 'RECEIVED', 'SETTLED'];

export interface SyncRightsPlan {
  readonly type: 'INVALID_AFTER_SETTLE' | 'PUNISH';
  readonly platformRightsNo: string | null;
}

/** The row a sync's status signal writes (pure; rowVersion = orders.row_version after the sync update). */
export function syncRightsOf(
  change: Pick<OrderUpdateChange, 'from_status'>,
  source: Pick<OrderStatusSource, 'event'>,
  rowVersion: number,
): SyncRightsPlan | null {
  if (source.event === 'PLATFORM_INVALID' && change.from_status === 'SETTLED') {
    return { type: 'INVALID_AFTER_SETTLE', platformRightsNo: `P${String(rowVersion)}` };
  }
  if (source.event === 'PLATFORM_PUNISH' && PUNISH_FROM.includes(change.from_status)) {
    return { type: 'PUNISH', platformRightsNo: null };
  }
  return null;
}

/**
 * Writes the sync's order_rights row (if any) on the caller's transaction; the caller holds the
 * order key lock. Returns the plan written (or found already stored), null when the signal writes none.
 */
export async function recordSyncRights(
  trx: Transaction<DB>,
  change: Pick<OrderUpdateChange, 'app_id' | 'order_id' | 'attr_at' | 'from_status'>,
  source: Pick<OrderStatusSource, 'event' | 'sync_row_version'>,
  now: Date,
): Promise<SyncRightsPlan | null> {
  if (source.event !== 'PLATFORM_INVALID' && source.event !== 'PLATFORM_PUNISH') return null;
  const ref = { appId: change.app_id, orderId: change.order_id, attrAt: change.attr_at };
  const row = await readRebateOrder(trx, ref);
  if (row === undefined) throw new Error('settlement sync rights: order not found for app');
  const plan = syncRightsOf(change, source, source.sync_row_version ?? row.row_version);
  if (plan === null) return null;
  await insertRights(trx, {
    appId: ref.appId,
    orderId: ref.orderId,
    type: plan.type,
    platformRightsNo: plan.platformRightsNo,
    source: SYNC_RIGHTS_SOURCE,
    status: 'SUCCEEDED',
    amountFen: null,
    deductionFen: null,
    occurredAt: now,
    now,
  });
  const pending = await computeRightsPending(trx, ref.appId, ref.orderId);
  if (pending !== row.rights_pending) {
    const ok = await casRightsPending(trx, row, pending, now);
    if (!ok) throw new Error('settlement sync rights: rights_pending CAS matched no row');
  }
  return plan;
}
