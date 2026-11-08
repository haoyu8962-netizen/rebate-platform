// B2-15b: value types of the payment domain (08 BR-PAY-01 / 02; contracts/enums/pay.yaml).
// Types only: the values live in the contract enums and in the rule tests.

/** Collection channel (enum pay_channel, BR-PAY-01); unrelated to payout_channel. */
export type PayChannelCode = 'wechat_pay' | 'alipay';

/**
 * Native app platforms a business type can be sold on (BR-PAY-01: the three apps; client_platform
 * without h5 / admin, which never place an order, BR-PAY-01 ②).
 */
export type PayPlatform = 'ios' | 'android' | 'harmony';

/**
 * data.reason of 30901 (enum pay_unavailable_reason, BR-PAY-01 ④), in the order the checks run:
 * pay_disabled → channel_disabled → platform_not_allowed → biz_not_sellable (task B2-15b §9.3).
 */
export type PayUnavailableReason =
  'pay_disabled' | 'channel_disabled' | 'platform_not_allowed' | 'biz_not_sellable';

/** pay_orders.status (enum pay_order_status, BR-PAY-02; specs/state-machines/pay-order.yaml). */
export type PayOrderStatus = 'PENDING' | 'PAID' | 'CLOSED';

/** The queue of the payment jobs (platform/queue/catalog.ts, worker entry). */
export type PayQueueName = 'pay';

/**
 * Job names inside queue `pay` (task B2-15b §9.8 / §9.9, B2-15c §9.4 ～ §9.7; handlers in
 * jobs/pay-jobs.ts from B2-15c on, order.close in B2-15d):
 * order.query (singletonKey `order.query:<pay_order_id>:returned` for the client-return query,
 * `order.query:<pay_order_id>:t<seconds>` for a slot of pay.query_schedule),
 * order.close (singletonKey `order.close:<pay_order_id>`),
 * biz.reconcile (singletonKey `biz:<app_id>:<biz_type>:<biz_ref>`, the business object's fulfilment),
 * refund.query (B2-15e: one refund query of a PROCESSING refund, payload RefundQueryPayload; the
 * same result handler as a refund notification, BR-PAY-06 ④),
 * bill.recon (B2-15j: the T+1 reconciliation of one app, payload PayBillReconPayload; the handler
 * derives the bill date D−1 at +08:00 from the Clock, BR-PAY-07).
 */
export type PayJobName =
  'order.query' | 'order.close' | 'biz.reconcile' | 'refund.query' | 'bill.recon';

/** pay_refunds.status (enum pay_refund_status; specs/state-machines/pay-refund.yaml). */
export type PayRefundStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED';

/** pay_refunds.target_type (enum pay_refund_target_type, BR-PAY-06 ①). */
export type PayRefundTargetType = 'pay_order' | 'pay_anomaly';

/** pay_refunds.reason_code (enum pay_refund_reason, BR-PAY-06 细则 默认值). */
export type PayRefundReason =
  'USER_REQUEST' | 'DUPLICATE_PAYMENT' | 'ANOMALY_RECEIPT' | 'RECON_DIFF' | 'OTHER';

/** pay_fulfillments.state (D10-168): the business object's entitlement as last recomputed. */
export type PayFulfillmentState = 'none' | 'active' | 'revoked';
