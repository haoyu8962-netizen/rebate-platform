// Public surface of the orders module (规划/02 §4.1); other modules import only from this file.
export { recordOrderRights, adminHoldOrder, adminUnholdOrder } from './application/rights-ports.ts';
export type {
  RightsRecordResult,
  AdminHoldResult,
  RightsRecordInput,
  AdminHoldInput,
  RightsCommandPort,
  RebateAdminCommandPort,
  OrderRightsPorts,
} from './application/rights-ports.ts';
export { findOrderForRights } from './infra/rights-order-lookup.ts';
export type {
  RightsOrderLookupInput,
  RightsOrderLookupResult,
} from './infra/rights-order-lookup.ts';
export { readNotifyOrderFacts, readNotifyClaimFacts } from './ports/notify-order-facts.ts';
export type {
  ReadNotifyOrderFactsInput,
  NotifyOrderFacts,
  ReadNotifyClaimFactsInput,
  NotifyClaimFacts,
  NotifyClaimItem,
} from './ports/notify-order-facts.ts';
export { claimEntryPinned } from './domain/claim-entry.ts';
export type { ClaimEntryInput } from './domain/claim-entry.ts';
export { createInviteRewardOrderFacts } from './ports/invite-reward.ts';
export { createSelfPurchaseOrderReader, SELF_PURCHASE_WINDOW_MS } from './ports/self-purchase.ts';
export type { SelfPurchaseOrder, SelfPurchaseOrderReader } from './ports/self-purchase.ts';
export { readSnapshotRetryInput } from './infra/snapshot-retry-input.ts';
// B1-08t：分佣快照补偿重试的纯判定与定时扫描（worker 经 worker-runtime 装配）。
export {
  SNAPSHOT_RETRY_REASONS,
  isSnapshotRetryDue,
  isSnapshotRetryExhausted,
  isSnapshotRetryReason,
  planSnapshotRetry,
  resolveRetryPaidAt,
} from './domain/snapshot-retry.ts';
export type {
  PlanSnapshotRetryInput,
  SnapshotRetryPlan,
  SnapshotRetryReason,
  SnapshotRetrySkipReason,
} from './domain/snapshot-retry.ts';
export {
  SNAPSHOT_RETRY_JOB,
  createSnapshotRetryScheduler,
  handleSnapshotRetry,
} from './jobs/snapshot-retry.ts';
export type { SnapshotRetryDeps, SnapshotRetrySchedulerDeps } from './jobs/snapshot-retry.ts';
export { shouldDeferOrderSource } from './domain/source-shop.ts';
export type { DeferOrderSourceInput } from './domain/source-shop.ts';
export { judgeClaimEvidence } from './domain/claim-evidence.ts';
export type {
  ClaimEvidenceInput,
  ClaimItemEvidence,
  ClaimEvidenceLevel,
} from './domain/claim-evidence.ts';
export { readClaimEvidenceWindow } from './application/claim-evidence.ts';
export type { ClaimEvidencePorts, ClaimEvidenceFactory } from './application/claim-evidence.ts';
export {
  createOrderClaim,
  createOrderClaimIn,
  readClaimSettings,
  listOrderClaims,
} from './application/order-claims.ts';
export type {
  OrderClaimDeps,
  ClaimFailure,
  ClaimResult,
  ClaimListInput,
  ClaimRequest,
} from './application/order-claims.ts';
// B1-08k：第 ⑥ 步分佣快照的纯判定（找回 / 指派 B1-10 复用）与注入的 commission 快照端口类型（B1-08n 接线）。
export { planCommissionSnapshot, snapshotPaidAtSource } from './domain/commission-snapshot.ts';
export type {
  SnapshotEligibility,
  PlanCommissionSnapshotInput,
  CommissionSnapshotPlan,
  CommissionSnapshotCallInput,
} from './domain/commission-snapshot.ts';
export type {
  CommissionSnapshotPort,
  CommissionSnapshotPortResult,
  SnapshotOutcome,
} from './application/commission-snapshot-step.ts';
export { matchOrderSource, parseLinkCode } from './domain/source-backfill.ts';
export type {
  ExactLink,
  LinkLogCandidate,
  MatchOrderSourceInput,
  OrderSourceMatch,
} from './domain/source-backfill.ts';
export { backfillOrderSource } from './application/source-backfill.ts';
export type {
  BackfillOrderSourceInput,
  OrderSourceConfig,
  OrderSourcePorts,
} from './application/source-backfill.ts';
// B1-08q: the production source ports over other modules' raw reads (assembled by app.module).
export {
  BACKFILL_WINDOW_HOURS_KEY,
  backfillWindowHoursOf,
  clickCodeEnabledOf,
  clickCodeKey,
  createOrderSourcePorts,
} from './application/source-ports.ts';
export type { OrderSourceReads, ProductionOrderSourcePorts } from './application/source-ports.ts';
// Task B1-08h: attribution pipeline main transaction (BR-ATTR-01/02/06/07/08/22/25). The lock,
// user attribution and buy_type helpers are shared with B1-08i, claim and admin changes.
export { createOrderPipeline } from './application/pipeline-port.ts';
export type {
  DropReason,
  OrderPipeline,
  OrderPipelineContext,
  OrderPipelinePort,
} from './application/pipeline-port.ts';
export type {
  ImportedOrder,
  OrderPipelineDeps,
  OrderPipelineResult,
  PidRow,
} from './application/pipeline-types.ts';
export { attributeOrderUser } from './application/attribute-user.ts';
export type {
  AttributeUserInput,
  UserAttribution,
  UserCounter,
} from './application/attribute-user.ts';
export {
  classifyBuyType,
  isKnownPidScene,
  parseAttrCode,
  resolveBinding,
} from './domain/attribution.ts';
export type { BindingDecision, BindingRow, BuyTypeDecision } from './domain/attribution.ts';
export { orderContentHash } from './domain/content-hash.ts';
export { planImportState } from './domain/import-state.ts';
export type { ImportHistory, ImportStateDecision } from './domain/import-state.ts';
export { lockOrderKey, orderLockKeyText } from './infra/order-lock.ts';
// Task B1-08l: the shared order list / detail queries (HTTP and later B3-08), already projected.
export {
  createOrderQueries,
  createUnknownOrderFigures,
  OrderQueries,
  OrderQueryError,
} from './application/order-queries.ts';
export type {
  AgentCapableOrderQueries,
  AgentOrderItem,
  AgentOrderSearch,
  AgentOrderSearchResult,
  OwnOrderNumberQuery,
  OrderSubject,
  OrderFilter,
  OrderFigures,
  OrderFiguresReader,
  OrderLinkReader,
  OrderQueryDeps,
} from './application/order-queries.ts';
export { OrdersModule } from './orders.module.ts';
// B1-10j: the admin entry's claim review reads (GET /admin/v1/claims, /admin/v1/claims/{claim_id}).
export { OrdersAdminModule } from './orders-admin.module.ts';
export type { AdminOrderWritePorts, OrdersAdminOptions } from './orders-admin.module.ts';
export type { AdminClaimPorts } from './application/admin-claims.ts';
// B1-10i: the admin entry's order reads (GET /admin/v1/orders, /admin/v1/orders/{order_id}).
export type {
  AdminOrderLinkRecord,
  AdminOrderPorts,
  AdminOrderSplitRecord,
} from './application/admin-orders.ts';
// B1-08n: the worker's order-sync runtime (OrdersModule.forWorker; entry.ts starts it once).
export { orderSyncToken } from './worker-runtime.ts';
export type {
  OrderRebateAssembly,
  OrderRebatePortFactory,
  OrderSyncRebatePort,
  OrderSyncReadPorts,
  OrderSyncRuntime,
} from './worker-runtime.ts';
export type { OrdersModuleOptions, OrdersWorkerOptions } from './orders.module.ts';
// Task B1-08m: the pending-track cards (BR-ATTR-21) — the pure per-attempt selection and the
// shared queries behind GET /v1/orders/pending-tracks and its dismiss, over linking's port.
export {
  PENDING_TRACK_CLAIM_AFTER_MS,
  PENDING_TRACK_LIFETIME_MS,
  selectPendingTracks,
} from './domain/pending-tracks.ts';
export type { PendingTrackOrder, SelectPendingTracksInput } from './domain/pending-tracks.ts';
export {
  DEFAULT_TRACK_COMPLETE_TOLERANCE_SEC,
  PendingTrackError,
  PendingTracks,
  TRACK_COMPLETE_TOLERANCE_KEY,
  createPendingTracks,
} from './application/pending-tracks.ts';
export type { PendingTracksDeps } from './application/pending-tracks.ts';
export { createOrderUpdateStep } from './application/update-step.ts';
export type {
  OrderUpdateDeps,
  OrderUpdateChange,
  OrderStatusSource,
  UnmappedOrderInfo,
} from './application/update-step.ts';
export type { PlatformStatusEvent } from './domain/status-map.ts';
// B1-08zc：平台恢复差错单（BR-FUND-22）的 ref_id / dedupe_key（settlement 的 P9 登记复用）与登记端口形状。
export { platformRestoreDedupeKey, platformRestoreRefId } from './domain/platform-restore.ts';
export type {
  PlatformRestoreResolution,
  PlatformRestoreTrigger,
} from './domain/platform-restore.ts';
export type {
  PlatformRestoreDiffInput,
  PlatformRestoreDiffPort,
  PlatformRestoreDiffResult,
} from './application/platform-restore-step.ts';
// B1-08i（D10-47 / D10-48）：order.attr_param_changed 载荷 changed 里的列名（告警事件与领域事件同经 events 总线）。
export type { OrderAttrParamColumn } from './application/alert-events.ts';
// B1-09b：第 ③ 步黑名单的纯判定与端口形状（BR-ATTR-26；返利端口 onBlacklistHit 的接线在资金线）。
export { planBlacklistHit } from './domain/blacklist.ts';
export type {
  BlacklistDimension,
  BlacklistDisposition,
  BlacklistHitPlan,
  BlacklistMatchInput,
  BlacklistPlan,
  BlacklistRiskAction,
  PlanBlacklistInput,
} from './domain/blacklist.ts';
export type {
  OrderBlacklistDeps,
  OrderBlacklistHit,
  OrderBlacklistHitRecord,
  OrderBlacklistMatch,
  OrderBlacklistPorts,
  OrderBlacklistQuery,
  OrderBlacklistRebatePort,
} from './application/blacklist-step.ts';
export { planOrderUpdate, planOrderSyncColumns } from './domain/update-plan.ts';
export type { OrderUpdatePlan, OrderSyncColumns, UpdateStateInput } from './domain/update-plan.ts';
// B1-27f: the orders section of a personal information copy (read only; assembled by app.module).
export { readPersonalDataCopyOrders } from './application/personal-data-copy-read.ts';
export type {
  PersonalDataCopyOrderRow,
  PersonalDataCopyOrderSubject,
} from './application/personal-data-copy-read.ts';
// B1-01zzi: the worker's fund metric (open order_sync_pending rows per reason; read only).
export { readOrderSyncPendingOpen } from './application/metrics-read.ts';
// B2-11a: BR-WDR-29 ④⑤⑥ — the member's self-purchase and received sub-orders (read only).
export { createWithdrawRiskOrderReader } from './ports/withdraw-risk.ts';
export type {
  WithdrawRiskOrderReader,
  WithdrawRiskReceivedOrder,
  WithdrawRiskSelfOrder,
} from './ports/withdraw-risk.ts';
// B2-04l: CLAWBACK_NO_COMMISSION pending rows (order_sync_pending, written by orders) for settlement's clawback.
export {
  CLAWBACK_NO_COMMISSION_REASON,
  CLAWBACK_PENDING_RESOLUTION_NOTE,
  createClawbackPendingPort,
  openClawbackNoCommissionPending,
  resolveClawbackNoCommissionPending,
} from './application/clawback-pending.ts';
export type {
  ClawbackPendingOpenInput,
  ClawbackPendingPort,
  ClawbackPendingResolveInput,
} from './application/clawback-pending.ts';
