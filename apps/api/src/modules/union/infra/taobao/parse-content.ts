// 淘宝 resolveLink 第二段经大淘客万能解析（B1-04zzzzo，D10-2683 / D10-2891 / D10-2893）：
// GET /api/tb-service/parse-content，version v1.0.0，经 TaobaoUnionAdapter 的 orderSource（DataokeClient，
// 签名与错误分类沿用 B1-04m）。
// - 参数：只有 content = 用户输入原样（不裁剪、不改写）；空白输入不发请求，按 link_unrecognized。
// - 出参：只读 data.goodsId（非空字符串）；goodsId 不是凑狸口径 item_id（D10-504），由适配器再以它发一次
//   item.info.upgrade.get 取本次返回的 item_id 原串（BR-PROD-05）。data 里的 pid、commission*、转链 url、
//   originInfo（含 activityId）等一律不读、不进结果、不进日志与错误信息。
// - 外层 code 25003（解析不到商品）→ link_unrecognized；其余非 0 code 照 B1-04m 分类（dataoke/response.ts）。
// - 成功码但 data 缺失或为 null（没认出商品）→ link_unrecognized（经 dataoke/response.ts 的 missingData，
//   不靠报错文字）；HTTP 故障、非 JSON、非 0 code 仍照 B1-04m 分类。
// - 归档 kind = query（适配器挂）。请求摘要不留 content（archiveOmitParams，用户粘贴的淘口令原文不入库）；
//   应答正文按白名单改写后再存（parseContentArchiveBody）：只留外层 code、data.goodsId 与 data 里 TOP
//   error_response 的 code / sub_code；msg（可能回显原文）、pid、commission*、url、originInfo 等一律不存。
// TODO(规划/11 §4.5): goodsId 字段位置与 25003 语义待真实样本核对 — blocked on FU-PARSE-CONTENT-SAMPLES
import { UnionError, type UnionErrorCode } from '../../domain/types.ts';
import type { DataokeCodeMap, DataokeParameters } from '../dataoke/dataoke-client.ts';

/** The request path of the 大淘客 万能解析. */
export type DataokeParseContentPath = '/api/tb-service/parse-content';

/** The interface version of the 大淘客 万能解析. */
export type DataokeParseContentVersion = 'v1.0.0';

export const DATAOKE_PARSE_CONTENT_PATH: DataokeParseContentPath = '/api/tb-service/parse-content';
export const DATAOKE_PARSE_CONTENT_VERSION: DataokeParseContentVersion = 'v1.0.0';

/** 解析不到商品的外层 code（数字与同值字符串同等，dataoke/response.ts 统一按文本比较）。 */
export const DATAOKE_PARSE_CONTENT_CODES: DataokeCodeMap = Object.freeze({
  '25003': 'link_unrecognized',
});

/** 成功码但 data 缺失或 null 时的分类（DataokeRequestOptions.missingData）。 */
export const DATAOKE_PARSE_CONTENT_MISSING_DATA: UnionErrorCode = 'link_unrecognized';

/** 归档请求摘要里不留的参数（DataokeRequestOptions.archiveOmitParams）：content 是用户输入原文。 */
export const DATAOKE_PARSE_CONTENT_ARCHIVE_OMIT: readonly string[] = Object.freeze(['content']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 码值只留数字或字符串原样；其他类型不存。 */
function isCodeValue(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * 归档用的应答正文（DataokeRequestOptions.archiveBody）：白名单改写。外层只留 code；data 是对象时只留
 * goodsId（字符串）与 error_response 的 code / sub_code，data 为 null 时留 null，其余形状不留 data。
 * 正文不是 JSON 对象时存空串（不存可能回显输入的原文）。调用方拿到的应答不变。
 */
export function parseContentArchiveBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (!isRecord(parsed)) return '';
  const kept: Record<string, unknown> = {};
  if (Object.hasOwn(parsed, 'code') && isCodeValue(parsed['code'])) kept['code'] = parsed['code'];
  const data = Object.hasOwn(parsed, 'data') ? parsed['data'] : undefined;
  if (data === null) {
    kept['data'] = null;
  } else if (isRecord(data)) {
    const keptData: Record<string, unknown> = {};
    if (typeof data['goodsId'] === 'string') keptData['goodsId'] = data['goodsId'];
    const error = data['error_response'];
    if (isRecord(error)) {
      const keptError: Record<string, unknown> = {};
      if (isCodeValue(error['code'])) keptError['code'] = error['code'];
      if (isCodeValue(error['sub_code'])) keptError['sub_code'] = error['sub_code'];
      keptData['error_response'] = keptError;
    }
    kept['data'] = keptData;
  }
  return JSON.stringify(kept);
}

function unrecognized(reason: string): UnionError {
  return new UnionError('link_unrecognized', `taobao resolveLink: ${reason}`, 'taobao');
}

/** Business parameters of one parse: content as given; blank input is refused before any request. */
export function parseContentParameters(raw: string): DataokeParameters {
  if (typeof raw !== 'string' || raw.trim() === '') throw unrecognized('blank content');
  return { content: raw };
}

/** data.goodsId when it is a non-empty string; anything else (absent, '', number…) → link_unrecognized. */
export function parseContentGoodsId(data: Readonly<Record<string, unknown>>): string {
  const goodsId = Object.hasOwn(data, 'goodsId') ? data['goodsId'] : undefined;
  if (typeof goodsId !== 'string' || goodsId === '') throw unrecognized('no goods in content');
  return goodsId;
}
