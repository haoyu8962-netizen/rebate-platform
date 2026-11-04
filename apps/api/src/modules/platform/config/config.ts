// Environment configuration (ADR-0001 §2 配置校验): validated once at startup with zod.
// `loadConfig` is pure: it only looks at the object it is given.
import { z } from 'zod';
import type { QueueLimits } from '../queue/worker-plan.ts';
import { APP_ENVS, type AppEnv } from './app-env.ts';
import { readAdminAuthConfig, type AdminAuthConfig } from './admin-auth.ts';
import { readAgentReviewConfig, type AgentReviewConfig } from './agent-review.ts';
import { readAgentUserHashConfig } from './agent-user-hash.ts';
import { findCredentialLikeEnvNames } from './credential-env.ts';
import { readDataokeConfig, type DataokeAppConfig } from './dataoke.ts';
import { readJdConfig, readJdSiteConfig, type JdAppConfig } from './jd.ts';
import {
  JWT_ENV_NAMES,
  readJwtKeyConfig,
  readJwtVerifyKeyConfig,
  type JwtKeyConfig,
  type JwtVerifyKeyConfig,
} from './jwt.ts';
import { readKeyringConfig, type KeyringConfig } from './keyring.ts';
import { readKmsConfig, type KmsConfig } from './kms.ts';
import {
  readPriorIdentityKeyringConfig,
  type PriorIdentityKeyringConfig,
} from './keyring-prior-identity.ts';
import { readExportStoreConfig } from './export-store.ts';
import { readMediaConfig } from './media.ts';
import { readPddConfig, type PddClientConfig } from './pdd.ts';
import { readPddQueryConfig } from './pdd-query.ts';
import type { EntryName } from '../entries.ts';
import { readPayChannelsConfig, type PayChannelsConfig } from './pay-channels.ts';
import { readQueueConcurrencyConfig } from './queue-concurrency.ts';
import { readSmsConfig, type SmsConfig } from './sms.ts';
import { readStagingTestPhoneConfig, type StagingTestPhoneConfig } from './staging-test-phones.ts';
import { readTaobaoConfig, type TaobaoAppConfig } from './taobao.ts';
import { readTaobaoSourceConfig } from './taobao-sources.ts';
import { readTrustedProxies } from './trusted-proxies.ts';
import { readUnionEndpointOverrideConfig } from './union-endpoint-override.ts';

export { APP_ENVS, type AppEnv } from './app-env.ts';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const port = (fallback: number) =>
  z
    .string()
    .regex(/^\d{1,5}$/, 'must be a decimal port number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default(fallback);

const envSchema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // ISO-8601 instant with an explicit offset (`Z` or `+08:00`), see clockFromConfig.
  CLOCK_NOW: z.iso.datetime({ offset: true }).optional(),
  COULI_EXIT_AFTER_INIT: z.enum(['0', '1']).default('0'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port(3100),
  STREAM_PORT: port(3101),
  ADMIN_PORT: port(3102),
  // B1-01zzg (02 §13): the deployed image tag, bound to every log line. Docker tag syntax.
  COULI_DEPLOY_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'must be an image tag ([A-Za-z0-9_.-], 1–128)')
    .optional(),
  // B1-01zzh: the internal Prometheus /metrics listener. Unset = no listener; the host alone opens
  // nothing. Unprivileged ports only.
  METRICS_PORT: z
    .string()
    .regex(/^\d{1,5}$/, 'must be a decimal port number')
    .transform(Number)
    .pipe(z.number().int().min(1024).max(65535))
    .optional(),
  METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  // B1-31 (02 §13): OpenTelemetry trace export of the api / stream / worker entries to
  // VictoriaTraces over OTLP/HTTP. Unset = no export and no instrumentation. The endpoint is an
  // http(s) URL with a host and without credentials; the message never repeats the value.
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z
    .string()
    .refine(isTraceEndpoint, 'must be an http(s) URL with a host and without credentials')
    .optional(),
  // Sampling ratio of new traces, 0..1 (default 1: every request).
  OTEL_TRACES_SAMPLER_ARG: z
    .string()
    .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/, 'must be a ratio between 0 and 1')
    .transform(Number)
    .optional(),
  // service.name of the exported spans; default `couli-<entry>`.
  OTEL_SERVICE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'must be a service name ([A-Za-z0-9_.-], 1–128)')
    .optional(),
});

/** B1-31: http(s), a non-empty host, no username / password (the value is never echoed). */
function isTraceEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === ''
  );
}

type EnvKey = keyof z.input<typeof envSchema>;
const ENV_KEYS = Object.keys(envSchema.shape) as EnvKey[];

export interface AppConfig {
  /**
   * MEDIA_PUBLIC_BASE_URL (./media.ts, F1-06z): https base of stored media files. loadConfig gives
   * the local / test default when unset there; undefined in staging / prod when unset (media writes
   * and URLs then fail per request). A hand-built config without it counts as unset.
   */
  readonly mediaPublicBaseUrl?: string | undefined;
  /**
   * EXPORT_STORE_BASE_URL / EXPORT_STORE_SIGNING_KEY (./export-store.ts, B1-34d): base and HMAC key
   * of the private export store's signed links. loadConfig gives the local / test defaults when
   * unset there; undefined in staging / prod when unset. A hand-built config without them counts as
   * unset. The signing key is never logged.
   */
  readonly exportStoreBaseUrl?: string | undefined;
  readonly exportStoreSigningKey?: string | undefined;
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  /**
   * COULI_DEPLOY_VERSION (B1-01zzg, 规划/02 §13): the deployed image tag, bound to every root log
   * line as `deployVersion`. Absent when unset or empty (no key at all, never an empty string); a
   * hand-built config without it logs no deploy version.
   */
  readonly deployVersion?: string | undefined;
  /** Validated CLOCK_NOW text; parsed into an instant only inside platform/clock. */
  readonly clockNow: string | undefined;
  readonly exitAfterInit: boolean;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly streamPort: number;
  readonly adminPort: number;
  /** B1-30a: where KMS is, staging / prod only; absent without KMS_* (./kms.ts). */
  readonly kms?: KmsConfig | null | undefined;
  readonly keyring: KeyringConfig | null;
  /**
   * PRIOR_IDENTITY_KEY_PROVIDER / PRIOR_IDENTITY_KEYRING_FILE / PRIOR_IDENTITY_MASTER_KEY_FILE
   * (./keyring-prior-identity.ts, B1-27e): the second field keyring, whose independent data keys
   * encrypt the isolated store of prior identities (规划/08 BR-ID-25). Same meaning and formats as
   * FIELD_*; staging / prod require it once FIELD_KEY_PROVIDER is set, local / test generate one
   * per process when it is unset. Present only when configured; a hand-built config without it
   * (or with null) counts as unset. Holds only the provider name and the paths.
   */
  readonly priorIdentityKeyring?: PriorIdentityKeyringConfig | null;
  /**
   * The access-token signing key of the api entry (./jwt.ts, B1-02h). Null when no JWT_* variable
   * is set: local / test then sign with an ephemeral key pair, staging / prod refuse to start
   * when identity's key provider is created. A hand-built config without it counts as null.
   */
  readonly jwt: JwtKeyConfig | null;
  /**
   * The verify-only reading of the same JWT_* variables (./jwt.ts, B1-02zj, D10-255 ①): JWT_KEY_ID,
   * its public key (JWT_PUBLIC_KEY_PEM, or derived from JWT_PRIVATE_KEY_PEM) and
   * JWT_VERIFY_KEYS_JSON, used by entries that only verify access tokens (stream). Present only
   * when it is complete; absent (or null) otherwise, and a hand-built config without it falls back
   * to the public half of `jwt`.
   */
  readonly jwtVerify?: JwtVerifyKeyConfig | null;
  /**
   * TRUSTED_PROXIES (./trusted-proxies.ts, B1-03m): addresses / ranges of the gateways whose
   * X-Forwarded-For entries every HTTP entry believes when deriving `request.ip`. Empty (unset)
   * trusts no forwarded header; a hand-built config without it counts as empty.
   */
  readonly trustedProxies?: readonly string[];
  /**
   * ADMIN_TOKEN_SIGNING_KEY / ADMIN_IP_ALLOWLIST / ADMIN_CORS_ORIGIN (./admin-auth.ts, F1-06k).
   * Null when none is set: local / test sign admin tokens with a per-process random key and allow
   * loopback sources only; staging / prod refuse to start the admin entry. A hand-built config
   * without it counts as null.
   */
  readonly adminAuth?: AdminAuthConfig | null;
  /**
   * PDD_CLIENT_ID / PDD_CLIENT_SECRET_FILE (./pdd.ts, B1-04t): staging only, both or neither. The
   * secret file is read once by the union module's startup factory; this holds only the id and the
   * path. A hand-built config without it counts as null.
   */
  readonly pdd?: PddClientConfig | null;
  /**
   * PDD_QUERY_CUSTOM_PARAMETERS (./pdd-query.ts, B1-04x): the custom_parameters JSON text of the
   * Pinduoduo query identity, a server setting (not a credential), kept verbatim. Null when unset
   * in any environment; a hand-built config without it counts as null.
   */
  readonly pddQueryCustomParameters?: string | null;
  /**
   * TAOBAO_APP_KEY / TAOBAO_APP_SECRET_FILE (./taobao.ts, B1-04k): staging only, both or neither.
   * The secret file is read once by the union module's startup factory; this holds only the app key
   * and the path. Absent when not configured; a hand-built config without it counts as null.
   */
  readonly taobao?: TaobaoAppConfig | null;
  /**
   * DATAOKE_APP_KEY / DATAOKE_APP_SECRET_FILE (./dataoke.ts, B1-04e): staging only, both or neither;
   * the 大淘客 order source of the live Taobao adapter. The secret file is read once by the union
   * module's startup factory; this holds only the app key and the path. Absent when not
   * configured; a hand-built config without it counts as null.
   */
  readonly dataoke?: DataokeAppConfig | null;
  /**
   * JD_APP_KEY / JD_APP_SECRET_FILE (./jd.ts, B1-04ze): staging only, both or neither. The secret
   * file is read once by the union module's startup factory; this holds only the app key and the
   * path. Absent when not configured; a hand-built config without it counts as null.
   */
  readonly jd?: JdAppConfig | null;
  /**
   * JD_SITE_ID (B1-04ze, D10-500 ①): the Jingdong site id as decimal text, a server setting (not a
   * credential), used by link conversion (B1-04zd). Absent when unset in any environment; a
   * hand-built config without it counts as null.
   */
  readonly jdSiteId?: string | null;
  /**
   * UNION_ENDPOINT_OVERRIDE_DIR (./union-endpoint-override.ts, B1-04y): staging only, an absolute
   * path of the mounted directory the UNION_ENDPOINTS factory reads <platform>.json from instead
   * of the packaged config/union-endpoints/. Existence is not checked here. Null when unset; a
   * hand-built config without it counts as null.
   */
  readonly unionEndpointOverrideDir?: string | null;
  /**
   * TAOBAO_CONVERT_SOURCE (B1-04zn, D10-530): where the live Taobao adapter converts links,
   * 'baichuan' (default) or 'dataoke'. A server setting, not a credential; any APP_ENV may set it.
   * A hand-built config without it counts as 'baichuan'.
   */
  readonly taobaoConvertSource?: 'baichuan' | 'dataoke';
  /**
   * TAOBAO_SEARCH_SOURCE (B1-04zn, D10-530): where the live Taobao adapter searches, 'official'
   * (default), 'dataoke' or, since B1-04zy, 'official_first' (official, falling back to 大淘客). A
   * server setting, not a credential; any APP_ENV may set it. A hand-built config without it counts
   * as 'official'.
   */
  readonly taobaoSearchSource?: 'official' | 'dataoke' | 'official_first';
  /**
   * AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID / _SECRET / AGENT_REVIEW_ALIYUN_ENDPOINT (./agent-review.ts,
   * B3-03m): staging / prod only, the stream entry's content safety review. Absent (the key is
   * left out of loadConfig's result) or null: the review fails closed. A hand-built config without
   * it counts as null.
   */
  readonly agentReview?: AgentReviewConfig | null;
  /**
   * SMS_ACCESS_KEY_ID / SMS_ACCESS_KEY_SECRET / SMS_SIGN_NAME / SMS_TEMPLATE_VERIFY_CODE
   * (./sms.ts, B1-12w): staging / prod only, the Aliyun SendSms channel of the verification code.
   * Absent (left out of loadConfig's result) or null: the entry keeps the sender that rejects
   * every message. A hand-built config without it counts as null.
   */
  readonly sms?: SmsConfig | null;
  /**
   * STAGING_TEST_PHONES / STAGING_TEST_SMS_CODE_FILE (./staging-test-phones.ts, B1-02zza, D10-611):
   * staging only, both or neither; the numbers and the path of the fixed-code file (never the
   * code). Absent or null: no test phone. A hand-built config without it counts as null.
   */
  readonly stagingTestPhones?: StagingTestPhoneConfig | null;
  /**
   * AGENT_USER_HASH_KEY (./agent-user-hash.ts, B3-09j; BR-AI-22): HMAC key of agent's deletion
   * purge. loadConfig fills it (null when unset outside prod; prod refuses to start without it).
   * A hand-built config without it counts as null: the agent cleanup port stays unavailable.
   */
  readonly agentUserHashKey?: string | null;
  /**
   * METRICS_PORT / METRICS_HOST (B1-01zzh): the internal Prometheus /metrics listener of every
   * entry (not on the Nest application, not in the OpenAPI contract). Present only when
   * METRICS_PORT is set; host defaults to 127.0.0.1. A hand-built config without it opens none.
   */
  readonly metrics?: MetricsConfig | undefined;
  /**
   * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_TRACES_SAMPLER_ARG / OTEL_SERVICE_NAME (B1-31,
   * 规划/02 §13): trace export of the api / stream / worker entries. Present only when the endpoint
   * is set; a hand-built config without it exports nothing and installs no instrumentation.
   */
  readonly tracing?: TracingConfig | undefined;
  /**
   * QUEUE_CONCURRENCY_<Q> / QUEUE_DB_BUDGET (./queue-concurrency.ts, B1-01zzk): the worker's
   * per-queue concurrency overrides (only lower than ENTRY_PLAN) and its shared budget of handler
   * calls running at once. Present only when one of them is set; a hand-built config without it
   * runs the plan's concurrency with the default budget.
   */
  readonly queueLimits?: QueueLimits | undefined;
  /**
   * PAY_* (./pay-channels.ts, B2-15k): names and paths of the real collection channels, read by the
   * api, worker and admin entries only (loadConfig's entry argument). Absent or null: no real
   * channel, the payment module's factory fails closed. Never holds a key.
   */
  readonly payChannels?: PayChannelsConfig | null | undefined;
}

/** Where the internal /metrics listener binds (B1-01zzh). */
export interface MetricsConfig {
  readonly port: number;
  readonly host: string;
}

/** The trace export of an entry (B1-31): OTLP/HTTP endpoint, sampling ratio, service name. */
export interface TracingConfig {
  readonly endpoint: string;
  /** 0..1; 1 = every new trace is sampled. */
  readonly sampleRatio: number;
  /** service.name of the spans; undefined = `couli-<entry>`. */
  readonly serviceName?: string | undefined;
}

/** Thrown by `loadConfig`; `problems` lists every finding. Messages never contain values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid environment configuration:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Startup assertions that depend on the environment name (ADR-0001 §4.2 #10, 规划/11 §8). */
export function startupViolations(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const violations: string[] = [];
  if (appEnv === 'prod' && (env['CLOCK_NOW'] ?? '') !== '') {
    violations.push(
      'CLOCK_NOW: must not be set when APP_ENV=prod (the production clock is real time)',
    );
  }
  if (appEnv === 'local' || appEnv === 'test') {
    for (const name of findCredentialLikeEnvNames(env)) {
      violations.push(
        `${name}: looks like a real third-party credential; APP_ENV=${appEnv} only runs fake adapters, unset it`,
      );
    }
  }
  return violations;
}

/**
 * The JWT key part of loadConfig: its problems are merged only when at least one JWT_* variable is
 * set, so an environment without them keeps exactly its other problems; a missing cloud key is
 * refused at startup by identity's key providers (contract in ./jwt.ts).
 * B1-02zj (D10-255 ①): every entry loads the same configuration, so the problems are those of the
 * verify-only reading (format, key pair, kid, previous keys). JWT_KEY_ID + JWT_PUBLIC_KEY_PEM alone
 * is valid configuration: `jwt` (the signing key) is then null and the signing entry (api) refuses
 * to start when identity creates its key provider; `jwtVerify` carries the verification keys.
 */
function readJwt(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): {
  readonly jwt: JwtKeyConfig | null;
  readonly jwtVerify: JwtVerifyKeyConfig | null;
  readonly problems: readonly string[];
} {
  const set = JWT_ENV_NAMES.some((name) => (env[name] ?? '') !== '');
  if (!set) return { jwt: null, jwtVerify: null, problems: [] };
  const verify = readJwtVerifyKeyConfig(appEnv, env);
  if (verify.problems.length > 0) return { jwt: null, jwtVerify: null, problems: verify.problems };
  // Valid for verification; signing additionally needs the private key (null when it is absent).
  return { jwt: readJwtKeyConfig(appEnv, env).jwt, jwtVerify: verify.jwt, problems: [] };
}

/**
 * Validates the environment and returns the typed configuration. Variables set to an empty
 * string count as unset. Throws one `ConfigError` listing every problem.
 * `entry` (B2-15k, BR-PAY-08 ①): the collection channel variables are read only with it, and only on
 * the api, worker and admin entries; bootstrap.ts and entry.ts pass it, tracing/boot.ts does not.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  entry?: EntryName,
): AppConfig {
  const input: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') input[key] = value;
  }

  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(environment)'}: ${issue.message}`,
    );
    // APP_ENV-dependent assertions still run when APP_ENV itself is valid.
    const appEnv = z.enum(APP_ENVS).safeParse(input['APP_ENV']);
    if (appEnv.success) {
      problems.push(...startupViolations(appEnv.data, env));
      problems.push(...readKmsConfig(appEnv.data, env).problems);
      problems.push(...readKeyringConfig(appEnv.data, env).problems);
      problems.push(...readPriorIdentityKeyringConfig(appEnv.data, env).problems);
      problems.push(...readJwt(appEnv.data, env).problems);
    }
    problems.push(...readTrustedProxies(env).problems);
    problems.push(...readAdminAuthConfig(appEnv.success ? appEnv.data : undefined, env).problems);
    problems.push(...readMediaConfig(appEnv.success ? appEnv.data : undefined, env).problems);
    problems.push(...readExportStoreConfig(appEnv.success ? appEnv.data : undefined, env).problems);
    if (appEnv.success) problems.push(...readPddConfig(appEnv.data, env).problems);
    if (appEnv.success) problems.push(...readTaobaoConfig(appEnv.data, env).problems);
    if (appEnv.success) problems.push(...readDataokeConfig(appEnv.data, env).problems);
    if (appEnv.success) problems.push(...readJdConfig(appEnv.data, env).problems);
    problems.push(...readJdSiteConfig(env).problems);
    problems.push(...readPddQueryConfig(env).problems);
    problems.push(...readTaobaoSourceConfig(env).problems);
    if (appEnv.success)
      problems.push(...readUnionEndpointOverrideConfig(appEnv.data, env).problems);
    if (appEnv.success) problems.push(...readAgentUserHashConfig(appEnv.data, env).problems);
    if (appEnv.success) problems.push(...readStagingTestPhoneConfig(appEnv.data, env).problems);
    problems.push(...readQueueConcurrencyConfig(env).problems);
    if (appEnv.success && entry !== undefined) {
      problems.push(...readPayChannelsConfig(appEnv.data, env, entry).problems);
    }
    throw new ConfigError(problems);
  }

  const values = parsed.data;
  const violations = startupViolations(values.APP_ENV, env);
  const { kms, problems: kmsProblems } = readKmsConfig(values.APP_ENV, env);
  violations.push(...kmsProblems);
  const { keyring, problems } = readKeyringConfig(values.APP_ENV, env);
  violations.push(...problems);
  const { priorIdentityKeyring, problems: priorIdentityProblems } = readPriorIdentityKeyringConfig(
    values.APP_ENV,
    env,
  );
  violations.push(...priorIdentityProblems);
  const { jwt, jwtVerify, problems: jwtProblems } = readJwt(values.APP_ENV, env);
  violations.push(...jwtProblems);
  const { trustedProxies, problems: proxyProblems } = readTrustedProxies(env);
  violations.push(...proxyProblems);
  const { adminAuth, problems: adminProblems } = readAdminAuthConfig(values.APP_ENV, env);
  violations.push(...adminProblems);
  const { mediaPublicBaseUrl, problems: mediaProblems } = readMediaConfig(values.APP_ENV, env);
  violations.push(...mediaProblems);
  const {
    exportStoreBaseUrl,
    exportStoreSigningKey,
    problems: exportStoreProblems,
  } = readExportStoreConfig(values.APP_ENV, env);
  violations.push(...exportStoreProblems);
  const { pdd, problems: pddProblems } = readPddConfig(values.APP_ENV, env);
  violations.push(...pddProblems);
  const { taobao, problems: taobaoProblems } = readTaobaoConfig(values.APP_ENV, env);
  violations.push(...taobaoProblems);
  const { dataoke, problems: dataokeProblems } = readDataokeConfig(values.APP_ENV, env);
  violations.push(...dataokeProblems);
  const { jd, problems: jdProblems } = readJdConfig(values.APP_ENV, env);
  violations.push(...jdProblems);
  const { payChannels, problems: payChannelProblems } =
    entry === undefined
      ? { payChannels: null, problems: [] }
      : readPayChannelsConfig(values.APP_ENV, env, entry);
  violations.push(...payChannelProblems);
  const { jdSiteId, problems: jdSiteProblems } = readJdSiteConfig(env);
  violations.push(...jdSiteProblems);
  const { pddQueryCustomParameters, problems: pddQueryProblems } = readPddQueryConfig(env);
  violations.push(...pddQueryProblems);
  const {
    taobaoConvertSource,
    taobaoSearchSource,
    problems: taobaoSourceProblems,
  } = readTaobaoSourceConfig(env);
  violations.push(...taobaoSourceProblems);
  const { unionEndpointOverrideDir, problems: overrideProblems } = readUnionEndpointOverrideConfig(
    values.APP_ENV,
    env,
  );
  violations.push(...overrideProblems);
  const { agentReview, problems: agentReviewProblems } = readAgentReviewConfig(values.APP_ENV, env);
  violations.push(...agentReviewProblems);
  const { agentUserHashKey, problems: agentUserHashProblems } = readAgentUserHashConfig(
    values.APP_ENV,
    env,
  );
  violations.push(...agentUserHashProblems);
  const { stagingTestPhones, problems: stagingTestPhoneProblems } = readStagingTestPhoneConfig(
    values.APP_ENV,
    env,
  );
  violations.push(...stagingTestPhoneProblems);
  const { queueLimits, problems: queueProblems } = readQueueConcurrencyConfig(env);
  violations.push(...queueProblems);
  if (violations.length > 0) throw new ConfigError(violations);
  const sms = readSmsConfig(values.APP_ENV, env);

  return {
    appEnv: values.APP_ENV,
    logLevel: values.LOG_LEVEL,
    clockNow: values.CLOCK_NOW,
    exitAfterInit: values.COULI_EXIT_AFTER_INIT === '1',
    apiHost: values.API_HOST,
    apiPort: values.API_PORT,
    streamPort: values.STREAM_PORT,
    adminPort: values.ADMIN_PORT,
    ...(values.COULI_DEPLOY_VERSION === undefined
      ? {}
      : { deployVersion: values.COULI_DEPLOY_VERSION }),
    keyring,
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(priorIdentityKeyring === null ? {} : { priorIdentityKeyring }),
    jwt,
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(jwtVerify === null ? {} : { jwtVerify }),
    trustedProxies,
    adminAuth,
    mediaPublicBaseUrl,
    exportStoreBaseUrl,
    exportStoreSigningKey,
    pdd,
    pddQueryCustomParameters,
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(taobao === null ? {} : { taobao }),
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(dataoke === null ? {} : { dataoke }),
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(jd === null ? {} : { jd }),
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(jdSiteId === null ? {} : { jdSiteId }),
    unionEndpointOverrideDir,
    taobaoConvertSource,
    taobaoSearchSource,
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(agentReview === null ? {} : { agentReview }),
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(sms === undefined ? {} : { sms }),
    agentUserHashKey,
    // Only present when configured (staging only, B1-02zza), so the documented shape of an
    // unconfigured result is unchanged.
    ...(stagingTestPhones === null ? {} : { stagingTestPhones }),
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(values.METRICS_PORT === undefined
      ? {}
      : { metrics: { port: values.METRICS_PORT, host: values.METRICS_HOST } }),
    // Only present when configured (B1-31), so the documented shape of an unconfigured result is unchanged.
    ...(values.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === undefined
      ? {}
      : {
          tracing: {
            endpoint: values.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
            sampleRatio: values.OTEL_TRACES_SAMPLER_ARG ?? 1,
            ...(values.OTEL_SERVICE_NAME === undefined
              ? {}
              : { serviceName: values.OTEL_SERVICE_NAME }),
          },
        }),
    // Only present when configured, so the documented shape of an unconfigured result is unchanged.
    ...(queueLimits === null ? {} : { queueLimits }),
    // Only on the entries that read it (B2-15k), same reason.
    ...(payChannels === null ? {} : { payChannels }),
    ...(kms === null ? {} : { kms }),
  };
}
