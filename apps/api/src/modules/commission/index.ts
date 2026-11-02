export { readNotifyBeneficiaries } from './ports/notify-beneficiaries.ts';
export type {
  ReadNotifyBeneficiariesInput,
  NotifyBeneficiary,
} from './ports/notify-beneficiaries.ts';
export { createCommissionRebateQuoter } from './application/rebate-quoter.ts';
export { COMMISSION_QUOTE_CONFIG_KEYS } from './application/types.ts';
export type { CommissionQuoteContext, CommissionRebateQuoter } from './application/types.ts';
export type { CommissionRebateQuoterOptions } from './application/rebate-quoter.ts';
export { selectRuleVersion, selectQuoteTerms } from './domain/rules.ts';
export type {
  RuleVersion,
  RuleRow,
  RuleReserve,
  RuleSetReader,
  QuoteTermsInput,
} from './domain/rules.ts';
export { createRuleSetReader } from './infra/rule-set-reader.ts';
export type { RuleSetReaderOptions } from './infra/rule-set-reader.ts';
export { createCommissionSnapshot } from './application/snapshot.ts';
export { readCommissionSnapshot } from './application/read-snapshot.ts';
// B2-03q (D10-540, D10-565, D10-568): settlement rebate's estimates port, orders' snapshot port.
export { createCommissionEstimates, createCommissionSnapshotPort } from './ports/estimates.ts';
export type {
  CommissionEstimates,
  CommissionEstimatesDependencies,
  CommissionOrderSnapshotPort,
  CommissionSnapshotPortDependencies,
  EstimateBases,
  EstimateChangeInput,
  EstimateOrder,
  EstimateOrderRef,
} from './ports/estimates.ts';
// B2-09ga (D10-481 ②): the one judgement of a forfeited share.
export { isShareForfeited } from './application/forfeited-state.ts';
export type {
  ShareEvent,
  ShareEventStatus,
  ShareInitialStatus,
} from './application/forfeited-state.ts';
export type { ShareStateBeneficiary } from './application/forfeited-state-read.ts';
export { readCommissionAttribution } from './application/read-attribution.ts';
export type {
  ReadCommissionAttributionInput,
  ReadCommissionAttributionResult,
} from './application/read-attribution.ts';
export { createSelfRebateEstimateReader } from './ports/self-rebate-estimate.ts';
export type { SelfRebateEstimateReader } from './ports/self-rebate-estimate.ts';
export type {
  ReadCommissionSnapshotInput,
  ReadCommissionSnapshotResult,
  ReadSnapshotBeneficiary,
  SnapshotForfeitedEvent,
} from './application/read-snapshot.ts';
export type {
  SnapshotBeneficiary,
  SnapshotBeneficiaries,
  SnapshotBeneficiaryResolver,
  CreateCommissionSnapshotInput,
  CommissionSnapshotDependencies,
  CommissionSnapshot,
  CreateCommissionSnapshotResult,
} from './application/snapshot.ts';
export { createInMemoryBeneficiaryResolver } from './infra/in-memory-beneficiary-resolver.ts';
export { createSnapshotBeneficiaryResolver } from './infra/beneficiary-resolver.ts';
export type { SnapshotBeneficiaryResolverOptions } from './infra/beneficiary-resolver.ts';
export {
  createDraft,
  validateDraft,
  runTrial,
  publish,
  revoke,
  RulePublicationError,
} from './application/rule-publication.ts';
export type {
  RulePublicationActor,
  RulePublicationContext,
  RulePublicationDependencies,
  CreateRuleDraftInput,
  RuleDraftInput,
  ValidateRuleDraftInput,
  PublishRuleInput,
  RevokeRuleInput,
  PublishedRuleVersion,
  RuleTrialResult,
  RuleTrialReport,
  RuleTrialPlatform,
  RuleTrialTotals,
  RulePublicationErrorCode,
} from './application/rule-publication.ts';
export { readTljDeductFen, TljDeductionMissing } from './infra/tlj-deduction-reader.ts';
export type { TljDeductionInput } from './infra/tlj-deduction-reader.ts';
// B2-11a: BR-WDR-29 ⑥ — the member's beneficiary shares from the split snapshot (read only).
export {
  createBeneficiaryShareReader,
  WITHDRAW_RISK_SHARE_ROLES,
} from './ports/withdraw-risk-shares.ts';
export type { BeneficiaryShareReader } from './ports/withdraw-risk-shares.ts';
// B2-04zd (D10-443): the only writer of commission_split_beneficiary_events (append only).
export { appendBeneficiaryEvent } from './application/beneficiary-events.ts';
export type {
  BeneficiaryEventDependencies,
  BeneficiaryEventForfeitReason,
  BeneficiaryEventInput,
  BeneficiaryEventRole,
} from './application/beneficiary-events.ts';
// B1-03z: BR-CALC-13 细则「申诉恢复」 — the member's shares forfeited for a ban (read only).
export { findBannedRunStart, listBannedForfeitedShares } from './application/forfeited-shares.ts';
export type {
  BannedForfeitedShare,
  FindBannedRunStartInput,
  ForfeitedShareRole,
  ListBannedForfeitedSharesInput,
} from './application/forfeited-shares.ts';
