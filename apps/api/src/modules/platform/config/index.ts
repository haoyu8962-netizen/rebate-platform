export { APP_ENVS, ConfigError, LOG_LEVELS, loadConfig, startupViolations } from './config.ts';
export type { AppConfig, AppEnv, LogLevel, MetricsConfig, TracingConfig } from './config.ts';
// The second field keyring (B1-27e): only the token; opening and reading it stay inside platform.
export { PRIOR_IDENTITY_FIELD_CRYPTO } from './keyring-prior-identity.ts';
export type { PriorIdentityKeyringConfig } from './keyring-prior-identity.ts';
export {
  DATAOKE_CREDENTIAL_ENV_NAMES,
  JD_CREDENTIAL_ENV_NAMES,
  PAY_CREDENTIAL_ENV_NAMES,
  PDD_CREDENTIAL_ENV_NAMES,
  SMS_CREDENTIAL_ENV_NAMES,
  TAOBAO_CREDENTIAL_ENV_NAMES,
  findCredentialLikeEnvNames,
  looksLikeRealCredentialEnvName,
} from './credential-env.ts';
// The access-token signing key contract (B1-02h): identity's key provider parses the PEM values
// with the same functions loadConfig validated them with.
export {
  JWT_ENV_NAMES,
  isJwtKeyId,
  parseP256PrivateKeyPem,
  parseP256PublicKeyPem,
  readJwtKeyConfig,
} from './jwt.ts';
// Admin console authentication (F1-06k): admin_token key, login IP whitelist, console CORS origin.
export {
  ADMIN_AUTH_ENV_NAMES,
  ADMIN_IP_ALLOWLIST_MAX,
  ADMIN_TOKEN_KEY_MIN_BYTES,
  isAllowlistItem,
  readAdminAuthConfig,
} from './admin-auth.ts';
export type { AdminAuthConfig } from './admin-auth.ts';
// Media public base URL (F1-06z): https base of content-addressed media files.
export { MEDIA_DEFAULT_LOCAL_BASE_URL, MEDIA_ENV_NAME, readMediaConfig } from './media.ts';
// Private export store (B1-34d): signed-link base URL and the local/test stand-in's HMAC key.
export {
  EXPORT_STORE_DEFAULT_LOCAL_BASE_URL,
  EXPORT_STORE_DEFAULT_LOCAL_SIGNING_KEY,
  EXPORT_STORE_ENV_NAMES,
  readExportStoreConfig,
} from './export-store.ts';
export type { ExportStoreConfig } from './export-store.ts';
// Pinduoduo live adapter credentials (B1-04t): staging reads the secret file once at startup.
export { readPddConfig } from './pdd.ts';
export type { PddClientConfig } from './pdd.ts';
// Agent content safety review (B3-03m): Aliyun AccessKey pair and endpoint, staging / prod only.
export { AGENT_REVIEW_ENDPOINT_ENV, readAgentReviewConfig } from './agent-review.ts';
export type { AgentReviewConfig } from './agent-review.ts';
// SMS provider (B1-12w): Aliyun AccessKey pair, signature name and template CODE, staging / prod only.
export { readSmsConfig } from './sms.ts';
export type { SmsConfig } from './sms.ts';
// Agent user hash key (B3-09j, BR-AI-22): HMAC key of agent's deletion purge; prod requires it.
export { AGENT_USER_HASH_KEY_ENV, readAgentUserHashConfig } from './agent-user-hash.ts';
export type { AgentUserHashConfigResult, AgentUserHashKeyEnvName } from './agent-user-hash.ts';
// Pinduoduo query identity custom_parameters (B1-04x): optional server setting, not a credential.
export {
  PDD_QUERY_CUSTOM_PARAMETERS_ENV,
  PDD_QUERY_CUSTOM_PARAMETERS_MAX_BYTES,
  readPddQueryConfig,
} from './pdd-query.ts';
export {
  PDD_SECRET_FILE_MAX_BYTES,
  PDD_STARTUP_MESSAGES,
  PddStartupError,
  openPddCredentials,
} from './pdd-startup.ts';
export type { PddClientCredentials, PddStartupErrorCode } from './pdd-startup.ts';
// Taobao live adapter credentials (B1-04k): staging reads the secret file once at startup.
export { readTaobaoConfig } from './taobao.ts';
export type { TaobaoAppConfig } from './taobao.ts';
export {
  TAOBAO_SECRET_FILE_MAX_BYTES,
  TAOBAO_STARTUP_MESSAGES,
  TaobaoStartupError,
  openTaobaoCredentials,
} from './taobao-startup.ts';
export type { TaobaoAppCredentials, TaobaoStartupErrorCode } from './taobao-startup.ts';
// 大淘客 credentials of the Taobao order source (B1-04e): staging reads the secret file once at startup.
export { readDataokeConfig } from './dataoke.ts';
// Taobao 大淘客 switches (B1-04zn): server settings, not credentials; any APP_ENV may set them.
export {
  TAOBAO_CONVERT_SOURCE_ENV,
  TAOBAO_SEARCH_SOURCE_ENV,
  readTaobaoSourceConfig,
} from './taobao-sources.ts';
export type { DataokeAppConfig } from './dataoke.ts';
export {
  DATAOKE_SECRET_FILE_MAX_BYTES,
  DATAOKE_STARTUP_MESSAGES,
  DataokeStartupError,
  openDataokeCredentials,
} from './dataoke-startup.ts';
export type { DataokeAppCredentials, DataokeStartupErrorCode } from './dataoke-startup.ts';
// Jingdong live adapter credentials and site id (B1-04ze): staging reads the secret file once at startup.
export { JD_SITE_ID_ENV, readJdConfig, readJdSiteConfig } from './jd.ts';
export type { JdAppConfig } from './jd.ts';
export {
  JD_SECRET_FILE_MAX_BYTES,
  JD_STARTUP_MESSAGES,
  JdStartupError,
  openJdCredentials,
} from './jd-startup.ts';
export type { JdAppCredentials, JdStartupErrorCode } from './jd-startup.ts';
// The real collection channels (B2-15k): names and paths, api / worker / admin entries only.
export { readPayChannelsConfig } from './pay-channels.ts';
export type { PayAlipayEnv, PayChannelsConfig, PayWechatEnv } from './pay-channels.ts';
// One secret file at startup: the collection channels read their key files through it (B2-15k).
export { readStartupSecretFile } from './startup-secret-file.ts';
export type { StartupSecretFileFailure } from './startup-secret-file.ts';
// Worker queue concurrency limits (B1-01zzk): per-queue overrides and the shared budget.
export { readQueueConcurrencyConfig } from './queue-concurrency.ts';
export type { QueueConcurrencyConfigResult } from './queue-concurrency.ts';
// Staging test phones with a fixed SMS code (B1-02zza, D10-611): staging only, hard off elsewhere.
export { openStagingTestPhones, readStagingTestPhoneConfig } from './staging-test-phones.ts';
export type {
  StagingTestPhoneConfig,
  StagingTestPhoneConfigResult,
  StagingTestPhones,
} from './staging-test-phones.ts';
// Union endpoint override directory (B1-04y): staging reads the endpoints from a mounted directory.
export {
  UNION_ENDPOINT_OVERRIDE_DIR_ENV,
  readUnionEndpointOverrideConfig,
} from './union-endpoint-override.ts';
