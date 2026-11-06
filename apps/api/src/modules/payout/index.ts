export { validateWithdrawal, withdrawalRules } from './domain/withdraw-rules.ts';
export type {
  WithdrawRuleInput,
  WithdrawLimits,
  WithdrawUsage,
  WithdrawBlock,
  WithdrawRuleSummary,
} from './domain/withdraw-rules.ts';
export { validateLockedWithdrawal } from './domain/withdraw-locked.ts';
export { generateOutBizNo } from './domain/out-biz-no.ts';
export {
  createWithdrawRules,
  readWithdrawInput,
  readWithdrawLimits,
  readWithdrawEnabled,
  createDefaultFeeTaxCalculator,
} from './application/withdraw-rules.ts';
// B2-08c (BR-WDR-20): the configured tax calculator (app.module hands it to the withdrawal rules).
export {
  createFeeTaxCalculator,
  cumulativeTaxFen,
  dueTaxFen,
  flatRateTaxFen,
  mulDivRoundHalfUp,
  taxRuleVersion,
} from './application/fee-tax-calculator.ts';
export type {
  CumulativeTaxInput,
  FeeTaxCalculatorOptions,
  FeeTaxLogger,
  TaxBracket,
  TaxConfig,
  TaxMethod,
} from './application/fee-tax-calculator.ts';
export type {
  WithdrawRulesOptions,
  WithdrawRulesService,
  WithdrawActor,
  ReverifyGatePort,
  PayoutConfigPort,
  FeeTaxCalculator,
  WithdrawUsageReader,
  WithdrawHold,
} from './application/withdraw-rules.ts';
export {
  createWithdrawApply,
  isWithdrawAccepted,
  AUTO_PAYOUT_KEY,
} from './application/withdraw-apply.ts';
export type {
  WithdrawApplyOptions,
  WithdrawApplyService,
  WithdrawApplyCommand,
  WithdrawApplyResult,
  WithdrawAccepted,
  WithdrawRefused,
  WithdrawBlockedHits,
  WithdrawPayeeSnapshot,
} from './application/withdraw-apply.ts';
export { createWithdrawUsageReader } from './infra/withdraw-usage.ts';
export { createWithdrawHoldsReader } from './infra/withdraw-holds.ts';
export { holdActive } from './application/withdraw-rules.ts';
export { PayoutAdminModule, PayoutModule } from './payout.module.ts';
export type {
  PayoutAdminOptions,
  PayoutModuleOptions,
  PayoutProcessOptions,
} from './payout.module.ts';
// B2-06f: PAYOUT_MODE and the payout process's runtime (entry.ts resolves and starts it).
export { resolvePayoutMode } from './payout-mode.ts';
export type {
  PayoutLiveCredentialEnvName,
  PayoutLiveCredentials,
  PayoutMode,
  PayoutModeDecision,
  PayoutModeEnvName,
} from './payout-mode.ts';
export { payoutRuntimeToken } from './payout-runtime.ts';
export type { PayoutRuntime, PayoutStarted } from './payout-runtime.ts';
export { WITHDRAW_RULES, WITHDRAW_APPLY, WITHDRAW_STEP_UP, WITHDRAW_READS } from './tokens.ts';
export type { WithdrawStepUp } from './http/public/withdrawals.controller.ts';
export {
  createWithdrawSwitchCheck,
  isWithdrawalApplication,
} from './application/withdraw-switch-check.ts';
export type { WithdrawSwitchCheckOptions } from './application/withdraw-switch-check.ts';
export {
  createWithdrawalCommands,
  WithdrawalConflictError,
} from './application/withdrawal-commands.ts';
export type {
  WithdrawalAttemptsPort,
  WithdrawalCommands,
  WithdrawalCommandsOptions,
  WithdrawalCommand,
  RejectWithdrawalCommand,
  WithdrawalCommandResult,
} from './application/withdrawal-commands.ts';
export { createWithdrawHolds, releaseWithdrawHoldsBySource } from './application/withdraw-holds.ts';
export { createWithdrawalInFlightReader } from './application/withdrawal-in-flight.ts';
export { createWentNegativeConsumer, WENT_NEGATIVE_CONSUMER } from './application/went-negative.ts';
export type { WentNegativeConsumer, WentNegativeOptions } from './application/went-negative.ts';
export { createBalanceRecoveredHook } from './application/balance-recovered.ts';
export type { BalanceRecoveredHookOptions } from './application/balance-recovered.ts';
export type {
  WithdrawHolds,
  WithdrawHoldsOptions,
  AddWithdrawHold,
  ReleaseWithdrawHoldsBySource,
} from './application/withdraw-holds.ts';
export type { WithdrawalReaders } from './application/withdrawal-in-flight.ts';
export type { AutoPayoutPorts, PayoutWorkerOptions } from './payout.module.ts';
export {
  projectWithdrawalSummary,
  projectWithdrawalDetail,
  readWithdrawalForUser,
  WithdrawalReadError,
} from './application/withdrawal-reads.ts';
export type {
  DecryptWithdrawalAccount,
  WithdrawalListQuery,
  WithdrawalPage,
  WithdrawalRecordRow,
} from './application/withdrawal-reads.ts';
export { statusTitle, subTextBranch, isAccountFailure } from './domain/display.ts';
export type { WithdrawalDisplayRow, WithdrawalSubTextBranch } from './domain/display.ts';
export { createWithdrawalNotificationReader } from './ports/withdrawal-notification.ts';
export type {
  WithdrawalNotificationReader,
  WithdrawalNotificationView,
} from './ports/withdrawal-notification.ts';
// B1-27f: the withdrawal records section of a personal information copy (read only, payee account
// masked; assembled by app.module).
export { createPersonalDataCopyWithdrawalsReader } from './application/personal-data-copy-read.ts';
export type {
  PersonalDataCopyWithdrawalRow,
  PersonalDataCopyWithdrawalSubject,
  PersonalDataCopyWithdrawalsOptions,
  PersonalDataCopyWithdrawalsRead,
} from './application/personal-data-copy-read.ts';
// B1-01zzi: the worker's fund metric (PAYING withdrawals that need a person; read only).
export { readPayoutFundMetrics } from './application/metrics-read.ts';
export type { PayoutFundMetrics } from './application/metrics-read.ts';
// B2-05o (BR-WDR-26 / BR-WDR-24, D10-475 ②(b)): the worker's review overdue gauge (read only).
export { readPayoutReviewOverdue } from './application/review-overdue-count.ts';
export type { PayoutReviewOverdue } from './application/review-overdue-count.ts';
// B2-09j (BR-WDR-18, D10-592): the worker's water level gauge (read only).
export { readPayoutWaterLow } from './application/water-low-read.ts';
export type { PayoutWaterLow } from './application/water-low-read.ts';
// B1-01zzp: B2-11c's reading of withdraw.auto_payout.* (absent or malformed → its 08 default), so
// the worker's auto-payout cap gauge carries the cap the decision executes with.
export { autoPayoutConfigOf } from './application/auto-payout.ts';
export type { AutoPayoutConfigSnapshot } from './application/auto-payout.ts';
// B2-06c: EXECUTE (BR-WDR-12), the watermark check (BR-WDR-18) and the batch / attempts stores.
export {
  createPayoutExecute,
  PAYOUT_EXECUTE_CONFIG_KEYS,
  PAYOUT_EXECUTE_DEFAULTS,
  SYSTEM_AUTO_PAYOUT,
} from './application/payout-execute.ts';
export type {
  ExecuteBatchInput,
  ExecuteBatchResult,
  PayoutBatchRejectReason,
  PayoutExecute,
  PayoutExecuteOptions,
  PayoutLeftReason,
  SystemAutoPayoutExecutor,
} from './application/payout-execute.ts';
export {
  forecastFen,
  forecastWindow,
  judgeWaterLevel,
  judgeWatermark,
} from './domain/watermark.ts';
export type {
  ForecastWindow,
  WatermarkCheckInput,
  WatermarkReading,
  WatermarkRejectReason,
  WatermarkVerdict,
} from './domain/watermark.ts';
export { createWatermarkReader, readAlipayWaterLevel } from './application/watermark.ts';
export type {
  PayoutChannelName,
  PayoutWaterLevel,
  WatermarkCommitted,
  WatermarkReader,
} from './application/watermark.ts';
export { createPayoutBatchesStore } from './infra/payout-batches-store.ts';
export type {
  NewPayoutBatch,
  NewPayoutBatchItem,
  PayoutBatchItemResult,
  PayoutBatchKind,
  PayoutBatchesStore,
} from './infra/payout-batches-store.ts';
export { createPayoutAttemptsStore } from './infra/payout-attempts-store.ts';
export type { PayoutAttemptsStore } from './infra/payout-attempts-store.ts';
// B2-06d: the payout process's transfer job and its pre-transfer review.
export {
  createTransferJob,
  PAYOUT_QUEUE,
  PAYOUT_QUERY_JOB,
  PAYOUT_WENT_NEGATIVE_QUEUE,
  PAYOUT_WENT_NEGATIVE_JOB,
  PAYOUT_QUEUE_PAUSED_ALERT,
} from './jobs/transfer-job.ts';
export type {
  TransferJobPayload,
  QueryJobPayload,
  PayoutQueuePauseInput,
  PayoutQueuePausePort,
  TransferAlertCause,
  TransferAlertMessage,
  TransferJobLogger,
  TransferJobOptions,
} from './jobs/transfer-job.ts';
export { reviewTransfer } from './application/payout-review.ts';
// B2-06f (D10-398): the worker's transfer review (payout-review) and persisted pause (payout-landing).
export {
  createReviewJob,
  PAYOUT_REVIEW_QUEUE,
  PAYOUT_REVIEW_JOB,
  PAYOUT_RELEASE_JOB,
} from './jobs/review-job.ts';
export type { ReviewJobOptions, PayoutReviewPayload } from './jobs/review-job.ts';
export { createPauseJob, PAYOUT_PAUSE_JOB } from './jobs/pause-job.ts';
export type { PauseJobOptions, PayoutPausePayload } from './jobs/pause-job.ts';
export type {
  TransferHoldReason,
  WithdrawalHoldReason,
  TransferReviewInput,
  TransferReviewVerdict,
} from './application/payout-review.ts';
export { createQueryJob } from './jobs/query-job.ts';
export type {
  QueryJobOptions,
  QueryJobLogger,
  QuerySleep,
  QueryAlertMessage,
} from './jobs/query-job.ts';
export {
  manualDue,
  nextQueryPoint,
  queryPointOffsetSeconds,
} from './application/query-schedule.ts';
export type { QuerySchedule } from './application/query-schedule.ts';
export { createQueryRecovery } from './application/query-recovery.ts';
export type {
  QueryRecovery,
  QueryRecoveryLogger,
  QueryRecoveryOptions,
  QueryRecoveryResult,
} from './application/query-recovery.ts';
export { createPayoutLanding, paidAtOf } from './application/payout-landing.ts';
export type {
  LandingResult,
  LandingRow,
  PayoutLanding,
  PayoutLandingOptions,
} from './application/payout-landing.ts';
export { createLandingJob, PAYOUT_LANDING_JOB, PAYOUT_LANDING_QUEUE } from './jobs/landing-job.ts';
export type {
  LandingAttempt,
  LandingAttemptsReader,
  LandingJobLogger,
  LandingJobOptions,
  LandingJobPayload,
} from './jobs/landing-job.ts';
export { handoffLanding, recordedResponse } from './application/landing-handoff.ts';
// B2-07c (BR-WDR-23, D10-408): the worker's daily R2 reconciliation (payout-recon) and its chain.
export {
  createPayoutReconJob,
  PAYOUT_RECON_CHECK_JOB,
  PAYOUT_RECON_DIFF_ALERT,
  PAYOUT_RECON_JOB,
  PAYOUT_RECON_MANUAL_JOB,
  PAYOUT_RECON_QUEUE,
} from './jobs/recon-job.ts';
export type {
  PayoutBillPort,
  PayoutReconJobOptions,
  PayoutReconJobPayload,
  PayoutReconLogger,
} from './jobs/recon-job.ts';
export { seedPayoutRecon } from './application/recon-schedule.ts';
export type { PayoutReconSeedOptions } from './application/recon-schedule.ts';
// B2-11a: BR-WDR-29 审核风险标签快照 (W1 writes it; ④⑤⑥ reused by BR-WDR-30 ⑧).
export {
  createWithdrawRiskFlags,
  WITHDRAW_RISK_CONFIG_KEYS,
  WITHDRAW_RISK_DEFAULTS,
} from './application/withdraw-risk-flags.ts';
export type {
  WithdrawApplyRiskOptions,
  WithdrawRiskFactsReader,
  WithdrawRiskFlags,
  WithdrawRiskFlagsOptions,
  WithdrawRiskSubject,
} from './application/withdraw-risk-flags.ts';
export { createWithdrawRiskFactsReader } from './infra/withdraw-risk-facts.ts';
export type {
  WithdrawRiskFactsPorts,
  WithdrawRiskPayeeHistoryPort,
  WithdrawRiskSharesPort,
} from './infra/withdraw-risk-facts.ts';
export {
  commissionRateBp,
  highCommissionRatioFlag,
  invalidRatioFlag,
  withdrawVsReceivedFlag,
} from './domain/risk-flags.ts';
export type { WithdrawRiskFlag, WithdrawRiskFlagCode } from './domain/risk-flags.ts';
// B2-11d: BR-WDR-30 保存时校验 and 开启前置检查 (content injects the precheck into its switch check).
export {
  AUTO_PAYOUT_SAVE_KEYS,
  autoPayoutSaveRefusals,
  autoPayoutWriteRefusals,
  checkAutoPayoutEnable,
} from './domain/auto-config.ts';
export type {
  AutoPayoutEnableCheck,
  AutoPayoutEnableItem,
  AutoPayoutEnableItemCode,
  AutoPayoutEnableKey,
  AutoPayoutSaveRefusal,
} from './domain/auto-config.ts';
export {
  createDefaultReconPassedDays,
  readAutoPayoutEnableCheck,
} from './application/auto-config.ts';
export type { AutoPayoutEnableOptions, ReconPassedDaysPort } from './application/auto-config.ts';
// B2-07d: the real port of the days the daily channel reconciliation ran through (D10-408).
export { createReconPassedDays } from './application/recon-passed-days.ts';
export type { ReconPassedDaysOptions } from './application/recon-passed-days.ts';
// B2-04zc: the wallet ledger's WITHDRAW_PAID summary entries (PAID_API / PAID_MANUAL; read only,
// for ledger's port).
export {
  readPaidWithdrawalAt,
  readPaidWithdrawalSummaries,
  readPaidWithdrawalTotal,
} from './application/wallet-ledger.ts';
export type {
  PaidWithdrawalAtInput,
  PaidWithdrawalSummariesInput,
  PaidWithdrawalSummary,
} from './application/wallet-ledger.ts';
// B2-07e: W11 — the returned withdrawal settled as PAID_API on the channel's proof (the port the
// admin write-off of an R2 difference calls, through app.module; D10-428: the attempt record is
// appended by the payout process from the job queued on the write-off transaction).
export {
  PAYOUT_ATTEMPT_APPEND_JOB,
  PAYOUT_ATTEMPT_APPEND_QUEUE,
  PROVEN_SUCCESS_SWITCH,
  createWithdrawalProvenSuccess,
} from './application/withdrawal-proven-success.ts';
export type {
  AttemptAppendPayload,
  ProveChannelSuccessInput,
  ProveChannelSuccessResult,
  ProvenBillLine,
  ProvenSuccessRefusal,
  WithdrawalProvenSuccess,
  WithdrawalProvenSuccessOptions,
} from './application/withdrawal-proven-success.ts';
export { PAYOUT_ATTEMPT_APPEND_ALERT, createAttemptAppendJob } from './jobs/attempt-append-job.ts';
// B2-08b (BR-WDR-20): tax_ytd added on PAID_API / PAID_MANUAL, per real-name identity (W5 and W11
// now; W8 / W10 with their own tasks).
export { createTaxYtdAccumulator, taxYearOf } from './application/tax-ytd.ts';
export type {
  TaxYtdAccumulateInput,
  TaxYtdAccumulator,
  TaxYtdAccumulatorOptions,
  TaxYtdIdentityKeyReader,
  TaxYtdIdentityMissingAlert,
  TaxYtdIncomeType,
  TaxYtdLogger,
} from './application/tax-ytd.ts';
export type { AttemptAppendJobOptions, AttemptAppendLogger } from './jobs/attempt-append-job.ts';
// B2-08d (BR-WDR-21): the quarterly tax detail of paid withdrawals (read only, payee account masked;
// for the admin export worker, which adds names and id numbers through identity's port).
export {
  createTaxExportReader,
  taxExportQuarterRange,
  TaxExportBadCursor,
  TaxExportBadLimit,
  TaxExportBadQuarter,
} from './application/tax-export-read.ts';
export type {
  TaxExportIncomeType,
  TaxExportPage,
  TaxExportPaidStatus,
  TaxExportQuarterRange,
  TaxExportQuery,
  TaxExportRead,
  TaxExportReaderOptions,
  TaxExportRow,
} from './application/tax-export-read.ts';
// B2-05n (BR-WDR-26 超时判定, D10-475 ②): the worker's review overdue check (payout-overdue).
export {
  createReviewOverdueCheck,
  nextReviewOverdueSlot,
  reviewOverdueSlot,
} from './application/review-overdue.ts';
export type {
  ReviewOverdueCheck,
  ReviewOverdueCheckOptions,
  ReviewOverdueLogger,
  ReviewOverdueResult,
  ReviewOverdueSlot,
} from './application/review-overdue.ts';
export { createReviewOverdueJob, seedReviewOverdue } from './jobs/review-overdue-job.ts';
export type {
  ReviewOverdueJobName,
  ReviewOverdueJobOptions,
  ReviewOverdueJobPayload,
  ReviewOverdueQueue,
  ReviewOverdueSeedOptions,
} from './jobs/review-overdue-job.ts';
// B2-12c: the linked withdrawals of a manual adjustment (member and cash subject of the channel).
export { readWithdrawalAdjustRefs } from './application/withdrawal-adjust-ref.ts';
export type {
  WithdrawalAdjustRef,
  WithdrawalCashSubject,
} from './application/withdrawal-adjust-ref.ts';
