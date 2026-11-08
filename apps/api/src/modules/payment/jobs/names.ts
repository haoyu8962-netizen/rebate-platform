// B2-15b / B2-15c: the queue and job names of the payment module (task B2-15b §9.8 ～ §9.10,
// B2-15c §9.4 ～ §9.7; D-PAY-11). Only the names, payloads and singleton keys live here; the
// handlers are in ./pay-jobs.ts (order.query, biz.reconcile, and order.close through
// application/pay-close.ts, B2-15d; bill.recon through application/pay-recon.ts, B2-15j),
// registered by the worker entry. Also compiled by the `test` project: erasable syntax only.
import type { JobPayload } from '../../platform/index.ts';
import type { PayChannelCode, PayJobName, PayQueueName } from '../domain/types.ts';

/** platform/queue/catalog.ts entry `pay` (exclusive: one queued or active job per singletonKey). */
export const PAY_QUEUE: PayQueueName = 'pay';

export const ORDER_QUERY_JOB: PayJobName = 'order.query';
export const ORDER_CLOSE_JOB: PayJobName = 'order.close';
export const BIZ_RECONCILE_JOB: PayJobName = 'biz.reconcile';
export const REFUND_QUERY_JOB: PayJobName = 'refund.query';
/** B2-15j: the T+1 reconciliation of one app's channel bills (BR-PAY-07). */
export const BILL_RECON_JOB: PayJobName = 'bill.recon';

/** The client came back from the channel SDK (BR-PAY-03 细则, one query; B2-15b). */
export interface OrderQueryReturnedPayload extends JobPayload {
  readonly app_id: string;
  readonly pay_order_id: string;
  readonly trigger: 'returned';
}

/**
 * A slot of `pay.query_schedule` (BR-PAY-04; B2-15c). The order is named by its out_trade_no, not
 * its id: pgboss rows are inspected by the text of their data, and a scheduled query must not be
 * mistaken for a job a user action enqueued (B2-15b's cancel leaves order.close as the only job
 * naming the order). The handler reads the order by (app_id, out_trade_no), unique in pay_orders.
 */
export interface OrderQueryScheduledPayload extends JobPayload {
  readonly app_id: string;
  readonly out_trade_no: string;
  readonly trigger: 'scheduled';
}

/** Payload of `order.query`: which order to query and what triggered the query. */
export type OrderQueryPayload = OrderQueryReturnedPayload | OrderQueryScheduledPayload;

/** Payload of `order.close`: which order enters the close flow and why (BR-PAY-05). */
export interface OrderClosePayload extends JobPayload {
  readonly app_id: string;
  readonly pay_order_id: string;
  /** user_cancel: POST …/cancel (B2-15b); expired: the expire_at query found it unpaid (B2-15c). */
  readonly close_reason: 'user_cancel' | 'expired';
}

/** Payload of `biz.reconcile`: the business object whose entitlement is recomputed (D10-168). */
export interface BizReconcilePayload extends JobPayload {
  readonly app_id: string;
  readonly biz_type: string;
  readonly biz_ref: string;
  /** The order whose settlement enqueued the job (tracing only; the facts are re-read). */
  readonly pay_order_id: string;
}

/**
 * B2-15e: payload of `refund.query` — the refund to query, by id (BR-PAY-06 ④ ⑤). Enqueued with a
 * delay in the same transaction that creates the refund (with its idempotency record and the
 * amount it holds), before the channel is called; the refund is submitted only after that commit
 * (D10-351 ③), so a refund whose submission never answered is still queried. The handler queries
 * the channel with the refund's own out_refund_no, keeps a pay_query_attempts row (kind
 * refund_query) and hands the answer to the same result handler as a refund notification. It never
 * submits the refund again (结果未知时只查询; resubmitting the same number waits for BR-PAY-09).
 */
export interface RefundQueryPayload extends JobPayload {
  readonly app_id: string;
  readonly pay_refund_id: string;
}

/**
 * B2-15j: payload of `bill.recon` — the T+1 reconciliation of one app (BR-PAY-07). bill_date is the
 * bill day to reconcile (YYYY-MM-DD, +08:00); the daily run enqueued by the previous one carries
 * it, so a retry or a replay after midnight still reconciles that day. Without it the handler
 * takes the accounting day before clock.now() (@couli/domain): a run at 01:00 +08:00 (UTC still
 * the day before) and one at 10:00 +08:00 reconcile the same day. pay_channel is set only on a
 * catch-up run of one channel whose bill was not available yet (application/pay-recon.ts).
 */
export interface PayBillReconPayload extends JobPayload {
  readonly app_id: string;
  readonly bill_date?: string;
  readonly pay_channel?: PayChannelCode;
}

/** singletonKey of the client-return query: one queued or active per order. */
export function orderQueryReturnedKey(payOrderId: string): string {
  return `${ORDER_QUERY_JOB}:${payOrderId}:returned`;
}

/** singletonKey of one scheduled slot: whole seconds after the order's creation. */
export function orderQueryScheduledKey(payOrderId: string, slotSeconds: number): string {
  return `${ORDER_QUERY_JOB}:${payOrderId}:t${slotSeconds}`;
}

/** singletonKey of the close job: one queued or active per order. */
export function orderCloseKey(payOrderId: string): string {
  return `${ORDER_CLOSE_JOB}:${payOrderId}`;
}

/**
 * singletonKey of a close run the close flow enqueues for itself (B2-15d, task §9.3): the run's
 * instant in whole epoch seconds. It differs from orderCloseKey, so the next run is accepted while
 * the current one is still active (queue pay is exclusive per key); and every chain of one order
 * computes the same instants, so a cancel chain and an expiry chain merge into one.
 */
export function orderCloseRunKey(payOrderId: string, runAt: Date): string {
  return `${ORDER_CLOSE_JOB}:${payOrderId}:at${Math.ceil(runAt.getTime() / 1000)}`;
}

/** singletonKey of the fulfilment job: one queued or active per business object (serial per object); app_id keeps the brands apart. */
export function bizReconcileKey(appId: string, bizType: string, bizRef: string): string {
  return `biz:${appId}:${bizType}:${bizRef}`;
}

/** B2-15e: singletonKey of one refund query slot: whole seconds after the refund's creation. */
export function refundQueryKey(payRefundId: string, slotSeconds: number): string {
  return `${REFUND_QUERY_JOB}:${payRefundId}:t${slotSeconds}`;
}

/**
 * B2-15j: singletonKey of the daily reconciliation of one app: the bill day it reconciles. A run
 * enqueued again for the same day merges into the queued one (queue pay is exclusive per key).
 */
export function billReconKey(appId: string, billDate: string): string {
  return `${BILL_RECON_JOB}:${appId}:${billDate}`;
}

/**
 * B2-15j: singletonKey of a catch-up run of one channel's bill day, by its run instant in whole
 * epoch seconds: distinct from the daily key (held while the daily run is active) and from the
 * catch-up that enqueues the next one, while runs computed for the same instant merge.
 */
export function billReconCatchUpKey(
  appId: string,
  billDate: string,
  payChannel: PayChannelCode,
  runAt: Date,
): string {
  return `${billReconKey(appId, billDate)}:${payChannel}:at${Math.ceil(runAt.getTime() / 1000)}`;
}
