import type { RootLogger, Scheduler } from '../../../platform/index.ts';
import type { ReviewVerdict, SentenceReviewPort } from '../index.ts';

// B3-06b · BR-AI-18 · 文档差异表，尚无真实调用能力验证（09 U-79）。
// https://help.aliyun.com/zh/document_detail/2671445.html
// 默认：Code=200、Data.RiskLevel；none 通过，high/medium/low 均有风险，按 BR-AI-18 拦截。
// 未知字段/值、非成功状态或异常均为 timeout；不得将 Advice 中的文本当作审核结果。
// TODO(规划/11 §6): 真实调用验证 — blocked on 负责人开通阿里云内容安全并提供 Key。
export interface AliyunReviewDifferences {
  readonly inputService: string;
  readonly outputService: string;
  readonly codePath: readonly string[];
  readonly successCode: number;
  readonly verdictPath: readonly string[];
  readonly passValues: readonly string[];
  readonly blockValues: readonly string[];
}

export interface AliyunCredentials {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

/** 签名器只返回请求头；不允许它改变出站地址、方法或正文。时间与 nonce 由接线注入。 */
export interface AliyunSignRequest {
  readonly endpoint: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** RPC form：Service 与 JSON 字符串 ServiceParameters（content 保持原文）。 */
  readonly body: string;
  readonly action: 'TextModerationPlus';
  readonly version: '2022-03-02';
}

export interface AliyunReviewFetchInit {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly redirect: 'error';
}

/** 仿 B3-02b FetchLike 的最小非流式形状；生产可注入 globalThis.fetch。 */
export interface AliyunReviewFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export interface AliyunReviewFetch {
  (url: string, init: AliyunReviewFetchInit): Promise<AliyunReviewFetchResponse>;
}

export interface AliyunReviewDeps {
  readonly fetch: AliyunReviewFetch;
  readonly scheduler: Scheduler;
  /** 每次 review 读取一次 agent.safety.timeout_ms；默认 1000ms 由配置层提供。 */
  readonly timeoutMs: () => number;
  readonly credentials: () => AliyunCredentials;
  readonly sign: (
    request: AliyunSignRequest,
    credentials: AliyunCredentials,
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, string>>>;
  /** 配置的完整 HTTPS 地址；不拼接其他地址，不跟随跳转。 */
  readonly endpoint: string;
  readonly differences?: AliyunReviewDifferences;
  /** 只允许平铺的诊断字段；不记录凭据、正文或原始异常。 */
  readonly logger?: Pick<RootLogger, 'debug' | 'info' | 'warn' | 'error'>;
}

export function defaultAliyunReviewDifferences(): AliyunReviewDifferences {
  return {
    inputService: 'llm_query_moderation',
    outputService: 'llm_response_moderation',
    codePath: ['Code'],
    successCode: 200,
    verdictPath: ['Data', 'RiskLevel'],
    passValues: ['none'],
    blockValues: ['high', 'medium', 'low'],
  };
}

export function createAliyunInputReview(deps: AliyunReviewDeps): SentenceReviewPort {
  return createAliyunReview(deps, 'input');
}

export function createAliyunOutputReview(deps: AliyunReviewDeps): SentenceReviewPort {
  return createAliyunReview(deps, 'output');
}

/** B3-06c · BR-AI-18 细则：审核起拦等级（agent.safety.block_level.input / .output）。 */
export type ReviewBlockLevel = 'low' | 'medium' | 'high';

/** 有风险的等级按 low < medium < high 排序；差异表里不在此表的命中取值按等级不认识处理。 */
const LEVEL_RANK: Readonly<Record<ReviewBlockLevel, number>> = { low: 1, medium: 2, high: 3 };

function rankOf(value: string): number | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? LEVEL_RANK[value] : undefined;
}

/**
 * B3-06c：按调用方给出的起拦等级判定的审核口。passValues 通过；blockValues 中风险等级 ≥ 起拦等级
 * 才算 block，低于起拦等级算 pass；等级缺失或不认识一律 timeout（审核不可用，不当作命中）。
 * 起拦等级只随这一次 review 调用传入，不存放在适配器里。默认的 review()（createAliyunInputReview /
 * createAliyunOutputReview）不受影响，仍按差异表把 low / medium / high 全部当作命中。
 */
export interface GradedReviewPort {
  review(text: string, blockLevel: ReviewBlockLevel): Promise<ReviewVerdict>;
}

export function createAliyunGradedReview(
  deps: AliyunReviewDeps,
  side: 'input' | 'output',
): GradedReviewPort {
  const differences = deps.differences ?? defaultAliyunReviewDifferences();
  const service = side === 'input' ? differences.inputService : differences.outputService;
  return {
    review: (text, blockLevel) => runReview(deps, differences, service, side, text, blockLevel),
  };
}

// ---------------------------------------------------------------------------------------------
// 共用实现：两种场景只差 Service 参数；映射、时限、fail-close 完全相同。不跟随跳转、不重试。

type Side = 'input' | 'output';

/** 不可判定的原因，只作平铺日志字段；不含正文、凭据、签名或原始异常。 */
type Unavailable =
  | 'config'
  | 'deadline'
  | 'error'
  | 'http_status'
  | 'body_not_json'
  | 'code_mismatch'
  | 'verdict_unknown';

type Outcome =
  | { readonly verdict: 'pass' | 'block' }
  | { readonly verdict: 'timeout'; readonly reason: Unavailable; readonly status?: number };

const ACTION = 'TextModerationPlus';
const VERSION = '2022-03-02';
const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';
const LOG_MESSAGE = 'agent.safety.review_unavailable';

function createAliyunReview(deps: AliyunReviewDeps, side: Side): SentenceReviewPort {
  const differences = deps.differences ?? defaultAliyunReviewDifferences();
  const service = side === 'input' ? differences.inputService : differences.outputService;

  return {
    review: (text: string) => runReview(deps, differences, service, side, text, undefined),
  };
}

/** blockLevel 为 undefined 时是默认映射（差异表原样）；否则按起拦等级判定。 */
async function runReview(
  deps: AliyunReviewDeps,
  differences: AliyunReviewDifferences,
  service: string,
  side: Side,
  text: string,
  blockLevel: ReviewBlockLevel | undefined,
): Promise<ReviewVerdict> {
  let outcome: Outcome;
  try {
    outcome = await reviewWithDeadline(deps, differences, service, text, blockLevel);
  } catch {
    outcome = { verdict: 'timeout', reason: 'error' };
  }
  if (outcome.verdict === 'timeout') logUnavailable(deps, side, outcome);
  return outcome.verdict;
}

/**
 * 一次审核的总预算从读取配置时开始：取凭据、签名、发请求、读正文都计入同一个时限，
 * 收到响应头不重新计时。到点即中止请求并返回 timeout，不等待 fetch 配合中止。
 */
async function reviewWithDeadline(
  deps: AliyunReviewDeps,
  differences: AliyunReviewDifferences,
  service: string,
  text: string,
  blockLevel: ReviewBlockLevel | undefined,
): Promise<Outcome> {
  let budget: unknown;
  try {
    budget = deps.timeoutMs();
  } catch {
    return { verdict: 'timeout', reason: 'config' };
  }
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    return { verdict: 'timeout', reason: 'config' };
  }

  const request = new AbortController();
  const timer = new AbortController();
  const expired = new Promise<Outcome>((resolve) => {
    deps.scheduler.sleep(budget, timer.signal).then(
      () => {
        resolve({ verdict: 'timeout', reason: 'deadline' });
      },
      () => {
        // 计时器被取消：审核已先结束，这个分支不再参与竞争。
      },
    );
  });
  const work = attempt(deps, differences, service, text, blockLevel, request.signal).catch(
    (): Outcome => ({
      verdict: 'timeout',
      reason: 'error',
    }),
  );

  const outcome = await Promise.race([work, expired]);
  // 到点：中止仍在进行的签名或请求；先结束：释放计时器。
  if (outcome.verdict === 'timeout' && outcome.reason === 'deadline') request.abort();
  timer.abort();
  return outcome;
}

async function attempt(
  deps: AliyunReviewDeps,
  differences: AliyunReviewDifferences,
  service: string,
  text: string,
  blockLevel: ReviewBlockLevel | undefined,
  signal: AbortSignal,
): Promise<Outcome> {
  // 每次审核重新取凭据并签名，不缓存，Key 轮换即时生效。
  const credentials = deps.credentials();
  const body = new URLSearchParams({
    Service: service,
    ServiceParameters: JSON.stringify({ content: text }),
  }).toString();
  const headers: Readonly<Record<string, string>> = { 'content-type': CONTENT_TYPE };
  const signed = await deps.sign(
    { endpoint: deps.endpoint, method: 'POST', headers, body, action: ACTION, version: VERSION },
    credentials,
    signal,
  );
  // 迟到的签名不得再发请求。
  if (signal.aborted) return { verdict: 'timeout', reason: 'deadline' };

  // 签名器只能追加请求头；地址、方法、正文与已列出的请求头不受它影响。
  const response = await deps.fetch(deps.endpoint, {
    method: 'POST',
    headers: { ...stringHeaders(signed), ...headers },
    body,
    signal,
    redirect: 'error',
  });
  const status = response.status;
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    return { verdict: 'timeout', reason: 'http_status', status };
  }
  const raw = await response.text();
  if (signal.aborted) return { verdict: 'timeout', reason: 'deadline' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { verdict: 'timeout', reason: 'body_not_json' };
  }
  return blockLevel === undefined
    ? mapVerdict(parsed, differences)
    : mapGradedVerdict(parsed, differences, blockLevel);
}

/** 只认差异表写明的字段与取值；其余（缺失、类型不符、大小写或空白不同）一律 timeout。 */
function mapVerdict(body: unknown, differences: AliyunReviewDifferences): Outcome {
  const code = readPath(body, differences.codePath);
  if (typeof code !== 'number' || code !== differences.successCode) {
    return { verdict: 'timeout', reason: 'code_mismatch' };
  }
  const value = readPath(body, differences.verdictPath);
  if (typeof value !== 'string') return { verdict: 'timeout', reason: 'verdict_unknown' };
  // 同一取值同时出现在两张表时按命中处理，不放行。
  if (differences.blockValues.includes(value)) return { verdict: 'block' };
  if (differences.passValues.includes(value)) return { verdict: 'pass' };
  return { verdict: 'timeout', reason: 'verdict_unknown' };
}

/** B3-06c：与 mapVerdict 同样只认差异表的字段与取值，再按起拦等级判定命中。 */
function mapGradedVerdict(
  body: unknown,
  differences: AliyunReviewDifferences,
  blockLevel: ReviewBlockLevel,
): Outcome {
  const code = readPath(body, differences.codePath);
  if (typeof code !== 'number' || code !== differences.successCode) {
    return { verdict: 'timeout', reason: 'code_mismatch' };
  }
  const value = readPath(body, differences.verdictPath);
  if (typeof value !== 'string') return { verdict: 'timeout', reason: 'verdict_unknown' };
  if (differences.blockValues.includes(value)) {
    const rank = rankOf(value);
    if (rank === undefined) return { verdict: 'timeout', reason: 'verdict_unknown' };
    return rank >= LEVEL_RANK[blockLevel] ? { verdict: 'block' } : { verdict: 'pass' };
  }
  if (differences.passValues.includes(value)) return { verdict: 'pass' };
  return { verdict: 'timeout', reason: 'verdict_unknown' };
}

function readPath(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0) return undefined;
  let current: unknown = value;
  for (const key of path) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringHeaders(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) throw new Error('aliyun review: signer returned no headers');
  const out: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header !== 'string') throw new Error('aliyun review: signer header not a string');
    out[key] = header;
  }
  return out;
}

function logUnavailable(
  deps: AliyunReviewDeps,
  side: Side,
  outcome: { readonly reason: Unavailable; readonly status?: number },
): void {
  try {
    deps.logger?.warn(
      outcome.status === undefined
        ? { review_side: side, reason: outcome.reason }
        : { review_side: side, reason: outcome.reason, http_status: outcome.status },
      LOG_MESSAGE,
    );
  } catch {
    // 日志失败不影响 fail-close 结果。
  }
}
