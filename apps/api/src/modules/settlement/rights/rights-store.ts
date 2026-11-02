// B2-04l: the rows settlement's rights command and R11 admin hold / unhold write, all on the
// caller's transaction (the order_key advisory lock is already held). settlement owns order_rights
// and the rebate columns of orders (hold, hold_reason, rights_pending, row_version / updated_at;
// BR-FUND-01). Always scoped by app_id, naming schema app.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import { sql, type Selectable, type Transaction } from 'kysely';

export type OrderRightsRow = Selectable<DB['order_rights']>;

export interface RightsKey {
  readonly appId: string;
  readonly orderId: string;
  readonly type: string;
  /** null matches null (the dedupe key is NULLS NOT DISTINCT, K-2). */
  readonly platformRightsNo: string | null;
}

/** The stored row of a K-2 key, locked FOR UPDATE; undefined when none. */
export async function findRights(
  trx: Transaction<DB>,
  key: RightsKey,
): Promise<OrderRightsRow | undefined> {
  let query = trx
    .withSchema('app')
    .selectFrom('order_rights')
    .selectAll()
    .where('app_id', '=', key.appId)
    .where('order_id', '=', key.orderId)
    .where('type', '=', key.type);
  query =
    key.platformRightsNo === null
      ? query.where('platform_rights_no', 'is', null)
      : query.where('platform_rights_no', '=', key.platformRightsNo);
  return query.forUpdate().executeTakeFirst();
}

export interface RightsInsert extends RightsKey {
  readonly source: string;
  readonly status: string;
  readonly amountFen: bigint | null;
  readonly deductionFen: bigint | null;
  readonly occurredAt: Date;
  readonly now: Date;
}

/**
 * Inserts one order_rights row; ON CONFLICT on the K-2 key does nothing. Returns the new id, or
 * null when the key already exists (the unique index decides, never a second row).
 */
export async function insertRights(
  trx: Transaction<DB>,
  row: RightsInsert,
): Promise<string | null> {
  const id = randomUUID();
  const inserted = await trx
    .withSchema('app')
    .insertInto('order_rights')
    .values({
      id,
      app_id: row.appId,
      order_id: row.orderId,
      source: row.source,
      type: row.type,
      status: row.status,
      amount_fen: row.amountFen,
      deduction_commission_fen: row.deductionFen,
      occurred_at: row.occurredAt,
      platform_rights_no: row.platformRightsNo,
      created_at: row.now,
      updated_at: row.now,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted?.id ?? null;
}

export interface RightsResult {
  readonly status: string;
  readonly amountFen: bigint | null;
  readonly deductionFen: bigint | null;
  readonly occurredAt: Date;
  readonly now: Date;
}

/** The result of a stored record, in place (same id), CAS on (status, row_version). */
export async function updateRightsResult(
  trx: Transaction<DB>,
  stored: OrderRightsRow,
  result: RightsResult,
): Promise<boolean> {
  const updated = await trx
    .withSchema('app')
    .updateTable('order_rights')
    .set({
      status: result.status,
      amount_fen: result.amountFen,
      deduction_commission_fen: result.deductionFen,
      occurred_at: result.occurredAt,
      row_version: stored.row_version + 1,
      updated_at: result.now,
    })
    .where('app_id', '=', stored.app_id)
    .where('id', '=', stored.id)
    .where('status', '=', stored.status)
    .where('row_version', '=', stored.row_version)
    .executeTakeFirst();
  return (updated.numUpdatedRows ?? 0n) === 1n;
}

/**
 * BR-FUND-06 / 08: WAIT_COMMISSION rows closed as SUCCEEDED once the clawback was written (only
 * `rightsId` when given, else every WAIT_COMMISSION row of the order). Returns the rows closed.
 */
export async function closeWaitingRights(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  rightsId: string | null,
  at: Date,
): Promise<bigint> {
  let query = trx
    .withSchema('app')
    .updateTable('order_rights')
    .set((eb) => ({
      status: 'SUCCEEDED',
      row_version: eb('row_version', '+', 1),
      updated_at: at,
    }))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'WAIT_COMMISSION');
  if (rightsId !== null) query = query.where('id', '=', rightsId);
  const result = await query.executeTakeFirst();
  return result.numUpdatedRows ?? 0n;
}

/** Whether some order_rights row of the order still waits for the union commission. */
export async function hasWaitingRights(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_rights')
    .select('id')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'WAIT_COMMISSION')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export interface OrderCasKey {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly rebate_status: string;
  readonly row_version: number;
}

/** R11: hold / hold_reason, CAS on (rebate_status, row_version, hold); rebate_status unchanged. */
export async function casHold(
  trx: Transaction<DB>,
  key: OrderCasKey & { readonly hold: boolean },
  set: { readonly hold: boolean; readonly hold_reason: string | null },
  at: Date,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({
      hold: set.hold,
      hold_reason: set.hold_reason,
      row_version: key.row_version + 1,
      updated_at: at,
    })
    .where('app_id', '=', key.app_id)
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('rebate_status', '=', key.rebate_status)
    .where('row_version', '=', key.row_version)
    .where('hold', '=', key.hold)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) === 1n;
}

/** One rebate history row of an admin R11 (source admin; settlement owns order_status_history). */
export async function insertAdminRebateHistory(
  trx: Transaction<DB>,
  order: { readonly app_id: string; readonly order_id: string; readonly rebate_status: string },
  event: 'HOLD' | 'UNHOLD',
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_status_history')
    .values({
      app_id: order.app_id,
      order_id: order.order_id,
      field: 'rebate',
      from_status: order.rebate_status,
      event,
      to_status: order.rebate_status,
      source: 'admin',
      at,
    })
    .execute();
}

/**
 * B2-04lb (D10-474 ①): created_at of the order's latest settlement record (greatest seq), or null
 * when it has none. A rights result received before it is answered by it (the union's record
 * already carries the deduction); one received at or after it is not.
 */
export async function readLatestSettlementAt(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<Date | null> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_settlements')
    .select('created_at')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.created_at ?? null;
}

/**
 * B2-04lb (D10-474 ①, D10-483): the deductions (deduction_commission_fen) of the order's successful
 * RIGHTS records the union has not answered yet (answered_at empty). Returned one by one; the
 * caller sums them through @couli/money.
 */
export async function readOpenRightsDeductions(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<readonly bigint[]> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('order_rights')
    .select('deduction_commission_fen')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('type', '=', 'RIGHTS')
    .where('status', '=', 'SUCCEEDED')
    .where('deduction_commission_fen', 'is not', null)
    .where('answered_at', 'is', null)
    .orderBy('id')
    .execute();
  const out: bigint[] = [];
  for (const row of rows) {
    if (row.deduction_commission_fen !== null) out.push(row.deduction_commission_fen);
  }
  return out;
}

/**
 * B2-04lb (D10-483): the union's updated commission (a new estimate on the order sync, or a new
 * settlement record) absorbed the open deductions: answered_at set to `at` (the injected clock) on
 * the sync transaction, so they are never subtracted again. With `receivedBefore`, only the rows
 * received (updated_at) strictly before it (the new record's created_at); every open row when
 * null. Returns the rows answered.
 */
export async function markRightsAnswered(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  receivedBefore: Date | null,
  at: Date,
): Promise<bigint> {
  let query = trx
    .withSchema('app')
    .updateTable('order_rights')
    .set({ answered_at: at })
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('type', '=', 'RIGHTS')
    .where('status', '=', 'SUCCEEDED')
    .where('deduction_commission_fen', 'is not', null)
    .where('answered_at', 'is', null);
  if (receivedBefore !== null) query = query.where('updated_at', '<', receivedBefore);
  const result = await query.executeTakeFirst();
  return result.numUpdatedRows ?? 0n;
}

/**
 * B2-04lb (D10-463 ③): WAIT_COMMISSION rows answered by the union's new commission closed as
 * SUCCEEDED: those received (updated_at) strictly before `before`, every one when `before` is null.
 * Returns the rows closed.
 */
export async function closeAnsweredWaitingRights(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  before: Date | null,
  at: Date,
): Promise<bigint> {
  let query = trx
    .withSchema('app')
    .updateTable('order_rights')
    .set((eb) => ({
      status: 'SUCCEEDED',
      row_version: eb('row_version', '+', 1),
      updated_at: at,
    }))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'WAIT_COMMISSION');
  if (before !== null) query = query.where('updated_at', '<', before);
  const result = await query.executeTakeFirst();
  return result.numUpdatedRows ?? 0n;
}

/** Whether some WAIT_COMMISSION row of the order was received strictly before `before`. */
export async function hasWaitingRightsBefore(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  before: Date,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_rights')
    .select('id')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'WAIT_COMMISSION')
    .where('updated_at', '<', before)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * B2-04lb (D10-474 ①, D10-483): the total deduction still open on the order (answered_at empty),
 * through @couli/money. The union's latest commission replaces the deductions it answered (never
 * subtracted again); the open ones add up (conservative, until the union sends its update).
 */
export async function readOpenDeductionTotal(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<bigint> {
  const deductions = await readOpenRightsDeductions(trx, appId, orderId);
  let total = 0n;
  for (const fen of deductions) total = addFen(total, fen);
  return total;
}

/**
 * B2-03r (BR-FUND-18): readOpenDeductionTotal for many orders of one app, in one statement. Orders
 * without an open deduction are left out of the map. The ids travel as one array parameter: the
 * wallet passes every estimating order of the app.
 */
export async function readOpenDeductionTotals(
  trx: Transaction<DB>,
  appId: string,
  orderIds: readonly string[],
): Promise<ReadonlyMap<string, bigint>> {
  const totals = new Map<string, bigint>();
  if (orderIds.length === 0) return totals;
  const rows = await trx
    .withSchema('app')
    .selectFrom('order_rights')
    .select(['order_id', 'deduction_commission_fen'])
    .where('app_id', '=', appId)
    .where('order_id', '=', sql<string>`any(${[...orderIds]}::uuid[])`)
    .where('type', '=', 'RIGHTS')
    .where('status', '=', 'SUCCEEDED')
    .where('deduction_commission_fen', 'is not', null)
    .where('answered_at', 'is', null)
    .execute();
  for (const row of rows) {
    if (row.deduction_commission_fen === null) continue;
    totals.set(row.order_id, addFen(totals.get(row.order_id) ?? 0n, row.deduction_commission_fen));
  }
  return totals;
}
