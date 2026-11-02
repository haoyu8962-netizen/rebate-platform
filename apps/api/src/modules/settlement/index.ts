export { SettlementAdminModule, SettlementModule, REBATE_PORT } from './settlement.module.ts';
export { createRebatePort } from './rebate/application/rebate.ts';
export { IllegalTransition, RebateError } from './rebate/application/errors.ts';
export type { RebateErrorCode } from './rebate/application/errors.ts';
export type {
  RebatePort,
  RebateDependencies,
  RebateOrderRef,
  RebateChangeInput,
  RebateHoldAudit,
  PrecreditEvent,
} from './rebate/application/rebate.ts';
export { createPendingEarningsSource } from './reads/pending-earnings.ts';
export type {
  PendingEarningsSource,
  PendingEarningsDependencies,
  PendingSnapshot,
  PendingSnapshotInput,
  UserPendingEarnings,
  AppPendingEarnings,
} from './reads/pending-earnings.ts';
// B1-09p: the per-order figures behind orders' OrderFiguresReader (read only; app.module).
export { createOrderFiguresReader } from './reads/order-figures.ts';
export type {
  OrderFiguresAppealRead,
  OrderFiguresDependencies,
  OrderFiguresLedgerEntry,
  OrderFiguresLedgerRead,
  OrderFiguresLedgerSelection,
  OrderFiguresSource,
  OrderFiguresSubject,
  OrderFiguresValue,
} from './reads/order-figures.ts';
// B2-13a: the earnings dashboard's order facts (BR-FUND-25; read only, for ledger's port).
export { createEarningsOrdersSource } from './reads/earnings.ts';
export type {
  EarningsOrders,
  EarningsOrdersDependencies,
  EarningsOrdersInput,
  EarningsOrdersSource,
  EarningsOwnOrder,
  EarningsReferralOrder,
} from './reads/earnings.ts';
// B2-04zc: the wallet ledger's order links (order_key → order_id; read only, for ledger's port).
export { readOrderIdsByKey } from './reads/wallet-ledger.ts';
export type { OrderIdsByKeyInput } from './reads/wallet-ledger.ts';
// B2-04la: the attribution ports R3 / R3b for orders (claim approval, admin assignment).
export { createAttributionRebatePort } from './attribution/attribution.ts';
export type {
  AttributionInput,
  AttributionRebateDependencies,
  AttributionRebatePort,
} from './attribution/attribution.ts';
// B1-01zzi: the worker's fund metrics (failed bill jobs, PARTIAL batches, held shares; read only).
export { readSettlementFundMetrics } from './application/metrics-read.ts';
export type { SettlementFundMetrics } from './application/metrics-read.ts';
// B2-04l: orders' rights ports (rights.record; rebate.adminHold / adminUnhold, R11).
export { createRebateAdminCommandPort, createRightsCommandPort } from './rights/index.ts';
export type { RebateAdminDependencies, RightsCommandDependencies } from './rights/index.ts';
// B1-10n: what the worker's rights port and sync hook are assembled from (R8 / R9 / R9b).
export { createClawbackOrder } from './clawback/index.ts';
export type { ClawbackDependencies, ClawbackOrder } from './clawback/index.ts';
export { createBeneficiaryGate } from './credit/index.ts';
// B2-04zj (D10-583): the settlement record port (order_settlements' one writer, BR-FUND-09).
export { createSettlementRecords } from './settlements/index.ts';
export type {
  ApiSettlementInput,
  ApiSettlementResult,
  SettlementOrderRef,
  SettlementRecords,
  SettlementRecordsDependencies,
} from './settlements/index.ts';
// B2-04ze (D10-443): the worker entry's settle queue (bill seed, due batch scan, handler).
export {
  createSettleJobHandler,
  createSettleRunStore,
  scanDueBatches,
  scheduleBatchExecute,
  scheduleSettleBill,
  seedSettleBills,
  settleBatchExecuteJobKey,
  settleBillJobKey,
  settleBillRunAt,
} from './worker/index.ts';
export type {
  SettleBatchExecuteJobInput,
  SettleBatchExecuteJobPayload,
  SettleBatchScanOptions,
  SettleBillJobInput,
  SettleBillJobPayload,
  SettleBillRunState,
  SettleBillSeedOptions,
  SettleJobHandlerDependencies,
  SettleJobName,
  SettleQueueName,
  SettleRunStore,
  SettleScheduleLogger,
  SettlementConfigReader,
  SettlementWorkerPorts,
} from './worker/index.ts';
// B2-04zg (D10-476): the catch-up of the monthly bill.
export {
  createSettleCatchUpStore,
  seedSettleBillCatchUp,
  settleBillCatchUpPeriod,
} from './worker/index.ts';
export type {
  SettleBillCatchUpOptions,
  SettleBillCatchUpPeriod,
  SettleBillCatchUpState,
  SettleCatchUpStore,
} from './worker/index.ts';
