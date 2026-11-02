// Public surface of the platform module. Other modules import only from this file.
export * from './clock/index.ts';
export * from './config/index.ts';
export * from './logging/index.ts';
export * from './tracing/index.ts';
export * from './idempotency/index.ts';
export {
  registerIdempotencyEntryObserver,
  registerIdempotencyPostMissCheck,
} from './idempotency/post-miss.ts';
export type {
  IdempotencyEntryObserver,
  IdempotencyPostMissCheck,
} from './idempotency/post-miss.ts';
export * from './http/index.ts';
// B1-22v: the union quota bucket shared by every process (Redis); app.module calls it from here.
export { createRedisQuotaLimiter } from './http/redis-quota.ts';
export type { RedisQuotaDeps, RedisQuotaLimiter } from './http/redis-quota.ts';
// B1-22v (D10-460): the union quota of an entry without REDIS (memory in local / test, else refuse).
export { createUnionQuotaFallback } from './http/union-quota.ts';
export type {
  UnionQuotaFallback,
  UnionQuotaFallbackDeps,
  UnionQuotaFallbackMode,
} from './http/union-quota.ts';
export { createResilienceRegistry } from './resilience/index.ts';
export type {
  DependencyId,
  OwnerModule,
  FailureMode,
  DegradeAction,
  DegradeSpec,
  ResilienceEntry,
  PolicyOverride,
  ResilienceOverrides,
  ResilienceRegistry,
} from './resilience/index.ts';
// The pre-parsing registration point of the request checks (BR-ID-01 stages ①–③; bootstrap).
export {
  installRequestChecks,
  refuseRoutes,
  REQUEST_CHECKS,
  RequestRejection,
} from './http/request-checks.ts';
export type {
  CheckedRequest,
  RequestCheck,
  RequestCheckInput,
  RequestCheckPlan,
  RouteFilter,
  VerifiedDevice,
} from './http/request-checks.ts';
export { AUDIT_PORT } from './audit/index.ts';
export type { AuditInput, AuditPort } from './audit/index.ts';
export { FieldCryptoError, FIELD_CRYPTO_MESSAGES } from './crypto/index.ts';
export { KMS_SECRETS, KmsError, kmsAccessOf } from './kms/index.ts';
export type { KmsAccess, KmsErrorCode, KmsSecretName } from './kms/index.ts';
export type { FieldCrypto, FieldCryptoErrorCode } from './crypto/index.ts';
export { contractRouteSchema } from './validation/contract-routes.ts';
export type { ContractOperationId } from './validation/contract-routes.ts';
export { fieldsErrorEnvelope } from './validation/index.ts';
// Generated x-signed table of every contract operation (BR-ID-09; no openapi at run time).
export { contractSigningRoutes, isContractSignedRoute } from './validation/signing-routes.ts';
export type { SigningRoute } from './validation/signing-routes.ts';
// Generated snapshots of specs/link-patterns.yaml and specs/material-channels.yaml (no YAML at run time).
export { LINK_PATTERNS } from './specs/link-patterns.gen.ts';
export { getLinkPatterns } from './specs/link-patterns.ts';
export type { LinkPatternsSpec } from './specs/link-patterns.ts';
export { MATERIAL_CHANNELS } from './specs/material-channels.gen.ts';
export { getMaterialChannels } from './specs/material-channels.ts';
export type { MaterialChannelsSpec } from './specs/material-channels.ts';
export { HTTP_ENTRIES, WORKER_ENTRIES, isHttpEntry } from './entries.ts';
export type { EntryName, HttpEntry, WorkerEntry } from './entries.ts';
export {
  APP_CONFIG,
  APP_ENTRY,
  DB,
  DB_READ,
  IDEMPOTENCY,
  FIELD_CRYPTO,
  JOB_QUEUE,
  EVENT_BUS,
  PlatformModule,
  REDIS,
  ROOT_LOGGER,
} from './platform.module.ts';
export type { PlatformOptions } from './platform.module.ts';
export { EventError, EVENT_NAMES, registerEventConsumer } from './events/index.ts';
// UUIDv7 of ADR-0001 §4.2 #1 (entity ids), the generator of event ids under a neutral name.
export { newEventId as newUuidV7 } from './events/index.ts';
export type {
  EventBus,
  DomainEvent,
  PublishResult,
  ReceivedEvent,
  EventHandler,
  EventSubscription,
} from './events/index.ts';
export { createDbHandles, loadConnectionConfig, DbError } from './db/index.ts';
export type { ConnectionConfig, DbHandles } from './db/index.ts';
export { loadMaintConnectionConfig, createMaintDbHandle } from './db/maint.ts';
export type { MaintConnectionConfig, MaintDbHandle } from './db/maint.ts';
export { createWorkerMaintenance, startWorkerServices } from './maintenance/worker.ts';
// B2-15s: the bounded wait of a background timer's stop for its tick in flight.
export { TICK_STOP_WAIT_MS, waitForTickStop } from './lifecycle/bounded-stop.ts';
// Prometheus /metrics (B1-01zzh): the worker's whole-database gauges, process metrics everywhere.
export {
  collectWorkerMetrics,
  createMetricsRegistry,
  startMetricsServer,
} from './metrics/index.ts';
export type {
  MetricsRegistry,
  MetricsRegistryOptions,
  MetricsServer,
  MetricsServerOptions,
  WorkerMetricsSnapshot,
} from './metrics/index.ts';
// Inject `REDIS` (api / stream / admin / worker; payout has none) and take a namespace per module.
export { RedisClosedError, RedisUnavailableError, RedisValidationError } from './redis/index.ts';
export type {
  RedisHandle,
  RedisNamespace,
  RedisScriptOptions,
  RedisUnavailableReason,
} from './redis/index.ts';
export type {
  JobQueue,
  JobPayload,
  SendOptions,
  ReceivedJob,
  JobHandler,
  QueueRuntime,
} from './queue/index.ts';
// The worker entry hands its Idempotency to the queue runtime (B1-15za, BR-ID-30).
export { scheduleIdempotencyPurge } from './queue/idempotency-purge.ts';
export type { IdempotencyPurger } from './queue/idempotency-purge.ts';
// Stage ② context (BR-ID-01, BR-ID-07): identity's token check attaches it at the registration
// point; handlers and later stages of any module read it with tokenPrincipal.
export { tokenPrincipal, type TokenPrincipal } from './http/token-context.ts';
// Admin token check context (F1-06k): the verified admin session on the admin entry's requests.
export {
  adminPrincipal,
  type AdminPrincipal,
  type AdminPrincipalCarrier,
} from './http/admin-context.ts';
// CORS of the admin entry (F1-06k; 02 §3.4): only the console's exact origin.
export { installAdminCors, type AdminCorsPolicy } from './http/admin-cors.ts';
// Generated x-auth table of every contract operation (BR-ID-01 ②; no openapi at run time).
export {
  contractAuthRoutes,
  contractAuthOf,
  type AuthRoute,
  type ContractAuth,
} from './http/auth-routes.ts';
// Client version comparison of BR-ID-01 细则 (session scope B1-02h, version gate ④a B1-03c).
export { compareClientVersions, isVersionGatedPlatform } from './client-version/index.ts';
export type { JwtKeyConfig } from './config/jwt.ts';
export * from './qrcode/index.ts';
export * from './media/index.ts';
export * from './export-store/index.ts';
// Private import store of the admin Excel imports (B1-09g; rights-imports).
export * from './import-store/index.ts';
export { AdminOperationGuard } from './http/admin-guard.ts';
export type {
  AdminActor,
  AdminOperationInput,
  AdminOperationResponse,
} from './http/admin-guard.ts';
export { readSingleUpload } from './http/single-upload.ts';
export type { SingleUpload, SingleUploadRequest } from './http/single-upload.ts';
// Aliyun OpenAPI V3 (ACS3-HMAC-SHA256) request signing (B1-12w; agent review, notification SMS).
export { createAliyunAcs3Signer } from './aliyun/acs3.ts';
export type {
  AliyunAcs3Sign,
  AliyunAcs3SignerDeps,
  AliyunCredentials,
  AliyunSignRequest,
} from './aliyun/acs3.ts';
