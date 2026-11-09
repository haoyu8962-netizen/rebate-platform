// k6 load-test options for QA-06a (规划/05 QA-06: search, link convert and Agent SSE at
// 3 x peak; upstreams are the QA-05a WireMock in infra/fault, never a real union API — 09 README
// §0.2 hard rule 5). Pure module: no Node built-ins, so the k6 entry script.ts (run by the
// grafana/k6 container, k6 >= 1.0 runs TypeScript) and the rule tests both import it. Scenario
// parameters and thresholds live in config.json next to this file; peaks point at 01 §7.3, P95
// targets at 01 §7.1.

/** Each scenario is also the name of its exec function in script.ts. */
export type ScenarioName = 'search' | 'convert' | 'agent_sse';

/** Which local base URL a scenario hits (api. / stream. / admin. entries of 02 §3). */
export type ServiceName = 'api' | 'stream' | 'admin';

/** Arrival-rate scenarios count requests per second; VU scenarios count concurrent streams. */
export type ExecutorName = 'ramping-arrival-rate' | 'ramping-vus';

/** SSE uses time to first byte as a proxy, not a measurement of the first complete event. */
export type LatencyMetric = 'http_req_duration' | 'http_req_waiting';

export interface ScenarioConfig {
  service: ServiceName;
  method: 'GET' | 'POST';
  /** Path relative to the service base URL, starting with a single '/'. */
  path: string;
  executor: ExecutorName;
  /** Peak load (positive integer): requests per second, or concurrent VUs for ramping-vus. */
  peak: number;
  /** k6 durations, e.g. '30s', '2m'. */
  ramp_up: string;
  hold: string;
  latency_metric: LatencyMetric;
  /** P95 threshold in milliseconds (positive integer). */
  p95_ms: number;
  /** Failed-request rate threshold, 0 < error_rate < 1. */
  error_rate: number;
  request_timeout?: string;
  pre_allocated_vus?: number;
  max_vus?: number;
}

export interface LoadConfig {
  /** Load factor over the peak; QA-06 fixes it at 3. */
  multiplier: number;
  base_urls: Partial<Record<ServiceName, string>>;
  scenarios: Partial<Record<ScenarioName, ScenarioConfig>>;
}

export interface K6Stage {
  duration: string;
  target: number;
}

export interface K6Scenario {
  executor: ExecutorName;
  exec: string;
  stages: K6Stage[];
  timeUnit?: string;
  startRate?: number;
  preAllocatedVUs?: number;
  maxVUs?: number;
  startVUs?: number;
  gracefulStop: string;
  gracefulRampDown?: string;
}

export interface K6Options {
  scenarios: Record<string, K6Scenario>;
  thresholds: Record<string, string[]>;
  maxRedirects: number;
}

export const scenarioNames: readonly ScenarioName[] = ['search', 'convert', 'agent_sse'];
const services: readonly ServiceName[] = ['api', 'stream', 'admin'];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Deliberately narrower than a URL parser; k6 has no dependency on Node's URL implementation. */
export function localBase(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|wiremock)(?::([0-9]{1,5}))?\/?$/.exec(value);
  return (
    match !== null &&
    (match[1] === undefined || (Number(match[1]) > 0 && Number(match[1]) <= 65535))
  );
}

export function duration(value: unknown): boolean {
  // A single positive unit suffices for this suite and avoids ambiguous k6 duration strings.
  return typeof value === 'string' && /^[1-9][0-9]*(?:ms|s|m|h)$/.test(value);
}

export function localPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?!\/)[^\\\s#]*$/.test(value);
}

/** Every rule violation of a config (empty array = usable); human-readable, one entry per problem. */
export function configProblems(config: LoadConfig): string[] {
  const problems: string[] = [];
  if (!object(config)) return ['config must be an object'];
  if (config.multiplier !== 3) problems.push('multiplier must be 3');
  if (!object(config.base_urls)) problems.push('base_urls must be an object');
  else {
    for (const [service, base] of Object.entries(config.base_urls)) {
      if (!services.includes(service as ServiceName) || !localBase(base)) {
        problems.push(`base_urls.${service}: only loopback or wiremock root URLs are allowed`);
      }
    }
  }
  if (!object(config.scenarios)) return [...problems, 'scenarios must be an object'];
  for (const name of Object.keys(config.scenarios)) {
    if (!scenarioNames.includes(name as ScenarioName)) problems.push(`unknown scenario: ${name}`);
  }
  for (const name of scenarioNames) {
    const s = config.scenarios[name];
    if (!object(s)) {
      problems.push(`missing scenario: ${name}`);
      continue;
    }
    const issue = (message: string): void => {
      problems.push(`${name}: ${message}`);
    };
    const service = name === 'agent_sse' ? 'stream' : 'api';
    if (s.service !== service || !localBase(config.base_urls?.[service]))
      issue(`missing or invalid service ${service}`);
    if (s.method !== (name === 'search' ? 'GET' : 'POST')) issue('invalid method');
    if (!localPath(s.path))
      issue('path must start with a single / and contain no fragment or backslash');
    if (s.executor !== (name === 'agent_sse' ? 'ramping-vus' : 'ramping-arrival-rate'))
      issue('invalid executor');
    if (!positiveInteger(s.peak) || !Number.isSafeInteger(s.peak * 3))
      issue('peak must be a positive safe integer');
    if (!duration(s.ramp_up) || !duration(s.hold))
      issue('ramp_up and hold must be positive durations');
    if (s.request_timeout !== undefined && !duration(s.request_timeout))
      issue('invalid request_timeout');
    if (s.latency_metric !== (name === 'agent_sse' ? 'http_req_waiting' : 'http_req_duration'))
      issue('invalid latency_metric');
    if (!positiveInteger(s.p95_ms)) issue('p95_ms must be a positive integer');
    const cap = name === 'agent_sse' ? 1000 : 1500;
    if (s.p95_ms > cap) issue(`p95_ms exceeds ${cap}`);
    if (!Number.isFinite(s.error_rate) || s.error_rate <= 0 || s.error_rate >= 1)
      issue('error_rate must be between 0 and 1 exclusively');
    for (const key of ['pre_allocated_vus', 'max_vus'] as const) {
      if (s[key] !== undefined && !positiveInteger(s[key]))
        issue(`${key} must be a positive integer`);
    }
    const allocated = s.pre_allocated_vus ?? s.peak * 3;
    if (s.max_vus !== undefined && s.max_vus < allocated)
      issue('max_vus is below pre_allocated_vus');
  }
  return problems;
}

/** Run-wide thresholds shared by every suite: check() failures and dropped iterations fail the run. */
export function baseThresholds(): Record<string, string[]> {
  // check() failures must fail the run, including HTTP 200 business failures and invalid SSE.
  return { checks: ['rate==1'], dropped_iterations: ['count==0'] };
}

/**
 * One k6 scenario plus its per-scenario thresholds, for an already validated scenario config:
 * ramp up to peak x multiplier, hold, ramp down to zero. Shared with the sync suite (QA-06c).
 */
export function scenarioOptions(
  name: string,
  s: ScenarioConfig,
  multiplier: number,
): { scenario: K6Scenario; thresholds: Record<string, string[]> } {
  const target = s.peak * multiplier;
  const scenario: K6Scenario = {
    executor: s.executor,
    exec: name,
    gracefulStop: s.request_timeout ?? '60s',
    stages: [
      { duration: s.ramp_up, target },
      { duration: s.hold, target },
      { duration: s.ramp_up, target: 0 },
    ],
  };
  if (s.executor === 'ramping-vus') {
    scenario.startVUs = 0;
    // Let in-flight streams complete their checks during ramp-down, up to their timeout.
    scenario.gracefulRampDown = scenario.gracefulStop;
  } else {
    scenario.startRate = 0;
    scenario.timeUnit = '1s';
    scenario.preAllocatedVUs = s.pre_allocated_vus ?? target;
    scenario.maxVUs = s.max_vus ?? scenario.preAllocatedVUs;
  }
  return {
    scenario,
    thresholds: {
      [`${s.latency_metric}{scenario:${name}}`]: [`p(95)<${s.p95_ms}`],
      [`http_req_failed{scenario:${name}}`]: [`rate<${s.error_rate}`],
    },
  };
}

/** k6 `options` for a valid config; throws (with the problems) on an invalid one. */
export function buildOptions(config: LoadConfig): K6Options {
  const problems = configProblems(config);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const options: K6Options = { scenarios: {}, thresholds: baseThresholds(), maxRedirects: 0 };
  for (const name of scenarioNames) {
    const { scenario, thresholds } = scenarioOptions(
      name,
      config.scenarios[name]!,
      config.multiplier,
    );
    options.scenarios[name] = scenario;
    Object.assign(options.thresholds, thresholds);
  }
  return options;
}

/**
 * Base URL per service: `LOAD_API_BASE_URL`, `LOAD_STREAM_BASE_URL`, `LOAD_ADMIN_BASE_URL`
 * override config.base_urls; any resulting URL outside loopback / the `wiremock` service throws.
 */
export function resolveBaseUrls(
  config: LoadConfig,
  env: Readonly<Record<string, string | undefined>>,
): Partial<Record<ServiceName, string>> {
  const base_urls = { ...config.base_urls };
  for (const service of services) {
    const override = env[`LOAD_${service.toUpperCase()}_BASE_URL`];
    if (override !== undefined) base_urls[service] = override;
  }
  const problems = configProblems({ ...config, base_urls });
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return Object.fromEntries(
    Object.entries(base_urls).map(([service, base]) => [service, base.replace(/\/$/, '')]),
  );
}
