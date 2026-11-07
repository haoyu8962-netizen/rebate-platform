// 联盟原始报文归档（B1-04p；规划/02 §6.1 末条、§7.1，规划/04 §3.2 union_raw_payloads）：包装一个
// UnionTransport，每次经它发出的请求（成功、非 2xx、抛错都算）在调用方事务之外用注入的根 Kysely
// 句柄单独插入一行（自动提交），插入结束后才交出 inner 的结果或原样抛出 inner 的错误。
// - 请求摘要只有 method、url（origin + pathname）与去掉敏感键的参数；请求头与请求体原文一律不存。
// - payload 是响应 body 原文的 gzip（库内归档用于对账与重放，不做录制脱敏）；content_hash 是它的 sha256。
// - 开始、结束各取一次注入的 Clock；归档失败只记一条 error 日志，调用结果不变。
// - B1-08e：插入成功时把行 id（returning id）以不可枚举的 raw_payload_id 挂在响应对象上。
// - B1-04zzc：请求带 archiveBody 时存的是它改写后的正文（调用方拿到的响应不变）；改写抛错时照样插入，
//   payload 存空串的 gzip、error_code 记 archive_body_rewrite_failed（非 2xx 仍记 http_<status>），打 error 日志。
// - B1-04zzu：archiveBody 可以返回 Promise；它以 ArchiveBodyLookupError 失败（改写要用的查询失败）时照样插入，
//   payload 存收到的原文、error_code 记 archive_body_lookup_failed（非 2xx 仍记 http_<status>），日志只带错误名。
// 演示适配器不经传输，因此从不归档。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Clock, RootLogger } from '../../platform/index.ts';
import { UnionError } from '../domain/types.ts';
import type {
  ArchiveContext,
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from './replay.ts';

export type { ArchiveContext } from './replay.ts';

export interface ArchiveDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'warn' | 'error'>;
}

/** 归一化（小写、去掉 `_` 与 `-`）后的敏感参数名；另外以 secret / token 结尾的也算。 */
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  'appkey',
  'clientid',
  'secret',
  'clientsecret',
  'appsecret',
  'sign',
  // B1-04m：大淘客新验签 signRan。
  'signran',
  'session',
  'sessionkey',
  'accesstoken',
  'refreshtoken',
]);

export function isSensitiveParameter(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[_-]/g, '');
  return (
    SENSITIVE_NAMES.has(normalized) || normalized.endsWith('secret') || normalized.endsWith('token')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 递归删掉敏感键（嵌套对象与数组里的对象也删）。 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, inner] of Object.entries(value)) {
    if (!isSensitiveParameter(name)) out[name] = redact(inner);
  }
  return out;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function formObject(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of new URLSearchParams(text)) out[name] = value;
  return out;
}

/** 请求体参数；无法解析成对象时为 undefined。 */
function bodyParameters(request: UnionTransportRequest, body: string): object | undefined {
  const type = headerValue(request.headers, 'content-type')?.toLowerCase() ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return formObject(body);
  try {
    const parsed: unknown = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `{ method, url, params }`；体不可解析时 `{ method, url, body_bytes }`。不含请求头与体原文。 */
export function requestSummary(request: UnionTransportRequest): Record<string, unknown> {
  let url: string;
  let query: Record<string, unknown> = {};
  try {
    const parsed = new URL(request.url);
    url = `${parsed.origin}${parsed.pathname}`;
    query = formObject(parsed.search);
  } catch {
    url = String(request.url).split(/[?#]/, 1)[0] ?? '';
  }
  const summary: Record<string, unknown> = { method: request.method, url };
  const body = request.body;
  if (body === undefined || body === '') {
    summary['params'] = redact(query);
    return summary;
  }
  const parameters = bodyParameters(request, body);
  if (parameters === undefined) {
    summary['body_bytes'] = Buffer.byteLength(body, 'utf8');
    return summary;
  }
  summary['params'] = redact({ ...query, ...parameters });
  return summary;
}

/**
 * error_code：inner 抛 UnionError → 其 code（别的错误为 NULL）；非 2xx → `http_<status>`；
 * 2xx 且 body 是带 `error_response` 对象的 JSON 对象 → `String(error_code ?? code)`；否则 NULL。
 */
export function responseErrorCode(response: UnionTransportResponse): string | null {
  if (response.status < 200 || response.status > 299) return `http_${response.status}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const envelope = parsed['error_response'];
  if (!isPlainObject(envelope)) return null;
  return String(envelope['error_code'] ?? envelope['code']);
}

/** B1-04zzc: error_code of a row whose body rewrite (request.archiveBody) failed. */
export const ARCHIVE_BODY_FAILED = 'archive_body_rewrite_failed';

/**
 * B1-04zzu: error_code of a row whose body rewrite could not tell which rows to keep because the
 * lookup it needs failed (e.g. the 淘宝 refund archive's own-order query threw). Unlike
 * ARCHIVE_BODY_FAILED the row stores the body as received, not an empty one; the call's result is
 * unchanged and the log carries no part of the body.
 */
export type ArchiveBodyLookupFailed = 'archive_body_lookup_failed';

/** B1-04zzu: the ArchiveBodyLookupFailed error_code. */
export const ARCHIVE_BODY_LOOKUP_FAILED: ArchiveBodyLookupFailed = 'archive_body_lookup_failed';

/**
 * B1-04zzu: thrown (or rejected) by a request's archiveBody when the lookup it needs to tell which
 * rows to keep failed. The archiving transport then stores the body as received with error_code
 * ARCHIVE_BODY_LOOKUP_FAILED and logs only the name of `cause` (never its message). Its own message
 * is fixed text.
 */
export class ArchiveBodyLookupError extends Error {
  constructor(cause: unknown) {
    super('archive body lookup failed', { cause });
    this.name = 'ArchiveBodyLookupError';
  }
}

type Outcome =
  | { readonly ok: true; readonly response: UnionTransportResponse }
  | { readonly ok: false; readonly error: unknown };

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.trim() !== '') return error.name;
  return typeof error;
}

/**
 * B1-08e：把归档行 id 以不可枚举属性挂在 inner 返回的同一个响应对象上（调用方拿到的引用与可枚举
 * 内容都不变）。对象不可扩展或已有该属性时不挂（不覆盖 inner 自带的值）。
 */
function attachRawPayloadId(response: UnionTransportResponse, rawPayloadId: string): void {
  if (typeof response !== 'object' || response === null || !Object.isExtensible(response)) return;
  if (Object.hasOwn(response, 'raw_payload_id')) return;
  Object.defineProperty(response, 'raw_payload_id', {
    value: rawPayloadId,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

export function createArchivingTransport(
  inner: UnionTransport,
  deps: ArchiveDependencies,
): UnionTransport {
  const { db, clock, logger } = deps;

  /**
   * B1-04zzc: the body text to store. With request.archiveBody, the rewritten body; when the
   * rewrite throws (or gives no string), an empty body and an error log (never the body itself), so
   * a body that may hold rows the rewrite should have dropped is never stored. B1-04zzu: the
   * rewrite may give a promise; an ArchiveBodyLookupError (its lookup failed) stores the body as
   * received and logs only the cause's name.
   */
  const storedBody = async (
    request: UnionTransportRequest,
    context: ArchiveContext,
    response: UnionTransportResponse,
  ): Promise<{ readonly body: string; readonly failed: string | null }> => {
    const rewrite = request.archiveBody;
    if (rewrite === undefined) return { body: response.body, failed: null };
    let failure: unknown;
    try {
      const body = await rewrite(response.body);
      if (typeof body === 'string') return { body, failed: null };
      failure = new TypeError('archive body rewrite gave no string');
    } catch (error) {
      failure = error;
    }
    if (failure instanceof ArchiveBodyLookupError) {
      logger.error(
        {
          event: 'union.raw_payload.archive_body_lookup_failed',
          platform: request.platform,
          kind: context.kind,
          error_name: errorName(failure.cause),
        },
        'union raw payload body lookup failed; stored the body as received',
      );
      return { body: response.body, failed: ARCHIVE_BODY_LOOKUP_FAILED };
    }
    logger.error(
      {
        event: 'union.raw_payload.archive_body_failed',
        platform: request.platform,
        kind: context.kind,
        error_name: errorName(failure),
      },
      'union raw payload body rewrite failed; stored an empty payload',
    );
    return { body: '', failed: ARCHIVE_BODY_FAILED };
  };

  const archive = async (
    request: UnionTransportRequest,
    context: ArchiveContext,
    started: Date,
    ended: Date,
    outcome: Outcome,
  ): Promise<string | undefined> => {
    try {
      const stored = outcome.ok ? await storedBody(request, context, outcome.response) : null;
      const payload = gzipSync(stored === null ? '' : stored.body);
      const errorCode = outcome.ok
        ? (responseErrorCode(outcome.response) ?? stored?.failed ?? null)
        : outcome.error instanceof UnionError
          ? outcome.error.code
          : null;
      const row = await db
        .withSchema('app')
        .insertInto('union_raw_payloads')
        .values({
          app_id: context.appId,
          platform: request.platform,
          kind: context.kind,
          payload,
          fetched_at: ended,
          content_hash: createHash('sha256').update(payload).digest('hex'),
          request_summary: JSON.stringify(requestSummary(request)),
          latency_ms: Math.max(0, Math.round(ended.getTime() - started.getTime())),
          error_code: errorCode,
        })
        .returning('id')
        .executeTakeFirst();
      return row === undefined ? undefined : String(row.id);
    } catch (error) {
      logger.error(
        {
          event: 'union.raw_payload.archive_failed',
          platform: request.platform,
          kind: context.kind,
          error_name: errorName(error),
        },
        'union raw payload archive failed',
      );
      return undefined;
    }
  };

  return async (request) => {
    const context = request.archive;
    if (context === undefined) {
      logger.warn(
        { event: 'union.raw_payload.no_context', platform: request.platform },
        'union request without archive context',
      );
      return await inner(request);
    }
    const started = clock.now();
    let outcome: Outcome;
    try {
      outcome = { ok: true, response: await inner(request) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const rawPayloadId = await archive(request, context, started, clock.now(), outcome);
    if (!outcome.ok) throw outcome.error;
    if (rawPayloadId !== undefined) attachRawPayloadId(outcome.response, rawPayloadId);
    return outcome.response;
  };
}
