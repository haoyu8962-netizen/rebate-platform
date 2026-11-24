// 淘宝 resolveLink 第二段经大淘客万能解析（B1-04zzzzo，D10-2683 / D10-2891 / D10-2893）：
// GET /api/tb-service/parse-content，version v1.0.0，经 TaobaoUnionAdapter 的 orderSource（DataokeClient，
// 签名与错误分类沿用 B1-04m）。
// - 参数：只有 content = 用户输入原样（不裁剪、不改写）；空白输入不发请求，按 link_unrecognized。
// - 出参：只读 data.goodsId（非空字符串）；goodsId 不是凑狸口径 item_id（D10-504），由适配器再以它发一次
//   item.info.upgrade.get 取本次返回的 item_id 原串（BR-PROD-05）。data 里的 pid、commission*、转链 url、
//   originInfo（含 activityId）等一律不读、不进结果、不进日志与错误信息。
// - 外层 code 25003（解析不到商品）→ link_unrecognized；其余非 0 code 照 B1-04m 分类（dataoke/response.ts）。
// - 归档 kind = query（适配器挂）。
// TODO(规划/11 §4.5): goodsId 字段位置与 25003 语义待真实样本核对 — blocked on FU-PARSE-CONTENT-SAMPLES
import { UnionError } from '../../domain/types.ts';
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
