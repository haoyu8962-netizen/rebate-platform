// Public surface of the payment module (apps/api/AGENTS.md: the only import point for other
// modules). The Nest module for the api and worker entries (B2-15b, B2-15c), the ports and their
// types; no table of this module is reachable from here.
export { PaymentModule, PAY_JOBS } from './payment.module.ts';
export type { PaymentAdminOptions, PaymentModuleOptions } from './payment.module.ts';
export { createPayJobHandler } from './jobs/pay-jobs.ts';
export type { PayJobDeps, PayLedgerPort } from './jobs/pay-jobs.ts';
export { PAY_ORDER_PAID_EVENT } from './application/pay-settlement.ts';
// B2-15e: the refund success event and its payload shape (02 §11 pay_refund.succeeded, D10-349).
export { PAY_REFUND_SUCCEEDED_EVENT } from './application/pay-refund-result.ts';
export type { PayRefundSucceededPayload } from './application/pay-refund-result.ts';
export type { NotifyAnswer } from './application/pay-notifications.ts';
export { PayChannelSet, PayChannelUnavailable } from './application/pay-channel.ts';
export { certSn, publicKeyFromCert, rootCertSn } from './infra/channels/alipay/cert-sn.ts';
export { createBizRegistry, TEST_ITEM_BIZ_TYPE } from './application/biz-registry.ts';
export type {
  AlipayLaunch,
  PayChannel,
  PayChannelIdentity,
  PayCloseResult,
  PayCreateOrderInput,
  PayCreateOrderResult,
  PayLaunch,
  PayNotificationResult,
  PayQueryResult,
  PayRawNotification,
  PayTradeState,
  WechatLaunch,
} from './application/pay-channel.ts';
export type {
  BizFulfillmentHandler,
  BizPrice,
  BizPriceInput,
  BizReconcileInput,
  BizTypeEntry,
  BizTypeRegistry,
} from './application/biz-registry.ts';
export type {
  PayChannelCode,
  PayFulfillmentState,
  PayJobName,
  PayOrderStatus,
  PayPlatform,
  PayQueueName,
  PayRefundReason,
  PayRefundStatus,
  PayRefundTargetType,
  PayUnavailableReason,
} from './domain/types.ts';
export {
  BIZ_RECONCILE_JOB,
  ORDER_CLOSE_JOB,
  ORDER_QUERY_JOB,
  PAY_QUEUE,
  REFUND_QUERY_JOB,
  bizReconcileKey,
  orderCloseKey,
  orderQueryReturnedKey,
  orderQueryScheduledKey,
  refundQueryKey,
} from './jobs/names.ts';
export type {
  BizReconcilePayload,
  OrderClosePayload,
  OrderQueryPayload,
  OrderQueryReturnedPayload,
  OrderQueryScheduledPayload,
  RefundQueryPayload,
} from './jobs/names.ts';
