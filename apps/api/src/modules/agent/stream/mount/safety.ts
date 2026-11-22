// B3-03m / B3-03n / B3-03p · BR-AI-18: the pieces shared by the stream entry's input check
// (./review.ts) and its per-app output review (./output-review.ts): when the Aliyun review is live,
// the Aliyun adapter dependencies, and the read of agent.safety.timeout_ms of one app whose wait
// counts toward the review deadline it precedes (B3-03p: one deadline, never read time + budget).
import { randomUUID } from 'node:crypto';
import type { AppEnv, Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import type {
  AliyunCredentials,
  AliyunReviewDeps,
  AliyunReviewFetch,
  ReviewBlockLevel,
} from '../../guard/review/index.ts';
import { createAliyunAcs3Signer } from '../../guard/review/sign.ts';
import type { AgentRunTexts } from '../../orchestrator/index.ts';

/** Composition-root configuration, never process.env in agent code. Omitted configuration,
 * incomplete credentials or a local/test environment must fail closed without network I/O.
 * Production defaults for fetch/nonce are supplied by the implementation; tests inject both.
 */
export interface StreamReviewOptions {
  readonly appEnv: AppEnv;
  readonly credentials?: AliyunCredentials | undefined;
  readonly endpoint?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: AliyunReviewFetch;
  readonly nonce?: () => string;
}

/** B3-03n: content's configuration read port (createContentReader's configValue). */
export interface StreamReviewConfigReader {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}

/**
 * B3-03n · BR-AI-18: createStreamReview's dependencies. With `config`, every input check reads
 * agent.safety.timeout_ms for that request's app (input.caller.appId) through it and uses that
 * value as the whole input review budget; a missing key is the BR-AI-18 default 1000 ms, a value
 * that is not a finite positive number takes the same default (the configuration layer's
 * existing rule; never an unlimited wait). options.timeoutMs, when the composition root sets
 * one, stands in for that default. A read that fails or hangs is fail-close (review unavailable,
 * refunded). createProductionStreamAssembly passes its content reader.
 * B3-03p: the wait for that read counts toward the same budget (one deadline from the start of the
 * check), and the per-app output review (./output-review.ts) reads it the same way per review.
 */
export interface StreamReviewDeps {
  readonly options?: StreamReviewOptions;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: RootLogger;
  readonly texts: Pick<AgentRunTexts, 'text'>;
  readonly config?: StreamReviewConfigReader;
}

/** BR-AI-18 default of agent.safety.timeout_ms. */
export const DEFAULT_TIMEOUT_MS = 1000;

export const TIMEOUT_KEY = 'agent.safety.timeout_ms';

export interface LiveSettings {
  readonly credentials: AliyunCredentials;
  readonly endpoint: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function httpsEndpoint(value: unknown): string | undefined {
  if (!nonBlank(value)) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The environment is checked first: local / test never touch the credentials. */
export function liveSettings(options: StreamReviewOptions | undefined): LiveSettings | undefined {
  if (options === undefined) return undefined;
  if (options.appEnv !== 'staging' && options.appEnv !== 'prod') return undefined;
  const endpoint = httpsEndpoint(options.endpoint);
  if (endpoint === undefined) return undefined;
  const credentials = options.credentials;
  if (credentials === undefined) return undefined;
  if (!nonBlank(credentials.accessKeyId) || !nonBlank(credentials.accessKeySecret)) {
    return undefined;
  }
  const frozen: AliyunCredentials = Object.freeze(
    credentials.securityToken === undefined
      ? { accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret }
      : {
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.accessKeySecret,
          securityToken: credentials.securityToken,
        },
  );
  return { credentials: frozen, endpoint };
}

/** The configuration layer's rule for a budget: a finite positive number, else `fallback`. */
export function validBudget(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function budgetOf(options: StreamReviewOptions | undefined): number {
  return validBudget(options?.timeoutMs, DEFAULT_TIMEOUT_MS);
}

/** Production transport: the platform fetch, called lazily (never captured at build). */
const platformFetch: AliyunReviewFetch = (url, init) => globalThis.fetch(url, init);

/** The Aliyun adapter's dependencies for one fixed budget (a new value each call). */
export function aliyunDepsFactory(
  live: LiveSettings,
  options: StreamReviewOptions | undefined,
  deps: { readonly clock: Clock; readonly scheduler: Scheduler; readonly logger: RootLogger },
): (budget: number) => AliyunReviewDeps {
  const sign = createAliyunAcs3Signer({ clock: deps.clock, nonce: options?.nonce ?? randomUUID });
  return (budget) => ({
    fetch: options?.fetch ?? platformFetch,
    scheduler: deps.scheduler,
    timeoutMs: () => budget,
    credentials: () => live.credentials,
    sign,
    endpoint: live.endpoint,
    logger: deps.logger,
  });
}

export const UNREADABLE: unique symbol = Symbol('unreadable');

/**
 * agent.safety.timeout_ms of one app, read now; a missing key or an invalid value is `fallback`
 * (options.timeoutMs when set, else the BR-AI-18 default). A read that fails, does not settle
 * within the default budget or outlives `signal` is UNREADABLE (fail-close: review unavailable).
 */
export async function readBudget(
  config: StreamReviewConfigReader,
  scheduler: Scheduler,
  appId: string,
  signal: AbortSignal,
  fallback: number,
): Promise<number | typeof UNREADABLE> {
  if (signal.aborted) return UNREADABLE;
  const timer = new AbortController();
  const stop = (): void => {
    timer.abort();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const read = Promise.resolve()
      .then(() => config.configValue(appId, TIMEOUT_KEY))
      .then(
        (entry): number => validBudget(entry?.value, fallback),
        (): typeof UNREADABLE => UNREADABLE,
      );
    const deadline = scheduler.sleep(DEFAULT_TIMEOUT_MS, timer.signal).then(
      (): typeof UNREADABLE => UNREADABLE,
      (): typeof UNREADABLE => UNREADABLE,
    );
    const budget = await Promise.race([read, deadline]);
    return signal.aborted ? UNREADABLE : budget;
  } finally {
    timer.abort();
    signal.removeEventListener('abort', stop);
  }
}

/**
 * B3-03p · BR-AI-18: what is left of one review deadline that started at `startedAt`
 * (scheduler.now()) once agent.safety.timeout_ms of `appId` was read: that value minus the wait
 * for the read. UNREADABLE when the read failed, hung or outlived `signal`; 0 when nothing is left
 * (a read slower than its own value). Either way the review is unavailable now (fail-close).
 */
export async function remainingBudget(
  config: StreamReviewConfigReader,
  scheduler: Scheduler,
  appId: string,
  signal: AbortSignal,
  fallback: number,
): Promise<number | typeof UNREADABLE> {
  const startedAt = scheduler.now();
  const budget = await readBudget(config, scheduler, appId, signal, fallback);
  if (budget === UNREADABLE) return UNREADABLE;
  const left = budget - Math.max(0, scheduler.now() - startedAt);
  return left > 0 ? left : 0;
}

/** B3-06c · BR-AI-18 细则：输入 / 输出审核各自的起拦等级配置键。 */
export const BLOCK_LEVEL_KEYS = {
  input: 'agent.safety.block_level.input',
  output: 'agent.safety.block_level.output',
} as const;

/** BR-AI-18 默认起拦等级（与 B3-06b 现实现相同：low / medium / high 都算命中）。 */
export const DEFAULT_BLOCK_LEVEL: ReviewBlockLevel = 'low';

/** D10-2484：读到了但缺失或不是 low / medium / high（大小写、空白、类型都不放宽）按 low。 */
export function validBlockLevel(value: unknown): ReviewBlockLevel {
  return value === 'low' || value === 'medium' || value === 'high' ? value : DEFAULT_BLOCK_LEVEL;
}

/** One review's settings: what is left of its deadline and its block level. */
export type ReviewSettings =
  | { readonly kind: 'ready'; readonly left: number; readonly level: ReviewBlockLevel }
  /** timeout_ms or the block level could not be read in time (fail-close, logged). */
  | { readonly kind: 'unreadable'; readonly key: string }
  /** Nothing of the deadline is left, or `signal` aborted (fail-close). */
  | { readonly kind: 'expired' };

/**
 * B3-06c · BR-AI-18: agent.safety.timeout_ms and the block level of `side` for one app, read now
 * for this one review (never cached; the level travels in the result, never in shared state).
 * Both reads start together at the start of the review; the timeout_ms read is bounded as in
 * remainingBudget, and the wait for the level counts toward the same deadline (D10-2489): a level
 * read that fails, or does not settle before the deadline, is unreadable (review unavailable, like
 * a timeout); a level read but missing or invalid is low (D10-2484).
 */
export async function reviewSettings(
  config: StreamReviewConfigReader,
  scheduler: Scheduler,
  appId: string,
  side: 'input' | 'output',
  signal: AbortSignal,
  fallback: number,
): Promise<ReviewSettings> {
  if (signal.aborted) return { kind: 'expired' };
  const levelKey = BLOCK_LEVEL_KEYS[side];
  // Started first (and synchronously) so the timeout_ms read stays the last read of the review.
  let levelRead: Promise<ReviewBlockLevel | typeof UNREADABLE>;
  try {
    levelRead = Promise.resolve(config.configValue(appId, levelKey)).then(
      (entry) => validBlockLevel(entry?.value),
      (): typeof UNREADABLE => UNREADABLE,
    );
  } catch {
    levelRead = Promise.resolve(UNREADABLE);
  }
  const left = await remainingBudget(config, scheduler, appId, signal, fallback);
  if (left === UNREADABLE) {
    return signal.aborted ? { kind: 'expired' } : { kind: 'unreadable', key: TIMEOUT_KEY };
  }
  if (left <= 0) return { kind: 'expired' };
  // The review's one deadline (from its start), fixed once timeout_ms is known.
  const deadlineAt = scheduler.now() + left;

  const timer = new AbortController();
  const stop = (): void => {
    timer.abort();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const deadline = scheduler.sleep(left, timer.signal).then(
      (): typeof UNREADABLE => UNREADABLE,
      (): typeof UNREADABLE => UNREADABLE,
    );
    const level = await Promise.race([levelRead, deadline]);
    if (signal.aborted) return { kind: 'expired' };
    if (level === UNREADABLE) return { kind: 'unreadable', key: levelKey };
    const rest = deadlineAt - scheduler.now();
    return rest > 0 ? { kind: 'ready', left: rest, level } : { kind: 'expired' };
  } finally {
    timer.abort();
    signal.removeEventListener('abort', stop);
  }
}

/** The fail-close log of a configuration read that failed or hung (flat fields, no text). */
export function logUnreadable(
  deps: { readonly logger: RootLogger },
  appId: string,
  key: string,
): void {
  deps.logger.warn(
    { app_id: appId },
    key === TIMEOUT_KEY ? 'agent_safety_timeout_unreadable' : 'agent_safety_block_level_unreadable',
  );
}
