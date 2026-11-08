// Kill-switch drill (规划/05 QA-05「开关切换演练」; 规划/02 §14 降级表的「开关」列; 规划/04 §10.2 紧急开关
// 10 秒内生效; F1-10b 注册表 apps/api/src/modules/content/domain/switch-registry.ts). The rule tests in
// test/spec/drills/switches/** fix the semantics below; README.md next to this file is the runbook.
//
// Scope: only the non-fund switches of the §14 table that F1-10b registers as admin-editable:
// agent.enabled, jev.enabled, parse.tpwd.enabled and convert.enabled.<platform>. payout.*, pay.* and
// withdraw.* are refused before any read or write; agent.model_route (read only), sms.provider and
// agent.result_check.provider (not kill switches) are refused as well — the drill never falls back to
// the config-center endpoints to reach them. Of the four, a real run can only observe
// convert.enabled.<platform> through the contracts (switchObservationOf; the CLI refuses the rest).
//
// Target: APP_ENV local with a loopback origin, or APP_ENV staging with the explicit staging flag and
// an https origin registered in trusted configuration. Anything else, prod included, is refused
// before any API call. Credentials only travel in request headers and never reach a result.
//
// One case per key, strictly one after another:
//   read (fresh list) → baseline probe (must be a healthy answer: code 0 and not degraded; the
//   observation is kept) → PUT degraded value with the row's version → probe until the §14
//   degradation is observed (≤ 10 s) → PUT the captured original value with the current version →
//   probe until the observation equals the kept baseline again (≤ 10 s). An observation counts only
//   when it comes back inside its window; a match that arrives late is a timeout.
// Every PUT carries its own step-up token (createSwitchApi): a token is never sent twice, and the
// token for the restoring PUT is obtained before the degrading PUT is sent.
// Every possibly committed write is restored, also after a probe error, a lost PUT response or a
// SIGINT/SIGTERM (signal); cancellation stops new cases and the degradation wait, never the
// restoration or its recovery probe. The first failing case ends the batch.

import { switchSpecOf } from '../../../apps/api/src/modules/content/domain/switch-registry.ts';
import type { components } from '../../../packages/contracts-ts/src/openapi.gen.ts';

export type SwitchRow = components['schemas']['AdminKillSwitch'];
export type SwitchValue = components['schemas']['AdminConfigValue'];

/** 规划/02 §14 degradation each drilled switch must show. */
export type SwitchBehaviour = 'conversion_closed' | 'title_search' | 'no_model' | 'rules_only';

export type SwitchCase = {
  readonly key: string;
  readonly degradedValue: false;
  readonly behaviour: SwitchBehaviour;
};

export interface SwitchTarget {
  readonly appEnv: string;
  readonly baseUrl: string;
  readonly staging: boolean;
  /** Trusted deployment configuration, not an arbitrary CLI allow-host flag. */
  readonly stagingOrigins: readonly string[];
}

export interface SwitchApi {
  list(): Promise<readonly SwitchRow[]>;
  update(key: string, value: SwitchValue, expectedVersion: number): Promise<SwitchRow>;
}

/** Observed demo/staging behaviour; a changed config value alone is insufficient evidence. */
export interface Observation {
  readonly code: number;
  readonly modelCalled?: boolean;
  readonly judgeCalled?: boolean;
  readonly cards?: boolean;
  readonly fixedCopy?: boolean;
  readonly specPending?: boolean;
  readonly semanticPrecheckSkipped?: boolean;
  readonly guideTitleSearch?: boolean;
}

export interface ProbeBudget {
  readonly timeoutMs: number;
}

export interface SwitchDrillOptions {
  readonly target: SwitchTarget;
  readonly keys: readonly string[];
  readonly api: SwitchApi;
  /**
   * Must bound its own duration (a hanging probe would hold up restoration); `budget.timeoutMs`
   * is what is left of the current effect window, an answer after it is not counted anyway.
   */
  readonly probe: (key: string, budget?: ProbeBudget) => Promise<Observation>;
  readonly clock: { now(): Date };
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
}

export type SwitchProblemCode =
  | 'interrupted'
  | 'read_failed'
  | 'missing_switch'
  | 'readonly_switch'
  | 'unexpected_value'
  | 'baseline_degraded'
  | 'baseline_unhealthy'
  | 'probe_failed'
  | 'write_failed'
  | 'degradation_timeout'
  | 'restore_failed'
  | 'recovery_timeout'
  | 'incomplete'
  | 'record_failed';

export interface SwitchDrillResult {
  readonly ok: boolean;
  /** `key` is `*` for problems of the whole batch. Codes only, never upstream messages. */
  readonly problems: readonly { readonly key: string; readonly code: string }[];
  /** Keys whose captured original value is confirmed back after a (possibly committed) write. */
  readonly restored: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type SwitchDrillErrorCode =
  | 'invalid_option'
  | 'unsafe_target'
  | 'forbidden_switch'
  | 'unregistered_switch'
  | 'readonly_switch'
  | 'out_of_scope'
  | 'record_in_repo'
  | 'probe_unavailable'
  | 'unobservable_switch'
  | 'step_up_unavailable'
  | 'api_error';

/** Carries a code only: messages never include URLs, tokens or upstream text. */
export class SwitchDrillError extends Error {
  declare readonly code: SwitchDrillErrorCode;

  constructor(code: SwitchDrillErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'SwitchDrillError';
    this.code = code;
  }
}

/** Effect window of 规划/04 §10.2, used separately for degradation and for recovery. */
export const EFFECT_WINDOW_MS = 10_000;
/** Divides EFFECT_WINDOW_MS, so the last probe lands exactly on the window's end. */
export const POLL_MS = 500;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Fund switches are a separate batch (QA-05c 硬边界), refused even when mixed with safe keys. */
const FUND_PREFIXES = ['payout', 'pay', 'withdraw'];
/**
 * How a real run can observe a switch's §14 degradation through existing contract endpoints:
 * - `convert_link`: POST /v1/links/convert (convertLink) of that platform answers 50301 when off and
 *   code 0 when on (probe.ts);
 * - `unobservable`: no contract endpoint tells the degraded answer from the normal one on a local or
 *   staging stack, so a real run refuses the key (`unobservable_switch`) before anything is written.
 */
export type SwitchObservation =
  | { readonly kind: 'convert_link' }
  | {
      readonly kind: 'unobservable';
      readonly reason: 'model_call_not_exposed' | 'judge_call_not_exposed' | 'baseline_same_code';
    };

/** 规划/02 §14 switch column ∩ F1-10b registry patterns: degradation and how a real run sees it. */
const DRILLABLE: Readonly<
  Record<string, { readonly behaviour: SwitchBehaviour; readonly observation: SwitchObservation }>
> = Object.freeze({
  // Whether the model was called is not in any response of the contracts.
  'agent.enabled': {
    behaviour: 'no_model',
    observation: { kind: 'unobservable', reason: 'model_call_not_exposed' },
  },
  // Whether Jev was called (and the semantic precheck skipped) is not in any response either.
  'jev.enabled': {
    behaviour: 'rules_only',
    observation: { kind: 'unobservable', reason: 'judge_call_not_exposed' },
  },
  // parseInput answers 30132 for a password with the switch on as well: non-production stacks only
  // run the demo union adapter, which recognises no password (real parsing waits on the Taobao
  // password permission), so the baseline already looks degraded.
  'parse.tpwd.enabled': {
    behaviour: 'title_search',
    observation: { kind: 'unobservable', reason: 'baseline_same_code' },
  },
  'convert.enabled.<platform>': {
    behaviour: 'conversion_closed',
    observation: { kind: 'convert_link' },
  },
});

/** How a real run observes `key`; null for a key planSwitchDrill refuses. */
export function switchObservationOf(key: string): SwitchObservation | null {
  const spec = switchSpecOf(key);
  return spec === null ? null : (DRILLABLE[spec.pattern]?.observation ?? null);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function assertSwitchTarget(target: SwitchTarget): void {
  const url = typeof target.baseUrl === 'string' ? parseUrl(target.baseUrl) : null;
  // Exactly an origin: no credentials, path, query or fragment, no unnormalised spelling.
  if (url === null || url.origin === 'null' || url.origin !== target.baseUrl) {
    throw new SwitchDrillError('unsafe_target');
  }
  if (target.appEnv === 'local' && target.staging === false) {
    if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname))
      return;
    throw new SwitchDrillError('unsafe_target');
  }
  if (
    target.appEnv === 'staging' &&
    target.staging === true &&
    url.protocol === 'https:' &&
    Array.isArray(target.stagingOrigins) &&
    target.stagingOrigins.includes(url.origin)
  ) {
    return;
  }
  throw new SwitchDrillError('unsafe_target');
}

function isFundKey(key: string): boolean {
  return FUND_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

/** Explicit §14 allowlist intersected with the real F1-10b registry; preflight all keys. */
export function planSwitchDrill(keys: readonly string[]): readonly SwitchCase[] {
  if (!Array.isArray(keys) || keys.length === 0) throw new SwitchDrillError('invalid_option');
  if (keys.some((key) => typeof key !== 'string' || key.length === 0)) {
    throw new SwitchDrillError('invalid_option');
  }
  if (new Set(keys).size !== keys.length) throw new SwitchDrillError('invalid_option');
  // A fund key anywhere refuses the whole batch first, whatever else is wrong with it.
  if (keys.some(isFundKey)) throw new SwitchDrillError('forbidden_switch');
  return keys.map((key) => {
    const spec = switchSpecOf(key);
    if (spec === null) throw new SwitchDrillError('unregistered_switch', key);
    if (!spec.adminEditable) throw new SwitchDrillError('readonly_switch', key);
    const entry = DRILLABLE[spec.pattern];
    if (entry === undefined || spec.valueType.kind !== 'boolean') {
      throw new SwitchDrillError('out_of_scope', key);
    }
    return Object.freeze({ key, degradedValue: false as const, behaviour: entry.behaviour });
  });
}

/** The complete §14 degradation; a partial match (or a bare config change) is not a pass. */
export function matchesDegradation(scenario: SwitchCase, observation: Observation): boolean {
  const o = observation;
  switch (scenario.behaviour) {
    case 'conversion_closed':
      // 50301 (BR-PROD-10): this platform's conversion is closed.
      return o.code === 50301;
    case 'title_search':
      // 30132 with the "search by product title" guidance.
      return o.code === 30132 && o.guideTitleSearch === true;
    case 'no_model':
      // Keyword search still yields cards plus the fixed copy, without any model call.
      return o.code === 0 && o.modelCalled === false && o.cards === true && o.fixedCopy === true;
    case 'rules_only':
      // Result check falls back to rules: cards still shown, marked spec-pending, precheck skipped.
      return (
        o.code === 0 &&
        o.judgeCalled === false &&
        o.cards === true &&
        o.specPending === true &&
        o.semanticPrecheckSkipped === true
      );
    default:
      return false;
  }
}

/** The answer a working feature gives: success, and not the degradation. Errors never qualify. */
export function isHealthy(scenario: SwitchCase, observation: Observation): boolean {
  return observation.code === 0 && !matchesDegradation(scenario, observation);
}

const OBSERVATION_FIELDS = [
  'code',
  'modelCalled',
  'judgeCalled',
  'cards',
  'fixedCopy',
  'specPending',
  'semanticPrecheckSkipped',
  'guideTitleSearch',
] as const;

/** Recovery means the very behaviour seen at the baseline, field by field. */
export function sameObservation(baseline: Observation, observation: Observation): boolean {
  return OBSERVATION_FIELDS.every((field) => observation[field] === baseline[field]);
}

type Problem = { readonly key: string; readonly code: SwitchProblemCode };

/** Resolves when `signal` aborts (immediately if it already has); `dispose` drops the listener. */
function abortion(signal: AbortSignal): { readonly promise: Promise<'aborted'>; dispose(): void } {
  let dispose = (): void => {};
  const promise = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    const onAbort = (): void => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose: () => dispose() };
}

type Outcome =
  | { readonly outcome: 'ok'; readonly observation: Observation }
  | {
      readonly outcome: 'timeout' | 'aborted' | 'probe_failed';
      /** The last observation counted inside the window, if any. */
      readonly last: Observation | null;
    };

/**
 * Probes `key` until `accept` holds or EFFECT_WINDOW_MS has passed since the first probe. An
 * observation only counts when it is back by the deadline (exactly EFFECT_WINDOW_MS still
 * counts); one that returns later ends the wait as a timeout, whatever it shows. With
 * `cancellable`, an abort ends the wait at once, even while a probe is still pending; without it
 * the wait is cleanup and cannot be cancelled. `failOnError`: a probe rejection ends the wait;
 * otherwise it counts as a not-yet-accepted observation.
 */
async function awaitObservation(
  options: SwitchDrillOptions,
  key: string,
  accept: (observation: Observation) => boolean,
  cancellable: boolean,
  failOnError: boolean,
): Promise<Outcome> {
  const deadline = options.clock.now().getTime() + EFFECT_WINDOW_MS;
  let last: Observation | null = null;
  for (;;) {
    if (cancellable && options.signal.aborted) return { outcome: 'aborted', last };
    let observation: Observation | 'aborted' | 'error';
    const stop = cancellable ? abortion(options.signal) : null;
    try {
      const timeoutMs = Math.max(0, deadline - options.clock.now().getTime());
      const probe = options.probe(key, { timeoutMs }).then(
        (value) => value,
        () => 'error' as const,
      );
      observation = await (stop === null ? probe : Promise.race([probe, stop.promise]));
    } catch {
      observation = 'error';
    } finally {
      stop?.dispose();
    }
    if (observation === 'aborted') return { outcome: 'aborted', last };
    // Time first: an answer (or error) that comes back after the window does not count.
    const left = deadline - options.clock.now().getTime();
    if (left < 0) return { outcome: 'timeout', last };
    if (observation === 'error') {
      if (failOnError) return { outcome: 'probe_failed', last };
    } else {
      if (accept(observation)) return { outcome: 'ok', observation };
      last = observation;
    }
    if (left === 0) return { outcome: 'timeout', last };
    await options.sleep(Math.min(POLL_MS, left));
  }
}

async function readRows(api: SwitchApi): Promise<ReadonlyMap<string, SwitchRow> | null> {
  try {
    const rows = await api.list();
    return new Map(rows.map((row) => [row.key, row]));
  } catch {
    return null;
  }
}

/** Remote preconditions of one case: present, editable, boolean and currently the "on" value. */
function checkRow(row: SwitchRow | undefined): SwitchProblemCode | null {
  if (row === undefined) return 'missing_switch';
  if (row.admin_editable !== true) return 'readonly_switch';
  if (row.value_type !== 'boolean' || !Number.isInteger(row.version) || row.version < 0) {
    return 'unexpected_value';
  }
  // false is already degraded; null means "never written" and the default must not stand in
  // for a captured original value. Either way the drill does not touch it.
  if (row.value !== true) return 'unexpected_value';
  return null;
}

/**
 * Puts `original` back. `current` is the row the mutation returned, or null when the mutation's
 * outcome is unknown (then the row is read again first). Returns true once the original value is
 * confirmed. At most two writes, each with a freshly read version (CAS, never a blind retry).
 */
async function restoreValue(
  api: SwitchApi,
  key: string,
  original: boolean,
  current: SwitchRow | null,
): Promise<boolean> {
  let row = current;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (row === null) {
      const rows = await readRows(api);
      row = rows?.get(key) ?? null;
      if (row === null) return false;
    }
    if (row.value === original) return true;
    try {
      const written = await api.update(key, original, row.version);
      if (written.key === key && written.value === original) return true;
    } catch {
      // The write may still have committed; the next round reads before deciding.
    }
    row = null;
  }
  const rows = await readRows(api);
  return rows?.get(key)?.value === original;
}

export async function runSwitchDrill(options: SwitchDrillOptions): Promise<SwitchDrillResult> {
  // Both refuse before any API call or probe.
  assertSwitchTarget(options.target);
  const plan = planSwitchDrill(options.keys);

  const startedAt = options.clock.now().toISOString();
  const problems: Problem[] = [];
  const restored: string[] = [];
  const finish = (): SwitchDrillResult => ({
    ok: problems.length === 0 && restored.length === plan.length,
    problems: problems.map((problem) => ({ key: problem.key, code: problem.code })),
    restored: [...restored],
    startedAt,
    finishedAt: options.clock.now().toISOString(),
  });

  if (options.signal.aborted) {
    problems.push({ key: '*', code: 'interrupted' });
    return finish();
  }

  // Preflight the whole batch on one read: any missing / read-only / unexpected row → zero writes.
  let rows = await readRows(options.api);
  if (rows === null) {
    problems.push({ key: '*', code: 'read_failed' });
    return finish();
  }
  for (const scenario of plan) {
    const code = checkRow(rows.get(scenario.key));
    if (code !== null) problems.push({ key: scenario.key, code });
  }
  if (problems.length > 0) return finish();

  for (const [index, scenario] of plan.entries()) {
    const { key } = scenario;
    if (options.signal.aborted) {
      problems.push({ key, code: 'interrupted' });
      break;
    }
    if (index > 0) {
      // Capture the original value afresh: earlier cases took time.
      rows = await readRows(options.api);
      if (rows === null) {
        problems.push({ key, code: 'read_failed' });
        break;
      }
      const code = checkRow(rows.get(key));
      if (code !== null) {
        problems.push({ key, code });
        break;
      }
    }
    const before = rows.get(key);
    if (before === undefined || before.value !== true) break; // checked above
    const original = before.value;

    // The baseline must be a working answer; it is also what recovery has to show again.
    const baseline = await awaitObservation(
      options,
      key,
      (observation) => isHealthy(scenario, observation),
      true,
      true,
    );
    if (baseline.outcome !== 'ok') {
      problems.push({
        key,
        code:
          baseline.outcome === 'aborted'
            ? 'interrupted'
            : baseline.outcome === 'probe_failed'
              ? 'probe_failed'
              : baseline.last !== null && matchesDegradation(scenario, baseline.last)
                ? 'baseline_degraded'
                : 'baseline_unhealthy',
      });
      break;
    }
    const healthy = baseline.observation;
    if (options.signal.aborted) {
      problems.push({ key, code: 'interrupted' });
      break;
    }

    // From the PUT on, the switch may be degraded: whatever happens, restore it below.
    let mutated: SwitchRow | null = null;
    try {
      mutated = await options.api.update(key, scenario.degradedValue, before.version);
    } catch {
      problems.push({ key, code: 'write_failed' });
    }
    if (mutated !== null) {
      const degraded = await awaitObservation(
        options,
        key,
        (observation) => matchesDegradation(scenario, observation),
        true,
        true,
      );
      if (degraded.outcome === 'aborted') problems.push({ key, code: 'interrupted' });
      else if (degraded.outcome === 'probe_failed') problems.push({ key, code: 'probe_failed' });
      else if (degraded.outcome === 'timeout') {
        problems.push({ key, code: 'degradation_timeout' });
      }
    } else if (options.signal.aborted) {
      problems.push({ key, code: 'interrupted' });
    }

    // Cleanup: not cancellable. A value back in the config is not enough: within the effect
    // window the feature must answer exactly as it did at the baseline (an error such as 50001
    // is not a recovery just because it is not the degradation).
    if (await restoreValue(options.api, key, original, mutated)) {
      restored.push(key);
      const recovery = await awaitObservation(
        options,
        key,
        (observation) => sameObservation(healthy, observation),
        false,
        false,
      );
      if (recovery.outcome !== 'ok') problems.push({ key, code: 'recovery_timeout' });
    } else {
      problems.push({ key, code: 'restore_failed' });
    }

    if (problems.length > 0) break;
  }
  if (options.signal.aborted && !problems.some((problem) => problem.code === 'interrupted')) {
    problems.push({ key: '*', code: 'interrupted' });
  }
  return finish();
}

export interface HttpRequest {
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly redirect: 'error';
}

export type HttpTransport = (request: HttpRequest) => Promise<{ status: number; body: unknown }>;

export interface SwitchApiOptions {
  readonly target: SwitchTarget;
  readonly bearer: string;
  /**
   * A step-up token obtained beforehand. The server consumes a token with the operation it
   * guards, so this one is sent with at most one PUT; every later PUT needs `stepUpSource`.
   */
  readonly stepUpToken: string;
  /**
   * Obtains a new, unused step-up token (createStepUpSource: adminStepUp with the operator's
   * current authenticator code). Without it only one PUT can be sent.
   */
  readonly stepUpSource?: () => Promise<string>;
  readonly transport: HttpTransport;
}

const PAGE_SIZE = 200;
/** Far above the registry's size; stops a server that never stops paging. */
const MAX_PAGES = 50;

function isCredential(value: unknown): value is string {
  // Header values only: no control characters (header injection), no surrounding spaces.
  return typeof value === 'string' && /^[\x21-\x7e]+$/u.test(value);
}

function isRow(value: unknown): value is SwitchRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['key'] === 'string' &&
    typeof row['version'] === 'number' &&
    Number.isInteger(row['version']) &&
    typeof row['admin_editable'] === 'boolean' &&
    typeof row['value_type'] === 'string' &&
    'value' in row
  );
}

/** The `data` of a `{ code: 0 }` envelope; anything else is an error carrying only status/code. */
function envelopeData(response: { status: number; body: unknown }): unknown {
  const body = response.body as { code?: unknown; data?: unknown } | null | undefined;
  const code = typeof body === 'object' && body !== null ? body.code : undefined;
  if (response.status !== 200 || code !== 0) {
    const detail = `status ${String(response.status)}, code ${typeof code === 'number' ? String(code) : '-'}`;
    throw new SwitchDrillError('api_error', detail);
  }
  return body?.data;
}

async function sendEnvelope(transport: HttpTransport, request: HttpRequest): Promise<unknown> {
  let response: { status: number; body: unknown };
  try {
    response = await transport(request);
  } catch {
    // Transport errors may echo URLs or headers; keep only the fact.
    throw new SwitchDrillError('api_error', 'transport');
  }
  return envelopeData(response);
}

/**
 * Hands out step-up tokens so that none is ever sent twice: first the pre-obtained one, then new
 * ones from `source`. `reserve` obtains the next token ahead of time (before a degrading PUT, so
 * the restoring PUT does not depend on obtaining one while the switch is off).
 */
function stepUpTokens(first: string, source: (() => Promise<string>) | undefined) {
  const pool: string[] = [first];
  const obtain = async (): Promise<string> => {
    if (source === undefined) throw new SwitchDrillError('step_up_unavailable');
    let token: string;
    try {
      token = await source();
    } catch (error) {
      throw error instanceof SwitchDrillError ? error : new SwitchDrillError('step_up_unavailable');
    }
    if (!isCredential(token)) throw new SwitchDrillError('step_up_unavailable');
    return token;
  };
  return {
    /** Removes the token from the pool: whatever happens to the request, it is spent. */
    take: async (): Promise<string> => pool.shift() ?? (await obtain()),
    giveBack: (token: string): void => {
      pool.unshift(token);
    },
    /** Makes sure one token waits in the pool; a no-op without a source. */
    reserve: async (): Promise<void> => {
      if (pool.length === 0 && source !== undefined) pool.push(await obtain());
    },
  };
}

/** Uses the existing kill-switch GET/PUT contract, including pagination and CAS. */
export function createSwitchApi(options: SwitchApiOptions): SwitchApi {
  assertSwitchTarget(options.target);
  if (!isCredential(options.bearer) || !isCredential(options.stepUpToken)) {
    throw new SwitchDrillError('invalid_option');
  }
  if (options.stepUpSource !== undefined && typeof options.stepUpSource !== 'function') {
    throw new SwitchDrillError('invalid_option');
  }
  const base = options.target.baseUrl;
  const authorization = `Bearer ${options.bearer}`;
  const send = (request: HttpRequest): Promise<unknown> => sendEnvelope(options.transport, request);
  const tokens = stepUpTokens(options.stepUpToken, options.stepUpSource);

  return {
    // adminListKillSwitches: GET /admin/v1/kill-switches, page by page (page_size ≤ 200).
    async list() {
      const items: SwitchRow[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = new URL('/admin/v1/kill-switches', base);
        url.searchParams.set('page', String(page));
        url.searchParams.set('page_size', String(PAGE_SIZE));
        const data = (await send({
          method: 'GET',
          url: url.href,
          headers: { Authorization: authorization, Accept: 'application/json' },
          redirect: 'error',
        })) as { items?: unknown; total?: unknown } | undefined;
        const pageItems = data?.items;
        const total = data?.total;
        if (!Array.isArray(pageItems) || typeof total !== 'number' || !Number.isInteger(total)) {
          throw new SwitchDrillError('api_error', 'malformed list');
        }
        for (const item of pageItems) {
          if (!isRow(item)) throw new SwitchDrillError('api_error', 'malformed row');
          items.push(item);
        }
        if (items.length >= total || pageItems.length === 0) return items;
      }
      throw new SwitchDrillError('api_error', 'too many pages');
    },

    // adminUpdateKillSwitch: PUT /admin/v1/kill-switches/{key}, CAS on expected_version, totp
    // step-up header, no Idempotency-Key (04 §6.6). Refuses out-of-scope keys before sending.
    // Each PUT (degrade, restore, restore retry) carries a token of its own; before a degrading
    // PUT the token for the restoring one is already in hand, otherwise nothing is sent.
    async update(key, value, expectedVersion) {
      planSwitchDrill([key]);
      if (typeof value !== 'boolean' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new SwitchDrillError('invalid_option');
      }
      const stepUp = await tokens.take();
      if (value === false) {
        try {
          await tokens.reserve();
        } catch (error) {
          // Nothing sent: the unused token goes back for the next PUT.
          tokens.giveBack(stepUp);
          throw error;
        }
      }
      const data = await send({
        method: 'PUT',
        url: `${base}/admin/v1/kill-switches/${encodeURIComponent(key)}`,
        headers: {
          Authorization: authorization,
          'X-Step-Up-Token': stepUp,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: { value, expected_version: expectedVersion },
        redirect: 'error',
      });
      if (!isRow(data) || data.key !== key)
        throw new SwitchDrillError('api_error', 'malformed row');
      return data;
    },
  };
}

export interface StepUpSourceOptions {
  readonly target: SwitchTarget;
  readonly bearer: string;
  /**
   * Asks the operator for the authenticator's current 6-digit code, each time anew. The code is
   * only put in the request body; it is never logged, echoed or stored.
   */
  readonly readTotpCode: () => Promise<string>;
  readonly transport: HttpTransport;
}

const TOTP_CODE = /^[0-9]{6}$/u;
/** Wrong or reused codes (format, or 20002 from the server) are asked again this many times. */
const TOTP_ATTEMPTS = 3;
const WRONG_CODE = 20002;

/**
 * adminStepUp: POST /admin/v1/auth/step-up with `{ tier: 'totp', code }`, returning
 * `data.step_up_token` (BR-ID-34). Every call asks for a code of its own.
 */
export function createStepUpSource(options: StepUpSourceOptions): () => Promise<string> {
  assertSwitchTarget(options.target);
  if (!isCredential(options.bearer)) throw new SwitchDrillError('invalid_option');
  const authorization = `Bearer ${options.bearer}`;
  return async () => {
    for (let attempt = 1; ; attempt += 1) {
      const code = await options.readTotpCode();
      if (!TOTP_CODE.test(code)) {
        if (attempt < TOTP_ATTEMPTS) continue;
        throw new SwitchDrillError('step_up_unavailable');
      }
      let response: { status: number; body: unknown };
      try {
        response = await options.transport({
          method: 'POST',
          url: `${options.target.baseUrl}/admin/v1/auth/step-up`,
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: { tier: 'totp', code },
          redirect: 'error',
        });
      } catch {
        throw new SwitchDrillError('step_up_unavailable', 'transport');
      }
      const envelope = response.body as { code?: unknown } | null | undefined;
      if (
        typeof envelope === 'object' &&
        envelope !== null &&
        envelope.code === WRONG_CODE &&
        attempt < TOTP_ATTEMPTS
      ) {
        continue;
      }
      let data: unknown;
      try {
        data = envelopeData(response);
      } catch {
        throw new SwitchDrillError('step_up_unavailable');
      }
      const token = (data as { step_up_token?: unknown; tier?: unknown } | undefined) ?? {};
      if (token.tier !== 'totp' || !isCredential(token.step_up_token)) {
        throw new SwitchDrillError('step_up_unavailable');
      }
      return token.step_up_token;
    }
  };
}
