// 大淘客网关响应外层解包与错误分类（B1-04m，D10-486 ①）。
// HTTP 5xx → upstream_unavailable；body 非 JSON / 非对象 / 缺 code → upstream_unavailable。
// 外层 code 非 0（数字与同值字符串同等）按 gz-13 分类：限流码 → rate_limited；应用凭据 / 签名 / 接口
// 权限码 → upstream_misconfigured、站长联盟授权码 → site_auth_invalid（B1-04zzzx，D10-967），两组都
// 调 warn 一次（只带路径与 code）；服务端暂时故障码 → upstream_unavailable；其余 → upstream_rejected。
// 外层 code 0：data 必须是对象，否则 upstream_unavailable；data 里有淘宝 TOP 形式的 error_response 时
// 按 B1-04j 同义分类（code 7 或 sub_code 以 isp.call-limited 开头 → rate_limited；其余 code 11 →
// upstream_misconfigured，code 11 都 warn；其余 → upstream_rejected）；否则返回 data。
// 错误信息只带路径与 code（及 sub_code），不带 msg / sub_msg / request_id / 参数；不做字段映射。
// B1-04d：调用方可按接口给出外层非 0 code 的细分表（如转链 10031 / 10212 / 10213 → item_unavailable），
// 表内 code 用表里的分类，签名 / 凭据码照旧告警；表外 code 仍按上面分组。
// TODO(规划/11 §4.5): 外层键名、成功码与错误码待大淘客实测录制核对 — blocked on 大淘客录制
import { UnionError, type UnionErrorCode } from '../../domain/types.ts';
import type { UnionTransportResponse } from '../replay.ts';

/**
 * Sent once for a signature / credential / authorisation outer code, or for a TOP code 11 inside
 * data. Carries only the request path and the code (string form) plus the TOP sub_code; never msg,
 * sub_msg, request_id, parameters or credentials.
 */
export interface DataokeWarning {
  readonly path: string;
  readonly code: string;
  readonly sub_code?: string;
}

// gz-13 外层错误码分组（数字与同值字符串同等，统一按十进制文本比较）。
const OUTER_RATE_LIMITED: ReadonlySet<string> = new Set([
  '10064', // 错误累计限流
  '10045', // 请求错误次数过多
  '10013', // 调用次数超限
  '10014', // 频率过快
  '10022', // 请求频繁
  '10201', // 今日次数用完
  '10202', // 当前分钟达上限
  '10038', // 访问次数已达上限
]);
// 我方应用凭据 / 签名 / 接口权限（B1-04zzzx → upstream_misconfigured）。
const OUTER_MISCONFIGURED: ReadonlySet<string> = new Set([
  '10009', // appKey 有误
  '10010', // 未找到对应用户
  '10016', // appKey 信息错误
  '10015', // sign 为空
  '10018', // appsecret 异常
  '10021', // 签名验证失败
  '10020', // 接口未添加到应用
  '401', // 请先认证
]);
// 站长在大淘客侧的淘宝联盟授权（BR-ID-24；B1-04zzzx → site_auth_invalid）。
const OUTER_SITE_AUTH: ReadonlySet<string> = new Set([
  '10072', // 未淘宝授权或授权过期
  '10210', // 联盟授权账号不存在
  '10211', // SessionKey 非法或过期
]);
const OUTER_UNAVAILABLE: ReadonlySet<string> = new Set([
  '-1',
  '500',
  '503',
  '10008',
  '10012',
  '10019',
  '10023',
  '10025',
  '10053',
  '10054',
]);
const OUTER_SUCCESS = '0';

/** Per-interface refinement of non-zero outer codes (string form); absent keys keep the grouping. */
export type DataokeCodeMap = Readonly<Record<string, UnionErrorCode>>;

/** Per-interface decoding options of unwrapDataokeResponse. */
export interface DataokeUnwrapOptions {
  readonly outerCodes?: DataokeCodeMap;
}

// data 内淘宝 TOP error_response（与 B1-04j taobao/response.ts 同义）。
const TOP_PERMISSION_CODE = '11';
const TOP_RATE_LIMIT_CODE = '7';
const TOP_RATE_LIMIT_SUB_CODE_PREFIX = 'isp.call-limited';

/** Codes echoed into messages and warnings: short and plain, never free upstream text. */
const CODE_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;

/** The code as text when it is a short plain scalar; anything else is treated as absent. */
function codeText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (CODE_TEXT.test(trimmed)) return trimmed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: UnionErrorCode, path: string, detail: string): UnionError {
  return new UnionError(code, `dataoke ${path}: ${detail}`, 'taobao');
}

function classifyOuter(code: string): UnionErrorCode {
  if (OUTER_RATE_LIMITED.has(code)) return 'rate_limited';
  if (OUTER_UNAVAILABLE.has(code)) return 'upstream_unavailable';
  if (OUTER_MISCONFIGURED.has(code)) return 'upstream_misconfigured';
  if (OUTER_SITE_AUTH.has(code)) return 'site_auth_invalid';
  // 表外码（参数、业务、10071、10077 等）是上游拒绝。
  return 'upstream_rejected';
}

function topFailure(
  path: string,
  error: unknown,
  warn: ((event: DataokeWarning) => void) | undefined,
): UnionError {
  const fields = isRecord(error) ? error : {};
  const code = codeText(fields.code);
  const subCode = codeText(fields.sub_code);
  if (code === TOP_PERMISSION_CODE) {
    warn?.(subCode === undefined ? { path, code } : { path, code, sub_code: subCode });
  }
  const limited =
    code === TOP_RATE_LIMIT_CODE || subCode?.startsWith(TOP_RATE_LIMIT_SUB_CODE_PREFIX) === true;
  const detail = `taobao code=${code ?? 'unknown'}${subCode === undefined ? '' : ` sub_code=${subCode}`}`;
  const classified: UnionErrorCode = limited
    ? 'rate_limited'
    : code === TOP_PERMISSION_CODE
      ? 'upstream_misconfigured'
      : 'upstream_rejected';
  return failure(classified, path, detail);
}

/** Internal gateway envelope decoder: returns the `data` object, maps no fields. */
export function unwrapDataokeResponse(
  path: string,
  response: UnionTransportResponse,
  warn?: (event: DataokeWarning) => void,
  options: DataokeUnwrapOptions = {},
): Readonly<Record<string, unknown>> {
  const { outerCodes } = options;
  if (response.status >= 500) {
    throw failure('upstream_unavailable', path, `HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw failure('upstream_unavailable', path, 'response is not JSON');
  }
  if (!isRecord(parsed)) throw failure('upstream_unavailable', path, 'unexpected response');
  const code = Object.hasOwn(parsed, 'code') ? codeText(parsed.code) : undefined;
  if (code === undefined) throw failure('upstream_unavailable', path, 'missing response code');
  if (code !== OUTER_SUCCESS) {
    if (OUTER_MISCONFIGURED.has(code) || OUTER_SITE_AUTH.has(code)) warn?.({ path, code });
    const refined =
      outerCodes !== undefined && Object.hasOwn(outerCodes, code) ? outerCodes[code] : undefined;
    throw failure(refined ?? classifyOuter(code), path, `code=${code}`);
  }
  const data = Object.hasOwn(parsed, 'data') ? parsed.data : undefined;
  if (!isRecord(data))
    throw failure('upstream_unavailable', path, 'response data is not an object');
  if (Object.hasOwn(data, 'error_response')) throw topFailure(path, data.error_response, warn);
  return data;
}
