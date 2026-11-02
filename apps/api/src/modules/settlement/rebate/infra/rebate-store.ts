// B2-04j：返利列的读取、CAS 写入与 rebate 历史（只插入）。只写 settlement 拥有的列：rebate_status、reason、
// hold、hold_reason、settle_period、received_synced_at，以及 row_version / updated_at（BR-FUND-01；02 §18）；
// B2-03r：R7 重算预估的 commission_version + 1 也在这条 CAS 里（BR-CALC-15）。
// 调用方已在本事务里取得子订单 advisory 锁。
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import type { RebateStep, VoidReason } from '../domain/rules.ts';

export type OrderRow = Selectable<DB['orders']>;

export interface OrderRef {
  readonly appId: string;
  readonly orderId: string;
  readonly attrAt: Date;
}

/** 按 (app_id, order_id, attr_at) 读一行（attr_at 进谓词以裁剪分区）。 */
export async function readRebateOrder(
  trx: Transaction<DB>,
  ref: OrderRef,
): Promise<OrderRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', ref.appId)
    .where('order_id', '=', ref.orderId)
    .where('attr_at', '=', ref.attrAt)
    .executeTakeFirst();
}

export interface RebateSet {
  readonly rebate_status?: string;
  readonly reason?: VoidReason;
  readonly hold?: true;
  readonly hold_reason?: 'UNMAPPED_STATUS';
  readonly settle_period?: string;
  readonly received_synced_at?: Date;
  readonly commission_version?: number;
}

export interface RebateCasGuards {
  /** R11 系统 hold：WHERE 另加 hold = false。 */
  readonly unheld?: boolean;
  /** R3a：WHERE 另加 locked = false。 */
  readonly unlocked?: boolean;
  /** R7 推版本：WHERE 另加 commission_version = 旧版本（BR-CALC-15 乐观锁）。 */
  readonly commissionVersion?: number;
}

/**
 * UPDATE … SET …, row_version = v + 1 WHERE app_id AND order_id AND attr_at AND rebate_status = :from
 * AND row_version = :v；返回是否命中一行（0 行 = 并发冲突，由调用方重读后重新判定）。
 */
export async function casUpdateRebate(
  trx: Transaction<DB>,
  current: Pick<OrderRow, 'app_id' | 'order_id' | 'attr_at' | 'rebate_status' | 'row_version'>,
  set: RebateSet,
  guards: RebateCasGuards,
  now: Date,
): Promise<boolean> {
  let query = trx
    .withSchema('app')
    .updateTable('orders')
    .set({ ...set, row_version: current.row_version + 1, updated_at: now })
    .where('app_id', '=', current.app_id)
    .where('order_id', '=', current.order_id)
    .where('attr_at', '=', current.attr_at)
    .where('rebate_status', '=', current.rebate_status)
    .where('row_version', '=', current.row_version);
  if (guards.unheld === true) query = query.where('hold', '=', false);
  if (guards.unlocked === true) query = query.where('locked', '=', false);
  if (guards.commissionVersion !== undefined) {
    query = query.where('commission_version', '=', guards.commissionVersion);
  }
  const result = await query.executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

export async function insertRebateHistory(
  trx: Transaction<DB>,
  order: { readonly app_id: string; readonly order_id: string },
  steps: readonly RebateStep[],
  source: 'sync' | 'system',
  at: Date,
): Promise<void> {
  for (const s of steps) {
    await trx
      .withSchema('app')
      .insertInto('order_status_history')
      .values({
        app_id: order.app_id,
        order_id: order.order_id,
        field: 'rebate',
        from_status: s.from,
        event: s.event,
        to_status: s.to,
        source,
        at,
      })
      .execute();
  }
}
