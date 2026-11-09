// B2-04zzs (FU-CLAWBACK-REASON-CHECK; 08 BR-TEXT-05 细则「写入来源」①, BR-FUND-08 细则「sub_type 与订单原因码」;
// 编排 D10-1126 ①, D10-1133 ④, D10-1169 ③): the order reason (orders.reason, and the reason the
// order.clawed_back / order.invalidated events carry) of a full rights result and of a whole-order
// refund. Pure: no read, no write, no clock. Only the display reason and the REFUND sub-reason it
// implies: amounts, the clawback cause (still RIGHTS / COMMISSION / PARTIAL_REFUND), sub_type,
// uniq_keys, transitions and restore eligibility are decided elsewhere and never here.
// - Taobao rights with the union's timing (earning_time known to the caller, null or a time):
//   earning_time present → REFUND / AFTER_SETTLE; earning_time and received_at both empty →
//   REFUND with no sub-reason (D10-1172: Taobao order reports carry no receipt time, so an empty
//   received_at does not tell before / after the receipt); received_at after the rights record's
//   time → REFUND / IN_SALE; received_at at or before it, no settlement → RIGHTS (the sub-reason
//   AFTER_SALE follows from reason-sub.ts).
// - Taobao rights without timing (an import, or a record written without the union's timing) and
//   every other platform: RIGHTS, as before (默认值，任务输出列出).
// - A waiting rights record answered by a new settlement record of 0 (a credited order): Taobao →
//   REFUND / AFTER_SETTLE (a credited Taobao order was settled when the rights happened); other
//   platforms → RIGHTS.
// - A refund to a remaining quantity of 0 (BR-CALC-15 整单失效): REFUND with no sub-reason.
import type { OrderReasonSub } from '@couli/contracts-ts';

/** The order reason a full rights result or a whole-order refund writes. */
export type RightsReasonDecision =
  | { readonly reason: 'RIGHTS' }
  | { readonly reason: 'REFUND'; readonly refundSub: OrderReasonSub | null };

const RIGHTS: RightsReasonDecision = Object.freeze({ reason: 'RIGHTS' });

/** The union's timing of a Taobao rights record (earning_time as the adapter parsed it). */
export interface RightsTiming {
  /** Taobao earning_time; null: the union reported none (not settled when the rights happened). */
  readonly earningAt: Date | null;
}

export interface RightsReasonInput {
  readonly platform: string;
  /** orders.received_at of the order the record is against. */
  readonly receivedAt: Date | null;
  /** The rights record's own time (order_rights.occurred_at). */
  readonly occurredAt: Date;
  /** Absent: the caller does not know the union's timing → RIGHTS. */
  readonly timing?: RightsTiming | undefined;
}

/** BR-TEXT-05 ①: the reason of a successful full rights record. */
export function rightsReasonOf(input: RightsReasonInput): RightsReasonDecision {
  if (input.platform !== 'taobao' || input.timing === undefined) return RIGHTS;
  if (input.timing.earningAt !== null) return { reason: 'REFUND', refundSub: 'AFTER_SETTLE' };
  const received = input.receivedAt;
  if (received === null) return { reason: 'REFUND', refundSub: null };
  if (received.getTime() > input.occurredAt.getTime()) {
    return { reason: 'REFUND', refundSub: 'IN_SALE' };
  }
  return RIGHTS;
}

/** BR-FUND-08 ③ answered by a settlement of 0 on a credited order (the full-rights row). */
export function answeredRightsReasonOf(platform: string): RightsReasonDecision {
  return platform === 'taobao' ? { reason: 'REFUND', refundSub: 'AFTER_SETTLE' } : RIGHTS;
}

/** BR-CALC-15: both columns known, quantity positive, nothing left. */
export function remainingQuantityZero(order: {
  readonly quantity: number | null;
  readonly refunded_quantity: number | null;
}): boolean {
  if (order.quantity === null || order.refunded_quantity === null) return false;
  if (order.quantity <= 0) return false;
  return order.quantity - order.refunded_quantity <= 0;
}

/** The whole-order refund's reason: REFUND, no sub-reason (D10-1169 ③). */
export const WHOLE_REFUND_REASON: RightsReasonDecision = Object.freeze({
  reason: 'REFUND',
  refundSub: null,
});
