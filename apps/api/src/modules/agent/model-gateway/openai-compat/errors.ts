import type { VendorId, VendorUsage } from '../vendors/index.ts';
import type { ModelErrorKind, ModelFailure, VendorQuirks } from './types.ts';

export class ModelProtocolError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  readonly vendorCode: string | null;
  /** 已收到的有效累计用量；null 表示未知，不能按零用量计费。 */
  readonly usage: VendorUsage | null;

  /** message 和 detail 只能由本层构造，不得传入上游正文或原始异常。 */
  constructor(
    kind: ModelErrorKind,
    message: string,
    detail?: { status?: number | null; vendorCode?: string | null; usage?: VendorUsage | null },
  ) {
    super(message);
    this.name = 'ModelProtocolError';
    this.kind = kind;
    this.status = detail?.status ?? null;
    this.vendorCode = detail?.vendorCode ?? null;
    this.usage = detail?.usage
      ? Object.freeze({
          input_tokens: detail.usage.input_tokens,
          output_tokens: detail.usage.output_tokens,
        })
      : null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function malformed(): ModelProtocolError {
  return new ModelProtocolError('malformed', 'Invalid model protocol payload');
}

export function errorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = body.error.code;
  if (typeof code === 'string') return code;
  return typeof code === 'number' && Number.isSafeInteger(code) ? String(code) : null;
}

export function classifyFailure(
  vendor: VendorId,
  failure: ModelFailure,
  quirks: VendorQuirks,
): ModelErrorKind {
  if ('cause' in failure) return failure.cause;
  const code = errorCode(failure.body);
  if (code !== null && quirks.contentRefusalCodes.includes(code)) return 'content_refused';
  if (failure.status === 401 || failure.status === 403) return 'auth';
  if (failure.status === 429) {
    if (vendor === 'glm' && (code === '1113' || code === '1308')) return 'quota_exhausted';
    return 'rate_limited';
  }
  if (failure.status >= 500 && failure.status <= 599) return 'server';
  return 'bad_request';
}

// B3-09o · BR-AI-16 细则「请求根本没发出去，不计」：传输层在调用 fetch 之前抛出的错登记在这里，
// 路由记账见到登记过的错就不计。不给错误对象加字段（冻结用例断言了 ModelProtocolError 的形状）。
const notSent = new WeakSet<object>();

/** 登记一个在请求交给 HTTP 客户端之前抛出的错；非对象的抛出值无法登记，按已发出处理。 */
export function markNotSent(error: unknown): void {
  if (typeof error === 'object' && error !== null) notSent.add(error);
}

/** 这个错是否在请求交给 HTTP 客户端之前抛出（经 markNotSent 登记）。 */
export function wasNotSent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && notSent.has(error);
}
