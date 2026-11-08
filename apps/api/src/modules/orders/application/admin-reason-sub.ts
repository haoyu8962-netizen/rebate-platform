// B1-09v: the console's 改子原因 (POST /admin/v1/orders/{order_id}/reason-sub; contract
// adminSetOrderReasonSub, CT-24zw; 08 BR-TEXT-05 子原因 写入来源 ② 后台人工; D10-818, D10-819 ③).
// Permission point order.claim (no step-up) is the HTTP layer's (http/admin/order-actions
// .controller.ts); this use case gets an authorised actor. One transaction per request:
//   ① a non-UUID order_id, or no order of the actor's app → 20001 [order_id] (no 404);
//   ② first statement the sub-order advisory lock (order-lock.ts), then SELECT … FOR UPDATE reread;
//   ③ the choice judged on the reread: `none`, or a sub-reason of the order's current reason
//      (PUNISH: its 12; REFUND: IN_SALE / AFTER_SETTLE; RIGHTS: AFTER_SALE); any other value, or any
//      value while the reason is not PUNISH / REFUND / RIGHTS (null included) → 20001 [reason_sub];
//      expected_row_version ≠ row_version → 20902 order;
//   ④ settlement writes orders.reason_sub (none → null) and reason_sub_manual = true through its
//      port (missing port → ORDERS_RIGHTS_PORT_UNAVAILABLE; orders never writes those columns);
//      its cas_conflict rolls back and answers 20902 order. Amounts, reason, statuses and hold are
//      not touched; no status history, no event;
//   ⑤ only after the port answered applied: one audit record order_reason_sub_set on the same
//      transaction, target `orders:<order_id>`, before / after the reason_sub (`none` as null), the
//      flag and the order's reason; no personal information.
// The answer is the order detail as it is now (B1-10i's read, after the commit).
import type { OrderReasonSub, Schema } from '@couli/contracts-ts';
import type { Selectable } from 'kysely';
import type { DB } from '@couli/db';
import { isUuid } from '../domain/admin-claim-view.ts';
import { PUNISH_REASON_SUBS, REASON_SUB_NONE } from '../domain/rights-import.ts';
import { readOrderLockTarget, rereadOrderForUpdate } from '../infra/admin-hold-store.ts';
import { createAdminOrderReads } from '../infra/admin-order-reads.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import type { AdminHoldDeps } from './admin-hold.ts';
import { AdminOrders } from './admin-orders.ts';
import { adminSetOrderReasonSub } from './rights-ports.ts';

/** The audit action of 改子原因 (admin/domain/audit-log-view.ts names it). */
export const ORDER_REASON_SUB_AUDIT_ACTION = 'order_reason_sub_set';

/** The sub-reasons each parent reason allows (08 BR-TEXT-05 子原因表; enum order_reason_sub). */
const SUBS_OF_REASON: Readonly<Record<string, readonly OrderReasonSub[]>> = Object.freeze({
  PUNISH: PUNISH_REASON_SUBS,
  REFUND: ['IN_SALE', 'AFTER_SETTLE'],
  RIGHTS: ['AFTER_SALE'],
});

export interface AdminReasonSubActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminReasonSubCommand {
  readonly orderId: string;
  /** As sent (the route schema has checked it is a sub-reason or `none`); judged again here. */
  readonly reason_sub: string;
  readonly expected_row_version: number;
}

export type AdminReasonSubOutcome =
  | { readonly code: 0; readonly data: Schema<'AdminOrderDetail'> }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20902; readonly data: { readonly resource: 'order' } };

/**
 * The stored value of a choice under `reason`: null for `none`, the sub-reason when it belongs to
 * the reason; undefined when the choice is refused (another reason's, unknown, or a reason without
 * sub-reasons, null included).
 */
export function reasonSubChoice(
  reason: string | null,
  value: string,
): { readonly stored: OrderReasonSub | null } | undefined {
  const subs = reason === null ? undefined : SUBS_OF_REASON[reason];
  if (subs === undefined) return undefined;
  if (value === REASON_SUB_NONE) return { stored: null };
  const found = subs.find((sub) => sub === value);
  return found === undefined ? undefined : { stored: found };
}

const fieldsError = (field: string): AdminReasonSubOutcome => ({
  code: 20001,
  data: { fields: [field] },
});
const CONFLICT: AdminReasonSubOutcome = { code: 20902, data: { resource: 'order' } };

/** Thrown inside the transaction to roll it back; answered outside. */
class ReasonSubRefusal extends Error {
  readonly outcome: AdminReasonSubOutcome;

  constructor(outcome: AdminReasonSubOutcome) {
    super('orders: admin reason_sub refused');
    this.name = 'ReasonSubRefusal';
    this.outcome = outcome;
  }
}

function auditSide(order: Selectable<DB['orders']>, reasonSub: string | null, manual: boolean) {
  return { reason: order.reason, reason_sub: reasonSub, reason_sub_manual: manual };
}

/** Operational failures (port, audit, database) propagate and roll the transaction back. */
export async function setOrderReasonSub(
  deps: AdminHoldDeps,
  actor: AdminReasonSubActor,
  command: AdminReasonSubCommand,
): Promise<AdminReasonSubOutcome> {
  // A non-UUID order_id names no order: answered before the database (never cast there).
  if (!isUuid(command.orderId)) return fieldsError('order_id');
  const orderId = command.orderId.toLowerCase();
  const target = await readOrderLockTarget(deps.db, actor.appId, orderId);
  if (target === undefined) return fieldsError('order_id');

  try {
    await deps.db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, target.platform, target.sub_order_id);
      const before = await rereadOrderForUpdate(trx, actor.appId, orderId);
      if (before === undefined) throw new ReasonSubRefusal(fieldsError('order_id'));
      const choice = reasonSubChoice(before.reason, command.reason_sub);
      if (choice === undefined) throw new ReasonSubRefusal(fieldsError('reason_sub'));
      if (before.row_version !== command.expected_row_version) {
        throw new ReasonSubRefusal(CONFLICT);
      }
      const result = await adminSetOrderReasonSub(trx, deps.ports, {
        before,
        expected_row_version: command.expected_row_version,
        reason_sub: choice.stored,
        now: deps.clock.now(),
      });
      // Whatever the port may have done before refusing is rolled back with the transaction.
      if (result.kind !== 'applied') throw new ReasonSubRefusal(CONFLICT);
      await deps.auditOn(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: ORDER_REASON_SUB_AUDIT_ACTION,
        target: `orders:${before.order_id}`,
        before: auditSide(before, before.reason_sub, before.reason_sub_manual),
        after: auditSide(before, choice.stored, true),
        ip: actor.ip,
      });
    });
  } catch (error) {
    if (error instanceof ReasonSubRefusal) return error.outcome;
    throw error;
  }

  const details = new AdminOrders({ ...deps.details, reads: createAdminOrderReads(deps.db) });
  return { code: 0, data: await details.detail(actor.appId, orderId, undefined) };
}
