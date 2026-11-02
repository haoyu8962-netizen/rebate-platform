// 京东联盟网关响应解包与错误分类（B1-04za）。规则测试：test/spec/union/jd-core/response.test.ts、
// lossless.test.ts。外层键与结果键由调用方按接口登记，不由方法名推导；内层 code 决定成败。
// HTTP 5xx → upstream_unavailable；body 非 JSON / 非对象 → upstream_unavailable；
// 顶层有 error_response 先判错误：code 2、429 → rate_limited；code 28（接口已停用）→
// upstream_rejected 并告警一次；其他 → upstream_rejected。数字 code 与同值字符串同等处理。
// 外层键缺失 / 非对象 → upstream_unavailable；外层 code 不是 0 → upstream_rejected（先于看结果键）。
// 结果键的值必须是 JSON 字符串，否则 upstream_unavailable。内层 code：200 成功，返回内层对象；
// 403 → upstream_rejected 并告警一次（无权限）；429 → rate_limited；其他 → upstream_rejected；
// 缺失或不是短的普通标量 → upstream_unavailable。成败只看 code，绝不看 message。
// 可按接口给内层 code 细分表，只对内层生效，限流判断在先；也可再登记要告警一次的内层 code（B1-04zd）。
// 也可登记表示时间窗过大的内层 code（B1-04zt）：错误码不变，只在 UnionError 上带 windowTooLarge。
// 错误与告警只带方法名和 code，不带 message、requestId、请求内容与凭据；这里不做字段映射。
//
// 无损取数：内层用 JSON.parse 的 reviver 第三参数 context.source 取每个数字的原文，包成 JdRawNumber，
// 不手写解码器。语法严格性、字符串转义（含 \uXXXX、代理对、\/）、__proto__ 成员都由引擎按 JSON 标准
// 处理。没拿到原文时解析失败，绝不退回 JS number。金额换算本单不做。
import { UnionError, type UnionErrorCode } from '../../domain/types.ts';
import type { UnionTransportResponse } from '../replay.ts';

/** Sent once for gateway code 28 and inner code 403; carries only the method and the code text. */
export interface JdWarning {
  readonly method: string;
  readonly code: string;
}

/** Per-method refinement of the inner code (string form); rate limiting is judged first. */
export type JdInnerCodeMap = Readonly<Record<string, UnionErrorCode>>;

/** The keys registered for one method; never derived from the method name. */
export interface JdResponseKeys {
  /** The outer `*_responce` key. */
  readonly envelope: string;
  /** The outer key holding the inner JSON string (queryResult / getResult …). */
  readonly resultKey: string;
}

/** The parsed inner object: every JSON number in it, at any depth, is a JdRawNumber. */
export type JdInner = Readonly<Record<string, unknown>>;

/** A JSON number of the inner result as its exact source text; it never passes through a number. */
export class JdRawNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** 网关层：App Call Limited 与 429 是限流；28 是接口已停用。 */
const GATEWAY_RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['2', '429']);
const GATEWAY_RETIRED_CODE = '28';
const OUTER_SUCCESS_CODE = '0';
/** 内层与网关层的 code 含义不同，互不通用（内层 2 / 28 只是普通失败）。 */
const INNER_SUCCESS_CODE = '200';
const INNER_PERMISSION_CODE = '403';
const INNER_RATE_LIMIT_CODE = '429';

/** Codes echoed into messages and warnings: short and plain, never free upstream text. */
const CODE_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;

/** The code as text when it is a short plain scalar; anything else is treated as absent. */
function codeText(value: unknown): string | undefined {
  let text: unknown = value;
  if (value instanceof JdRawNumber) text = value.text;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  return typeof text === 'string' && CODE_TEXT.test(text) ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof JdRawNumber)
  );
}

function unavailable(method: string, reason: string): UnionError {
  return new UnionError('upstream_unavailable', `jd ${method}: ${reason}`, 'jd');
}

function rejected(method: string, detail: string): UnionError {
  return new UnionError('upstream_rejected', `jd ${method}: ${detail}`, 'jd');
}

function gatewayFailure(
  method: string,
  error: unknown,
  warn: ((event: JdWarning) => void) | undefined,
): UnionError {
  const code = codeText(isRecord(error) ? error.code : undefined);
  if (code === GATEWAY_RETIRED_CODE) warn?.({ method, code });
  const detail = `code=${code ?? 'unknown'}`;
  if (code !== undefined && GATEWAY_RATE_LIMIT_CODES.has(code)) {
    return new UnionError('rate_limited', `jd ${method}: ${detail}`, 'jd');
  }
  return rejected(method, detail);
}

function classifyInner(code: string, innerCodes: JdInnerCodeMap | undefined): UnionErrorCode {
  if (code === INNER_RATE_LIMIT_CODE) return 'rate_limited';
  if (innerCodes !== undefined && Object.hasOwn(innerCodes, code)) return innerCodes[code]!;
  return 'upstream_rejected';
}

function innerFailure(
  method: string,
  code: string,
  warn: ((event: JdWarning) => void) | undefined,
  innerCodes: JdInnerCodeMap | undefined,
  warnCodes: ReadonlySet<string> | undefined,
  windowTooLargeCodes: ReadonlySet<string> | undefined,
): UnionError {
  if (code === INNER_PERMISSION_CODE || warnCodes?.has(code) === true) warn?.({ method, code });
  return new UnionError(classifyInner(code, innerCodes), `jd ${method}: code=${code}`, 'jd', {
    windowTooLarge: windowTooLargeCodes?.has(code) === true,
  });
}

/** JSON.parse reviver: every number becomes its source text; a missing source fails the parse. */
function keepNumberText(
  _key: string,
  value: unknown,
  context?: { readonly source?: string },
): unknown {
  if (typeof value !== 'number') return value;
  if (context?.source === undefined) throw new Error('number source text unavailable');
  return new JdRawNumber(context.source);
}

function decodeInner(method: string, text: string): JdInner {
  let inner: unknown;
  try {
    inner = JSON.parse(text, keepNumberText);
  } catch {
    throw unavailable(method, 'result is not JSON');
  }
  if (!isRecord(inner)) throw unavailable(method, 'result is not an object');
  return inner;
}

/** Internal gateway decoder, not a product / order / link DTO mapper. */
export function unwrapJdResponse(
  method: string,
  keys: JdResponseKeys,
  response: UnionTransportResponse,
  warn?: (event: JdWarning) => void,
  innerCodes?: JdInnerCodeMap,
  warnCodes?: ReadonlySet<string>,
  windowTooLargeCodes?: ReadonlySet<string>,
): JdInner {
  if (response.status >= 500) throw unavailable(method, `HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw unavailable(method, 'response is not JSON');
  }
  if (!isRecord(parsed)) throw unavailable(method, 'unexpected response');
  if (Object.hasOwn(parsed, 'error_response')) {
    throw gatewayFailure(method, parsed.error_response, warn);
  }

  if (!Object.hasOwn(parsed, keys.envelope)) throw unavailable(method, 'missing envelope');
  const outer = parsed[keys.envelope];
  if (!isRecord(outer)) throw unavailable(method, 'envelope is not an object');
  const outerCode = codeText(outer.code);
  if (outerCode !== OUTER_SUCCESS_CODE) {
    throw rejected(method, `outer code=${outerCode ?? 'unknown'}`);
  }

  const result = Object.hasOwn(outer, keys.resultKey) ? outer[keys.resultKey] : undefined;
  if (typeof result !== 'string') throw unavailable(method, 'result is not a JSON string');
  const inner = decodeInner(method, result);

  // 外层成功不算数：内层 code 才决定成败，message 一律不看。
  const code = codeText(inner.code);
  if (code === undefined) throw unavailable(method, 'missing inner code');
  if (code !== INNER_SUCCESS_CODE) {
    throw innerFailure(method, code, warn, innerCodes, warnCodes, windowTooLargeCodes);
  }
  return inner;
}
