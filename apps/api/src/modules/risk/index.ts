// Public surface of the risk module. Other modules import only from this file.
export { createOrderBlocklistPorts } from './application/order-blocklist.ts';
export type {
  OrderBlocklistDimension,
  OrderBlocklistQuery,
  OrderBlocklistMatch,
  OrderBlocklistHitInput,
  ChannelBlocklistImport,
  ChannelBlocklistImportResult,
  OrderBlocklistPorts,
  OrderBlocklistOptions,
} from './application/order-blocklist.ts';
export { createRiskStateBatchReader } from './application/risk-state-reader.ts';
export type {
  RiskStateBatchInput,
  RiskStateBatchValue,
  RiskStateBatchReader,
  RiskStateBatchReaderOptions,
} from './application/risk-state-reader.ts';
// Task F1-07d: the console's ban / unban / freeze / unfreeze (PUT /admin/v1/users/{user_id}/
// risk-state; BR-ID-31; admin entry only). Rule tests: test/spec/risk/admin-risk-state/**.
export {
  AdminRiskState,
  AdminRiskStateFieldsError,
  AdminRiskStateNotAllowedError,
} from './application/admin-risk-state.ts';
export type {
  AdminRiskAction,
  AdminRiskStateCommand,
  AdminRiskStateOptions,
} from './application/admin-risk-state.ts';
export { RiskAdminModule } from './risk-admin.module.ts';
export type { RiskAdminOptions } from './risk-admin.module.ts';
// Task B1-03zd: the appeal console reads (GET /admin/v1/appeals, /admin/v1/appeals/{appeal_id},
// /admin/v1/blocked-requests; CT-24r, BR-ID-36; admin entry only). Rule tests:
// test/spec/risk/admin-appeals-read/**.
export {
  AdminAppealsRead,
  AdminAppealsFieldsError,
  appealRevokePermission,
  blockedRequestCause,
} from './application/admin-appeals-read.ts';
export type {
  AdminAppealsReadPorts,
  AdminAppealsReadOptions,
} from './application/admin-appeals-read.ts';
// Task B1-03ze: the appeal console writes (POST /admin/v1/appeals, …/claim, …/resolve; CT-24r,
// BR-ID-36, BR-ID-31; admin entry only). Rule tests: test/spec/risk/admin-appeals-write/**.
export {
  AdminAppealsWrite,
  AdminAppealsWriteFieldsError,
  AdminAppealConflictError,
  AdminAppealAttemptsUsedUpError,
  appealConsoleText,
  appealResolveRequirement,
} from './application/admin-appeals-write.ts';
export type {
  AdminAppealsWriteActor,
  AdminAppealsWriteOptions,
  AdminAppealsWritePorts,
  AppealResolveRequirement,
  AppealResolveRequirementInput,
  PreparedResolution,
} from './application/admin-appeals-write.ts';
export { RiskAppealsAdminModule } from './http/admin/appeals-admin.module.ts';
export type {
  RiskAppealsAdminOptions,
  RiskAppealsAdminWriteOptions,
} from './http/admin/appeals-admin.module.ts';
// B1-09p: processing order appeals of a user (BR-ID-36; read only, settlement's port).
export { createOrderAppealReader } from './application/order-appeal-read.ts';
export type { OrderAppealReader } from './application/order-appeal-read.ts';
// Task B1-03zg: the console's risk rule list and enable / disable (GET /admin/v1/risk-rules, POST
// /admin/v1/risk-rules/{rule_id}/enable|disable; CT-24f, BR-ID-36; admin entry only). Rule tests:
// test/spec/risk/admin-risk-rules/**.
export {
  AdminRiskRules,
  AdminRiskRuleConflictError,
  AdminRiskRulesFieldsError,
} from './application/admin-risk-rules.ts';
export type {
  AdminRiskRuleView,
  AdminRiskRuleChange,
  AdminRiskRuleCommand,
  AdminRiskRulesOptions,
} from './application/admin-risk-rules.ts';
export { riskRuleCatalog, riskRuleCatalogEntry } from './application/risk-rule-catalog.ts';
export type { RiskRuleCatalogEntry } from './application/risk-rule-catalog.ts';
export { RiskRulesAdminModule } from './http/admin/risk-rules-admin.module.ts';
export type { RiskRulesAdminOptions } from './http/admin/risk-rules-admin.module.ts';
export { createInviteRelationHitWriter } from './application/invite-relation-hits.ts';
export type {
  InviteRelationHitRuleId,
  InviteRelationHitInput,
  InviteRelationHitWriter,
  InviteRelationHitWriterOptions,
} from './application/invite-relation-hits.ts';
export {
  SMS_ATTEMPT_SEND_BOUND_MS,
  SMS_ATTEMPT_TRANSITIONS,
  SmsAttemptTransitionError,
  canTransitionSmsAttempt,
  createSmsRisk,
  ephemeralSmsRiskIndex,
  transitionSmsAttempt,
} from './application/sms-risk.ts';
export type {
  SmsRisk,
  SmsRiskOptions,
  SmsRiskRequest,
  SmsAttemptRequest,
  SmsAttemptAdmission,
  SmsAttemptOutcome,
  SmsAttemptStatus,
  SmsRiskAdmission,
} from './application/sms-risk.ts';
export {
  SameDeviceIsolationError,
  createSameDeviceAccountsCheck,
  sameDeviceAccountsCheckToken,
  sameDeviceLoginReaderToken,
} from './application/same-device-accounts.ts';
export type {
  SameDeviceFirstLogin,
  SameDeviceLoginReader,
  SameDeviceAccountsInput,
  SameDeviceRefType,
  SameDeviceRef,
  InviteRewardParty,
  SameDeviceAccountsResult,
  SameDeviceAccountsCheck,
  SameDeviceAccountsOptions,
} from './application/same-device-accounts.ts';
export {
  createDeviceRegistrationRisk,
  unkeyedDeviceRegistrationIndex,
} from './application/device-registration.ts';
export type {
  DeviceRegistrationRisk,
  DeviceRegistrationRiskOptions,
  DeviceRegistrationReservation,
  DeviceRegistrationAdmission,
} from './application/device-registration.ts';
export {
  createRateLimitService,
  createRateLimitThresholdReader,
} from './application/rate-limit.ts';
export type {
  RateLimitConfigReader,
  RateLimitThresholdReader,
  RateLimitRule,
  RateLimitRequest,
  RateLimitResult,
  RateLimitOptions,
  RateLimitService,
  RateLimitThresholdReaderOn,
} from './application/rate-limit.ts';
//
// Also compiled by the `test` project: this file and everything it exports use erasable syntax
// only, `import type` for type-only imports and relative imports with `.ts`; no parameter
// decorators or parameter properties (RiskModule carries a class decorator only, like
// PlatformModule). Loading this file loads @nestjs/common (through risk.module.ts and
// ../platform/index.ts). The ports are plain interfaces, so identity implements them without Nest
// types.
export { MINIMUM_VERSION_CHECK, RiskModule } from './risk.module.ts';
export { RiskScanModule } from './risk-scan.module.ts';
export {
  createRiskScan,
  riskScanToken,
  seedRiskScan,
  RISK_SCAN_QUEUE,
} from './application/risk-scan.ts';
export type { RiskScan, RiskScanOptions } from './application/risk-scan.ts';
export { RISK_SCAN_HEAL_INTERVAL_MS, startRiskScanHeal } from './application/risk-scan-heal.ts';
export type {
  RiskScanHealer,
  RiskScanHealControl,
  RiskScanHealSchedule,
} from './application/risk-scan-heal.ts';
export {
  RISK_STATE_STAMP_NAMESPACE,
  RiskStateConflictError,
  RiskStateTransitionError,
  createRiskStateService,
  raiseRiskStateStamp,
  riskStateServiceToken,
} from './application/risk-state.ts';
export { canTransitionRiskState } from './domain/risk-state-transitions.ts';
export type {
  RiskReasonCategory,
  RiskSubject,
  RiskStateSnapshot,
  SetRiskState,
  RiskStateRequest,
  RiskStateService,
  RiskStateOptions,
} from './application/risk-state.ts';
export {
  createMinimumVersionCheck,
  createMinimumVersionGuard,
  contractMinimumVersionRoutes,
} from './application/minimum-version.ts';
export type {
  MinimumVersionReader,
  MinimumVersionReaderOn,
  MinimumVersionRequest,
  MinimumVersionCheck,
  MinimumVersionRoute,
  MinimumVersionGuard,
} from './application/minimum-version.ts';
export type {
  MinimumVersionReaders,
  RateLimitThresholdReaders,
  RiskModuleOptions,
} from './risk.module.ts';
export {
  DEVICE_SIGNING_KEYS,
  SIGNATURE_CHECK,
  SignatureError,
  createRequestSignatureVerifier,
  createSignatureCheck,
  isSignatureCheck,
} from './application/signature-check.ts';
export type {
  DeviceSigningKey,
  DeviceSigningKeys,
  RequestSignatureVerifier,
  SignatureDependencies,
  SignatureRequest,
  SignedRequest,
} from './application/signature-check.ts';
// B1-02zi (R-04 option A): the Redis generation key that refuses signed requests for the nonce
// dedup duration after Redis lost its data. Rule tests: test/spec/risk/redis-generation/**.
export {
  REDIS_GENERATION_RENEW_INTERVAL_MS,
  REDIS_GENERATION_TTL_SECONDS,
  RedisGenerationRefusalError,
  armRedisGeneration,
  createRedisGenerationGate,
  createRedisGenerationRenewal,
  isRedisGenerationArmed,
  isRedisGenerationEnabled,
  redisGenerationRenewalToken,
  startRedisGenerationRenewal,
} from './application/redis-generation.ts';
export type {
  RedisGenerationGate,
  RedisGenerationOptions,
  RedisGenerationRenewal,
  RedisGenerationRenewalControl,
  RedisGenerationRenewalOptions,
  RedisGenerationRenewalStart,
  RedisGenerationSchedule,
} from './application/redis-generation.ts';
export { createBlocklistService, blocklistHmacContexts } from './application/blocklist.ts';
export type {
  BlocklistDimension,
  BlocklistInput,
  BlocklistHit,
  BlockedRequest,
  BlockedRequestBase,
  DigestBlockedRequest,
  RelatedPhoneDigest,
  RecordBlockedHit,
  RecordDigestBlockedHit,
  BlockedHitTarget,
  RegistrationBlock,
  BlockedRegistrationInput,
  RegistrationBlocklistInput,
  BlocklistOptions,
  BlocklistService,
} from './application/blocklist.ts';
// B1-15f: the working-day deadline with the number of working days as a parameter (BR-ID-27's 15
// working days; identity's deletion overdue alarm). resolveAppealDeadline stays internal.
export { workingDayDeadline } from './domain/appeal-deadline.ts';
export type { AppealCalendarYear } from './domain/appeal-deadline.ts';
export { resolveWorkingDayDeadline } from './application/appeal-calendar.ts';
export type {
  WorkingDayCalendarReader,
  WorkingDayDeadlineOptions,
} from './application/appeal-calendar.ts';
export { createAppealPrevStateReader } from './ports/appeal-prev-state.ts';
export type { AppealPrevStateReader } from './ports/appeal-prev-state.ts';
export { createBlocklistMatchReader } from './ports/blocklist-match.ts';
export type { BlocklistMatchReader } from './ports/blocklist-match.ts';
export { createWithdrawalReviewHits } from './application/withdrawal-review-hits.ts';
export type {
  WithdrawalReviewHit,
  WithdrawalReviewHits,
} from './application/withdrawal-review-hits.ts';
// B1-03z: appeal restore differences of revoked ban appeals (BR-FUND-22, BR-CALC-13 细则「申诉恢复」).
// Rule tests: test/spec/risk/appeal-restore/**.
export { createAppealRestoreHandler } from './application/appeal-restore.ts';
export type {
  AppealRestoreConsumer,
  AppealRestoreOptions,
  AppealRestoreLogger,
  AppealRestoreShare,
  BannedForfeitedSharesPort,
  BannedRunStartPort,
  ForfeitedAmountPort,
} from './application/appeal-restore.ts';
export type { RiskScanWorkerPorts } from './risk-scan.module.ts';
// B1-03zh: the rule status read port (BR-ID-36 细则「规则清单的启停」, D10-536), read only; identity
// and growth get it through app.module. Rule tests: test/spec/risk/rule-toggle-identity/**.
export {
  RISK_RULE_STATUS_TTL_MS,
  createRiskRuleStatusReader,
} from './application/risk-rule-status.ts';
export type {
  RiskRuleKey,
  RiskRuleStatusReader,
  RiskRuleStatusReaderOptions,
} from './application/risk-rule-status.ts';
// B2-12g: the linked accounts' marks of a bad-debt write-off (BR-FUND-12; trace only), written on
// ledger's approving transaction. Rule tests: test/spec/risk/bad-debt-linked/**.
export { createBadDebtLinkedMarker } from './application/bad-debt-linked.ts';
export type {
  BadDebtLinkedDimension,
  BadDebtLinkedMarkInput,
  BadDebtLinkedMarker,
  BadDebtLinkedMarkerOptions,
} from './application/bad-debt-linked.ts';
