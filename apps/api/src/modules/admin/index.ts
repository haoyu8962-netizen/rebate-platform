// Public surface of the admin module. Other modules depend on the platform AUDIT_PORT, not on
// this file (admin depends on every module; importing admin would close a cycle).
export { createExportWorker } from './application/export-worker.ts';
export type { ExportWorker, ExportWorkerOptions } from './application/export-worker.ts';
// B1-34e: the worker entry's export queue handler (app.module hands in identity's and content's
// readers); EXPORT_WORKER also carries the account-disable cancel port.
export { EXPORT_WORKER, ExportWorkerModule } from './export-worker.module.ts';
export type { ExportWorkerModuleOptions } from './export-worker.module.ts';
export type { TaxExportPorts } from './application/tax-export-source.ts';
export { AdminModule, TOTP_REPLAY_STORE } from './admin.module.ts';
export { createAuditWriter } from './infra/audit-writer.ts';
export {
  AUDIT_REDACTED,
  AUDIT_SENSITIVE_FRAGMENTS,
  redactSnapshot,
} from './infra/audit-redaction.ts';
export type { AdminAuditInput, AuditWriterDeps } from './infra/audit-writer.ts';
// B1-34p: the system's audit on the caller's transaction (settlement's rebate audit port; B1-09n
// assembles it).
export { createSystemAuditWriter } from './infra/system-audit.ts';
export type {
  SystemAuditWriter,
  SystemAuditWriterDeps,
  SystemHoldAudit,
  SystemHoldState,
} from './infra/system-audit.ts';
export {
  createTotpVerifier,
  totpSecretContext,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
} from './domain/totp.ts';
export type {
  TotpAccount,
  TotpClaim,
  TotpReplayStore,
  TotpRequest,
  TotpVerifier,
} from './domain/totp.ts';
export { createPgTotpReplayStore } from './infra/totp-replay-pg.ts';
// B1-10j: the reviewers' display names for orders' console claim review (app.module only).
export { createAdminDisplayNameReader } from './infra/admin-display-names.ts';
export type { AdminDisplayNameReader } from './infra/admin-display-names.ts';
// B1-27c: an account's status, super flag and ticked points, for identity's copy request
// registrants (app.module only; identity never reads admin's tables).
export { createAdminProfiles } from './infra/admin-profiles.ts';
export type { AdminProfile, AdminProfiles } from './infra/admin-profiles.ts';
export { ADMIN_ACTIVE_STATUS } from './application/admin-login.ts';
// B1-10i: the latest manual hold audit of an order for orders' console order detail (app.module only).
export { createOrderHoldAuditReader } from './application/order-hold-audits.ts';
export type { OrderHoldAudit, OrderHoldAuditReader } from './application/order-hold-audits.ts';
// B1-12z: the operator's verify phone for notification's console SMS test send (app.module only).
export { createAdminVerifyPhoneReader } from './application/verify-phone-read.ts';
export type {
  AdminVerifyPhoneReader,
  AdminVerifyPhoneReaderDeps,
} from './application/verify-phone-read.ts';
// Test double only; production uses createPgTotpReplayStore.
export { createMemoryTotpReplayStore } from './infra/totp-replay-memory.ts';
export { createSuperVerifier } from './application/verify-super.ts';
export type { SuperVerifier } from './application/verify-super.ts';
// Admin console authentication (F1-06k): the admin entry's module, its request check and the
// CORS policy that bootstrap installs (app.module and bootstrap only).
export { AdminAuthModule } from './admin-auth.module.ts';
export type { AdminHttpPolicy } from './admin-auth.module.ts';
export { ADMIN_CHECK, ADMIN_HTTP_POLICY } from './application/tokens.ts';
export { isAdminCheck } from './application/admin-check.ts';
export { getAdminPermissionCatalog } from './domain/permission-catalog.ts';
export type { AdminPermissionDefinition, AdminStepUpTier } from './domain/permission-catalog.ts';
export {
  createAdminPermissionGuard,
  createAdminStepUpTokens,
} from './application/permission-guard.ts';
export type {
  AdminBusinessResponse,
  AdminPermissionGuard,
  AdminPermissionPrincipal,
  AdminPermissionRequest,
  AdminStepUpBinding,
  AdminStepUpGrant,
  AdminStepUpTokens,
} from './application/permission-guard.ts';
