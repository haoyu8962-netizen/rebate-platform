// Public surface of the identity module. Other modules import only from this file.
export { createPushSessionValidity } from './ports/push-session-validity.ts';
// B1-02zq: BR-WDR-03 ③b, the verdict payout's rules chain reads through its ReverifyGatePort.
export { createReverifyGate } from './application/reverify-gate.ts';
export type {
  ReverifyActor,
  ReverifyGate,
  ReverifyPendingData,
  ReverifyRefusal,
} from './application/reverify-gate.ts';
export type { PushSessionQuery, PushSessionValidity } from './ports/push-session-validity.ts';
export { createExportUsersReader } from './application/export-users.ts';
export type {
  ExportUsersReader,
  ExportUsersQuery,
  ExportUserRow,
} from './application/export-users.ts';
// B1-13g: the worker's scheduled takeover / recheck of the paid bank-card verification records.
export {
  PAYOUT_VERIFY_RECHECK_INTERVAL_MS,
  createPayoutVerifyRecheck,
  startPayoutVerifyRecheck,
  payoutVerifyRecheckToken,
} from './application/payout-verify-recheck.ts';
export type {
  PayoutVerifyRecheck,
  PayoutVerifyRecheckOptions,
  PayoutVerifyRecheckSchedule,
  PayoutVerifyRecheckControl,
} from './application/payout-verify-recheck.ts';
export { IdentityWorkerModule } from './identity-worker.module.ts';
export type {
  IdentityDataCopyPorts,
  IdentityWorkerModuleOptions,
} from './identity-worker.module.ts';
export {
  PRIVACY_CONSENT_CHECKS,
  privacyConsentRefusal,
  createPrivacyConsentChecks,
} from './application/privacy-consent.ts';
export type {
  PrivacyConsentInput,
  PrivacyConsentConfigReader,
  PrivacyConsentOptions,
  PrivacyConsentChecks,
} from './application/privacy-consent.ts';
// Stage ⑥ (BR-ID-27 deletion cooling / processing 10007, B1-15e): app.module hands
// DELETION_STAGE_CHECKS' guard and post-miss check to RiskModule ahead of ⑦.
export {
  DELETION_STAGE_CHECKS,
  createDeletionStageChecks,
  deletionStageRefusal,
} from './application/deletion-guard.ts';
export type {
  DeletionStageChecks,
  DeletionStageChecksOptions,
  DeletionStageRefusal,
} from './application/deletion-guard.ts';
export { lockUsersForUpdate } from './ports/lock-users.ts';
export type { LockUsersInput } from './ports/lock-users.ts';
export { createRealnameStatusBatchReader } from './ports/realname-status-batch.ts';
export type {
  RealnameStatusBatchInput,
  RealnameStatusBatchReader,
  RealnameStatusBatchReaderOptions,
} from './ports/realname-status-batch.ts';
// B2-08e (BR-WDR-21): the current names and ID numbers of a page of users, for the tax export only.
export { createRealnameExportBatchReader } from './ports/realname-export-batch.ts';
export type {
  RealnameExportBatchInput,
  RealnameExportBatchReader,
  RealnameExportBatchReaderOptions,
  RealnameExportIdentity,
} from './ports/realname-export-batch.ts';
// B2-08b (D10-181 ①): the current verified real name's id_no_hmac, payout's tax_ytd identity key.
export { createRealnameIdentityKeyReader } from './ports/realname-identity-key.ts';
export type {
  RealnameIdentityKeyInput,
  RealnameIdentityKeyReader,
} from './ports/realname-identity-key.ts';
// B1-03zc: under-18 users at an instant (BR-ID-26), for settlement BeneficiaryGate's minors port.
export { createMinorStatusBatchReader } from './ports/minor-status-batch.ts';
export type {
  MinorStatusBatchInput,
  MinorStatusBatchReader,
  MinorStatusBatchReaderOptions,
} from './ports/minor-status-batch.ts';
export { laborAgreementSigned } from './ports/labor-agreement.ts';
// B1-13h: the labor agreement's configuration port app.module assembles (IdentityModuleOptions).
export type { LaborAgreementConfigReader } from './ports/labor-agreement.ts';
// B1-11h: the landing registration's ports app.module assembles (IdentityModuleOptions).
export type {
  LandingInviteBind,
  LandingInviteBindInput,
  LandingInvitePort,
  LandingInvitePrecheck,
  LandingInvitePrecheckInput,
  LandingRegisterConfigReader,
} from './ports/landing-invite.ts';
export { createPayoutAccountService } from './application/payout-account.ts';
export type {
  PayoutAccountSubject,
  SaveAlipayCommand,
  SaveAlipayResult,
  PayoutAccountServiceOptions,
  PayoutAccountService,
  PayoutAccountConfigPort,
  SaveBankCardCommand,
  SaveBankCardResult,
} from './application/payout-account.ts';
// B2-05j: the realname-correction invalidation of the payout accounts, for admin B1-27g.
export {
  createPayoutAccountInvalidation,
  REALNAME_CORRECTION_EXEMPT,
} from './application/payout-account-invalidation.ts';
export type {
  PayoutAccountInvalidation,
  PayoutAccountInvalidationCommand,
  PayoutAccountInvalidationResult,
} from './application/payout-account-invalidation.ts';
// B1-13f: the takeover / recheck seam of the paid bank-card verification records, for B1-13g's
// scheduled task (it only updates the records: no account save, no refund).
export { createPayoutAccountVerifyAttempts } from './application/payout-account-verify-attempts.ts';
export type {
  PayoutAccountVerifyAttempts,
  PayoutAccountVerifyAttemptsOptions,
  PayoutVerifyAttemptSubject,
} from './application/payout-account-verify-attempts.ts';
export { createBankCardVerifier, createCardBin } from './infra/fake-bank-card-verifier.ts';
export type { BankCardVerifierPort, CardBinPort } from './ports/bank-card-verifier.ts';
// Stages ⑧ ⑨ (BR-ID-01 identity level, B1-02za): app.module hands IDENTITY_LEVEL_CHECKS' guard and
// post-miss check to RiskModule, and assembles the real-name status port.
export {
  IDENTITY_LEVEL_CHECKS,
  identityLevelRefusal,
  createIdentityLevelChecks,
  createDefaultRealnameStatusReader,
} from './application/identity-level.ts';
export type {
  RealnameStatus,
  RealnameStatusReader,
  IdentityLevelInput,
  IdentityLevelGuard,
  IdentityLevelChecks,
  IdentityLevelOptions,
} from './application/identity-level.ts';
export { createAgentCallerReader } from './ports/agent-caller.ts';
export type { AgentCallerReader, AgentCallerReaderOptions } from './ports/agent-caller.ts';
export { createInviteLoginDevicesReader } from './ports/invite-login-devices.ts';
export type { InviteLoginDevicesReader } from './ports/invite-login-devices.ts';
export { createUserLevelReader } from './ports/user-level.ts';
export { createUserDeletionStatusReader } from './ports/user-deletion-status.ts';
export { createDeletionStageReader } from './ports/deletion-stage.ts';
export type {
  DeletionStage,
  DeletionStageInput,
  DeletionStageReader,
  DeletionStageReaderOptions,
} from './ports/deletion-stage.ts';
export type {
  UserDeletionStatus,
  UserDeletionStatusInput,
  UserDeletionStatusReader,
  UserDeletionStatusReaderOptions,
} from './ports/user-deletion-status.ts';
// B1-15d: the two ports of POST /v1/me/deletion that app.module assembles (IdentityModuleOptions
// withdrawalInFlight / deletionBalance).
export type {
  WithdrawalInFlightInput,
  WithdrawalInFlightReader,
} from './ports/withdrawal-in-flight.ts';
export type { DeletionBalanceInput, DeletionBalanceReader } from './ports/deletion-balance.ts';
export type { DeletionRequestModuleOptions } from './application/deletion-request.ts';
// B1-15i: the DELETION_PROGRESS notice port (BR-TEXT-23) app.module assembles over notification.
export type {
  DeletionProgressNotice,
  DeletionProgressNoticeInput,
} from './ports/deletion-progress-notice.ts';
// B1-15f: the scheduled processing of deletion requests whose cooling period has ended (worker).
export type { WithdrawalNonTerminalReader } from './ports/withdrawal-in-flight.ts';
export {
  createDeletionExpiry,
  startDeletionExpiry,
  deletionExpiryToken,
} from './application/deletion-expiry.ts';
export type {
  DeletionCalendarConfigReader,
  DeletionExpiry,
  DeletionExpiryControl,
  DeletionExpiryOptions,
  DeletionExpirySchedule,
} from './application/deletion-expiry.ts';
export { IdentityDeletionExpiryModule } from './deletion-expiry.module.ts';
export type { IdentityDeletionExpiryModuleOptions } from './deletion-expiry.module.ts';
// B1-15g: processing of deletion requests (cleanup, Apple revocation, done) on the same timer, and
// the ports the owning modules implement for it (assembled by app.module).
export { createDeletionProcessing } from './application/deletion-processing.ts';
export type {
  DeletionProcessing,
  DeletionProcessingOptions,
} from './application/deletion-processing.ts';
export { closingAdjustmentFromBalance } from './ports/deletion-cleanup.ts';
export type {
  ClosingAdjustmentInput,
  ClosingAdjustmentState,
  DeletionCleanupInput,
  DeletionCleanupPort,
  DeletionCleanupPortName,
  DeletionCleanupPorts,
  DeletionCleanupStep,
  DeletionCleanupUnavailable,
  DeletionClosingAdjustmentReader,
} from './ports/deletion-cleanup.ts';
export type { WithdrawalSucceededReader } from './ports/withdrawal-in-flight.ts';
export type { AppleTokenRevokeInput, AppleTokenRevoker } from './ports/apple-token-revoker.ts';
export { unconfiguredAppleTokenRevoker } from './infra/unconfigured-apple-token-revoker.ts';
export type {
  UserLevel,
  UserLevelSubject,
  UserLevelReader,
  UserLevelReaderOptions,
} from './ports/user-level.ts';
export { createAiConsentReader } from './ports/ai-consent.ts';
export type {
  AiConsentSubject,
  AiConsentVerdict,
  AiConsentReader,
  AiConsentReaderOptions,
} from './ports/ai-consent.ts';
export { createSameDeviceLoginReader } from './ports/same-device-logins.ts';
export {
  createIdentityViewerContext,
  createIdentityCallerContext,
  createIdentityAttrCodeReader,
} from './ports/request-context.ts';
export type {
  IdentityRequest,
  IdentityContext,
  IdentityAttrCodeReader,
} from './ports/request-context.ts';
export { revokeSessionsByUser, revokeSessionsByDevice } from './application/revoke-sessions.ts';
export type { AfterSessionsRevoked, SessionRevokeReason } from './application/revoke-sessions.ts';
// F1-07d: the push token unbinding hook of a revocation, for app.module's assembly of the admin
// ban (the admin entry has no IdentityModule; BR-ID-07 细则「被动结束会话时解绑」).
export { unbindRevoked } from './application/push-tokens.ts';
export { IdentityModule } from './identity.module.ts';
// The admin entry's console routes of identity (F1-07a: the audited phone reveal).
export { IdentityAdminModule } from './identity-admin.module.ts';
// B1-27c: the registrants port of the console's copy requests (app.module assembles it over admin).
export type { AdminDataCopyRegistrants } from './application/admin-data-copies.ts';
// B1-10j: the applicants' masked phones (BR-ID-33 3+4) for orders' console claim review, assembled
// by app.module on the admin entry (decrypted and masked inside identity).
export { createMaskedPhoneReader } from './ports/masked-phones.ts';
export type { MaskedPhoneReader } from './ports/masked-phones.ts';
export { ME_READ_PORTS } from './application/tokens.ts';
export type { MeReadPorts, MeUnionBindingStatus } from './application/me.ts';
export type { InviteBackfillActivityPort, MeSubject } from './ports/invite-backfill-activity.ts';
export { createInviteBackfillActivityReader } from './infra/me-reads.ts';
export type {
  AssembledRevokeByDevice,
  AssembledRevokeByUser,
  IdentityConfigReader,
  IdentityModuleOptions,
  RegistrationInviteBindingPort,
} from './identity.module.ts';
// B1-12b: the push token port app.module builds from notification's commands.
export type { SessionPushTokens } from './application/push-tokens.ts';
export { createRecordInitialLevel } from './application/initial-level-log.ts';
export type {
  InitialLevelLog,
  InitialLevelLogEntry,
  RecordInitialLevel,
} from './application/initial-level-log.ts';
export type { AccountAssetsPort, AccountRiskPort } from './application/bind-phone.ts';
// Stage ⑫ step-up check (BR-ID-08, B1-02y): app.module hands the check to RiskModule; the handlers
// of the four x-step-up operations run their idempotent call through withStepUp.
export { STEP_UP_CHECK, createStepUpCheck, withStepUp } from './application/step-up-verify.ts';
export type { StepUpCheckOptions, StepUpHttpRequest } from './application/step-up-verify.ts';
// The token stages ② ③ (BR-ID-01) for the api entry's request check plan (app.module).
export { CONSENT_SIGNATURE_CHECK, TOKEN_CHECK } from './application/tokens.ts';
export { isRecordConsentRoute } from './application/consent-signature.ts';
// Bootstrap's route guard: is a plan's check identity's token check (BR-ID-01 ②)?
export { isTokenCheck } from './application/access-tokens.ts';
// BR-ID-05 细则「手机号规范化」: every module normalises a phone number with this function first.
export { normalize_phone } from './domain/normalize-phone.ts';
export type { NormalizedPhone } from './domain/normalize-phone.ts';
export type { SmsConfigReader } from './application/sms-codes.ts';
export type { MinimumVersionReader } from './application/session-scope.ts';
// Account creation core (B1-02i): SMS login, third-party first login and the landing page reuse it.
export {
  createRegistrationService,
  createDefaultInviteCodeFilter,
  countDeviceRegistrations,
  registrationConstants,
  snapshotRegistrationConfig,
  REGISTRATION_CONFIG_KEYS,
  DEFAULT_AVATAR,
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
} from './application/registration.ts';
export type {
  RegisterMethod,
  RegistrationCommand,
  RegistrationOptions,
  RegistrationResult,
  RegistrationService,
  RegistrationConstants,
  DeviceLimitContext,
  DeviceRegistrationRecord,
  InviteBindResult,
  SensitiveWords,
} from './application/registration.ts';
export { createSmsLoginService, LOGIN_LOGS_DEVICE_ID_CONTEXT } from './application/sms-login.ts';
export type {
  FirstAppLoginReview,
  SmsLoginCommand,
  SmsLoginOptions,
  SmsLoginResult,
  SmsLoginService,
} from './application/sms-login.ts';
// The process SMS sender and its Nest token (the admin entry's sms step-up tier, F1-06l).
export { createSmsSender, smsSenderToken } from './infra/fake-sms.ts';
export { createThirdPartyIdentity } from './infra/fake-third-party-identity.ts';
export { createRealnameVerifier } from './infra/fake-realname-verifier.ts';
export type {
  RealnameVerifierPort,
  RealnameVerificationInput,
  RealnameVerificationResult,
} from './ports/realname-verifier.ts';
export { createRealnameReader, createRealnameStatusReader } from './infra/realname-reader.ts';
export type { RealnameReader, VerifiedRealname } from './infra/realname-reader.ts';
export { projectAdminUser } from './application/admin-user-view.ts';
export type { AdminUserViewReader, AdminUserViewSource } from './application/admin-user-view.ts';
// B1-08n: orders' attr_code → user_id reader (status not filtered), assembled by app.module.
export { createOrderUserReader } from './infra/order-user-reader.ts';
export {
  createInviteRewardLoginIpsReader,
  createInviteRewardDeletedPhoneReader,
} from './ports/invite-reward.ts';
export {
  createWithdrawSubjectReader,
  createWithdrawPayeeSnapshotReader,
} from './ports/withdraw-subject.ts';
export type {
  WithdrawSubject,
  WithdrawSubjectReader,
  WithdrawPayeeSnapshot,
  WithdrawPayeeSnapshotReader,
} from './ports/withdraw-subject.ts';
// B1-27f: the sources of a personal information copy (BR-ID-40 导出范围): identity's own sections and
// the owners' read-only files app.module hands in, for B1-27h's generation.
export { createPersonalDataCopySources } from './application/personal-data-copy-sources.ts';
export type {
  PersonalDataCopyOwnerReads,
  PersonalDataCopySourcesOptions,
} from './application/personal-data-copy-sources.ts';
export type {
  PersonalDataCopyAccount,
  PersonalDataCopyAgentConversation,
  PersonalDataCopyAgentMessage,
  PersonalDataCopyConsent,
  PersonalDataCopyInvite,
  PersonalDataCopyLedgerEntry,
  PersonalDataCopyOrder,
  PersonalDataCopyRead,
  PersonalDataCopyRealname,
  PersonalDataCopySources,
  PersonalDataCopySubject,
  PersonalDataCopyWithdrawal,
} from './ports/personal-data-copy-sources.ts';
// B1-27h: generation and delivery of personal information copies (BR-ID-40): the data-copy queue's
// worker and the copy file (B1-27i re-encrypts a sealed wecom_session copy at its first download).
export { DATA_COPY_QUEUE, createDataCopyWorker } from './application/data-copy-worker.ts';
export type {
  DataCopyCodeSender,
  DataCopyInbox,
  DataCopyInboxEvent,
  DataCopyInboxInput,
  DataCopyPushCategory,
  DataCopySmsMessage,
  DataCopySmsResult,
  DataCopyWorker,
  DataCopyWorkerOptions,
} from './application/data-copy-worker.ts';
export {
  dataCopyFileEntries,
  encryptDataCopyZip,
  generateDataCopySecret,
  openSealedDataCopyEntries,
  sealDataCopyEntries,
} from './application/data-copy-file.ts';
export type { DataCopyFileEntry, PersonalDataCopyContent } from './application/data-copy-file.ts';
// B1-27h: the account-disable step admin's disable transaction runs (BR-ID-40 细则「重新登记与登记人停用」).
export { failWecomCopiesOfRegistrant } from './infra/personal-data-copies.ts';
export type { WecomCopyFailInput } from './infra/personal-data-copies.ts';
// B2-11a: BR-WDR-29 ⑩ payee_prev_other_user — the payee HMAC's binding history (read only).
export { createPayeeBindingHistoryReader } from './ports/payee-prev-other-user.ts';
export type { PayeeBindingHistoryReader } from './ports/payee-prev-other-user.ts';
