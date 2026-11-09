// k6 load-test options for QA-06c: the admin manual order sync (POST /admin/v1/order-syncs,
// contracts/openapi.yaml adminCreateOrderSync) at 3 x its local peak share. Separate entry sync.ts
// and config sync.config.json next to this file; QA-06a's config.json / script.ts stay untouched.
// Pure module (no Node built-ins): the k6 container and the rule tests both import it. Targets are
// loopback or the infra/fault WireMock only (09 README §0.2 hard rule 5); prod is refused.
import type { components } from '../../../packages/contracts-ts/src/openapi.gen.ts';
import {
  baseThresholds,
  duration,
  localBase,
  positiveInteger,
  scenarioOptions,
  type K6Options,
  type ScenarioConfig,
} from './options.ts';

export interface SyncConfig {
  multiplier: number;
  base_urls: { admin: string };
  scenarios: { sync: ScenarioConfig };
  requests: { sync: components['schemas']['AdminOrderSyncCreateRequest'] };
}

export type SyncLimits = components['schemas']['AdminOrderSyncLimits'];
export type SyncEnv = Readonly<Record<string, string | undefined>>;

export interface SyncRequest {
  method: 'POST';
  url: string;
  body: string;
  params: {
    headers: Record<string, string>;
    redirects: number;
    timeout: string;
    tags: Record<string, string>;
  };
}

/** A GET of the per-platform limits (adminGetOrderSyncLimits), read once in setup(). */
export interface SyncLimitsRequest {
  method: 'GET';
  url: string;
  params: SyncRequest['params'];
}

/** The k6 response fields this suite reads. */
export interface SyncResponse {
  status: number;
  error_code: number;
  body: string | null;
}

export const SYNC_PATH = '/admin/v1/order-syncs';
export const SYNC_LIMITS_PATH = '/admin/v1/order-syncs/limits';

/** contracts/openapi.yaml PlatformCode. */
const platforms: readonly string[] = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
];
const bodyKeys: readonly string[] = ['platform', 'from', 'to', 'status_filter', 'order_nos'];
/** LOAD_ENV values; both mean "loopback or WireMock only". Staging is deliberately not offered. */
const targetEnvs: readonly string[] = ['local', 'wiremock'];
const syncStatuses: readonly string[] = ['queued', 'running', 'done', 'failed'];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ISO 8601 date-time with an explicit offset (contract: "ISO 8601 with offset"). */
function instant(value: unknown): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return NaN;
  return Date.parse(value);
}

function boundedString(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

/** Contract-shape problems of the request body (exactly one of the two forms). */
function bodyProblems(body: unknown): string[] {
  if (!object(body)) return ['requests.sync must be an object'];
  const problems: string[] = [];
  for (const key of Object.keys(body)) {
    // Identity (app, admin) comes from the admin token, never from the body.
    if (!bodyKeys.includes(key)) problems.push(`requests.sync: unknown field ${key}`);
  }
  if (typeof body['platform'] !== 'string' || !platforms.includes(body['platform']))
    problems.push('requests.sync.platform must be a contract PlatformCode');
  const byOrderNos = 'order_nos' in body;
  const byWindow = 'from' in body || 'to' in body || 'status_filter' in body;
  if (byOrderNos === byWindow) {
    problems.push('requests.sync must be exactly one form: order_nos, or from / to');
    return problems;
  }
  if (byOrderNos) {
    const nos = body['order_nos'];
    if (
      !Array.isArray(nos) ||
      nos.length < 1 ||
      nos.length > 50 ||
      !nos.every((no) => boundedString(no, 64))
    )
      problems.push('requests.sync.order_nos must hold 1-50 strings of 1-64 characters');
    return problems;
  }
  const from = instant(body['from']);
  const to = instant(body['to']);
  if (Number.isNaN(from) || Number.isNaN(to))
    problems.push('requests.sync.from / to must be ISO 8601 date-times with an offset');
  else if (!(from < to)) problems.push('requests.sync.from must be before to');
  if ('status_filter' in body && !boundedString(body['status_filter'], 64))
    problems.push('requests.sync.status_filter must be 1-64 characters');
  return problems;
}

/** Every rule violation of a sync config (empty array = usable). */
export function syncConfigProblems(config: unknown): string[] {
  if (!object(config)) return ['config must be an object'];
  const problems: string[] = [];
  if (config['multiplier'] !== 3) problems.push('multiplier must be 3');
  const bases = config['base_urls'];
  if (!object(bases)) problems.push('base_urls must be an object');
  else {
    for (const [service, base] of Object.entries(bases)) {
      if (service !== 'admin' || !localBase(base))
        problems.push(`base_urls.${service}: only an admin loopback or wiremock root URL`);
    }
    if (!('admin' in bases)) problems.push('base_urls.admin is required');
  }
  const scenarios = config['scenarios'];
  if (!object(scenarios)) return [...problems, 'scenarios must be an object'];
  for (const name of Object.keys(scenarios)) {
    if (name !== 'sync') problems.push(`unknown scenario: ${name}`);
  }
  const s = scenarios['sync'];
  if (!object(s)) problems.push('missing scenario: sync');
  else {
    const issue = (message: string): void => {
      problems.push(`sync: ${message}`);
    };
    if (s['service'] !== 'admin') issue('service must be admin');
    if (s['method'] !== 'POST') issue('method must be POST');
    if (s['path'] !== SYNC_PATH) issue(`path must be ${SYNC_PATH}`);
    if (s['executor'] !== 'ramping-arrival-rate') issue('executor must be ramping-arrival-rate');
    const peak = s['peak'];
    if (!positiveInteger(peak) || !Number.isSafeInteger(peak * 3))
      issue('peak must be a positive safe integer');
    if (!duration(s['ramp_up']) || !duration(s['hold']))
      issue('ramp_up and hold must be positive durations');
    if (s['request_timeout'] !== undefined && !duration(s['request_timeout']))
      issue('invalid request_timeout');
    if (s['latency_metric'] !== 'http_req_duration')
      issue('latency_metric must be http_req_duration');
    if (!positiveInteger(s['p95_ms'])) issue('p95_ms must be a positive integer');
    const rate = s['error_rate'];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate >= 1)
      issue('error_rate must be between 0 and 1 exclusively');
    for (const key of ['pre_allocated_vus', 'max_vus']) {
      if (s[key] !== undefined && !positiveInteger(s[key]))
        issue(`${key} must be a positive integer`);
    }
    const allocated = s['pre_allocated_vus'] ?? (positiveInteger(peak) ? peak * 3 : 0);
    const max = s['max_vus'];
    if (typeof max === 'number' && typeof allocated === 'number' && max < allocated)
      issue('max_vus is below pre_allocated_vus');
  }
  const requests = config['requests'];
  if (!object(requests)) problems.push('requests must be an object');
  else problems.push(...bodyProblems(requests['sync']));
  return problems;
}

function assertConfig(config: SyncConfig): void {
  const problems = syncConfigProblems(config);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/** k6 `options` with the single sync scenario; throws (with the problems) on an invalid config. */
export function buildSyncOptions(config: SyncConfig): K6Options {
  assertConfig(config);
  const { scenario, thresholds } = scenarioOptions(
    'sync',
    config.scenarios.sync,
    config.multiplier,
  );
  return {
    scenarios: { sync: scenario },
    thresholds: { ...thresholds, ...baseThresholds() },
    maxRedirects: 0,
  };
}

/**
 * Admin root URL: `LOAD_ADMIN_BASE_URL` overrides config.base_urls.admin; `LOAD_ENV` (default
 * local) must be local or wiremock. Anything outside loopback / the wiremock service throws.
 */
export function resolveSyncBaseUrl(config: SyncConfig, env: SyncEnv): string {
  const target = env['LOAD_ENV'] ?? 'local';
  if (!targetEnvs.includes(target))
    throw new Error('LOAD_ENV must be local or wiremock; prod and staging are refused');
  const override = env['LOAD_ADMIN_BASE_URL'];
  // A config without base_urls is still refused by assertConfig below.
  const bases: unknown = config.base_urls;
  const admin: unknown =
    override !== undefined ? override : object(bases) ? bases['admin'] : undefined;
  assertConfig({ ...config, base_urls: { admin } } as SyncConfig);
  return (admin as string).replace(/\/$/, '');
}

/** The admin token from the environment; never echoed in errors, bodies or tags. */
function adminToken(env: SyncEnv): string {
  const token = env['LOAD_ADMIN_TOKEN'];
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token))
    throw new Error(
      'LOAD_ADMIN_TOKEN is required: a local admin token (order.view) of visible ASCII, no whitespace',
    );
  return token;
}

function params(config: SyncConfig, token: string, json: boolean): SyncRequest['params'] {
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
  };
  if (json) headers['Content-Type'] = 'application/json';
  return {
    headers,
    redirects: 0,
    timeout: config.scenarios.sync.request_timeout ?? '60s',
    tags: { scenario: 'sync' },
  };
}

/** GET of the limits; validates config, target and token like the POST does. */
export function buildSyncLimitsRequest(config: SyncConfig, env: SyncEnv): SyncLimitsRequest {
  assertConfig(config);
  const base = resolveSyncBaseUrl(config, env);
  const token = adminToken(env);
  return { method: 'GET', url: base + SYNC_LIMITS_PATH, params: params(config, token, false) };
}

/** True when the body is the order_nos form (no limits needed). */
export function syncNeedsLimits(config: SyncConfig): boolean {
  return !('order_nos' in config.requests.sync);
}

/**
 * The POST of one manual sync, exactly the configured body. A time window needs `limits` (the
 * `data` of GET limits) and must not start before that platform's earliest_from.
 */
export function buildSyncRequest(
  config: SyncConfig,
  env: SyncEnv,
  limits?: SyncLimits,
): SyncRequest {
  assertConfig(config);
  const base = resolveSyncBaseUrl(config, env);
  const token = adminToken(env);
  const body = config.requests.sync;
  if (syncNeedsLimits(config)) {
    const items: unknown = object(limits) ? limits['items'] : undefined;
    const item = Array.isArray(items)
      ? (items as unknown[]).find((entry) => object(entry) && entry['platform'] === body.platform)
      : undefined;
    const earliest = object(item) ? instant(item['earliest_from']) : NaN;
    if (Number.isNaN(earliest))
      throw new Error(`no order-sync limits for platform ${body.platform}; window form needs them`);
    if (instant(body.from) < earliest)
      throw new Error(
        `requests.sync.from is earlier than earliest_from of ${body.platform}; move the window`,
      );
  }
  return {
    method: 'POST',
    url: base + SYNC_PATH,
    body: JSON.stringify(body),
    params: params(config, token, true),
  };
}

function envelope(response: SyncResponse): Record<string, unknown> | undefined {
  if (response.status !== 200 || response.error_code || response.body === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(response.body);
    return object(parsed) && parsed['code'] === 0 && object(parsed['data'])
      ? parsed['data']
      : undefined;
  } catch {
    return undefined;
  }
}

/** The limits `data` of a GET limits response; throws (status only, no body or token) otherwise. */
export function syncLimitsFromResponse(response: SyncResponse): SyncLimits {
  const data = envelope(response);
  const items = data?.['items'];
  if (
    !Array.isArray(items) ||
    !items.every(
      (item) =>
        object(item) &&
        typeof item['platform'] === 'string' &&
        !Number.isNaN(instant(item['earliest_from'])) &&
        Number.isSafeInteger(item['max_order_nos']),
    )
  )
    throw new Error(
      `GET ${SYNC_LIMITS_PATH} failed (HTTP ${String(response.status)}); check LOAD_ADMIN_TOKEN and the target`,
    );
  return { items } as SyncLimits;
}

/** A successful sync response: HTTP 200, code 0 and an AdminOrderSyncCreated body. */
export function syncResponseOk(response: SyncResponse): boolean {
  const data = envelope(response);
  return (
    data !== undefined &&
    typeof data['sync_id'] === 'string' &&
    typeof data['status'] === 'string' &&
    syncStatuses.includes(data['status']) &&
    typeof data['reused'] === 'boolean'
  );
}
