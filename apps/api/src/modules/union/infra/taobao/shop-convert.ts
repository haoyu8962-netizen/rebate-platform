// 淘宝店铺转链经大淘客店铺转链（B1-04zzt，S-17 S17-u2，D10-806）：GET /api/dels/shop/convert，
// version v1.0.0，经 TaobaoUnionAdapter 的 orderSource（DataokeClient，签名与错误分类沿用 B1-04m）。
// - 参数：sellerId = ShopConvertReq.shopRef（正整数十进制串，不合格 → 拒绝不发请求）；shopName 必填
//   （空白 → 拒绝不发请求）；pid = identity.claims.promotionSlot（缺 → invalid_identity）；relationId =
//   identity.claims.relationId（null 也拒绝：进店没有「无返利」路径）。authId 不带。入参不合格不取凭据、
//   不发请求。
// - 出参：HTTP 2xx、code 0 且 shopLinks 合格 → { url: shopLinks, tpwd?, longTpwd? }；tpwd 字段名大小写
//   兼容（tpwd 优先，再 Tpwd），空串 / null / 非字符串当作没有。缺 shopLinks、链接不合格、code 0 而
//   HTTP 非 2xx、非 JSON、data 非对象 → upstream_unavailable；外层 code 非 0 照 B1-04m 分类。从不返回
//   无推广参数的地址；错误信息只用固定文本，不带 pid、relationId、店名与链接原文。
// - shopLinks 合格：无空白的绝对 https URL，无 userinfo、无端口，主机全等于淘宝联盟推广跳转主机
//   白名单（只有 s.click.taobao.com：规划/09 2_TB §2.11 实测 shopLinks 为 https://s.click.taobao.com/… 长链），
//   不收任意 *.taobao.com（店铺自身页面 shopNNN.taobao.com 没有推广参数），且必须带路径或查询（不是裸主机）。
// - 归档 kind = convert（同商品转链）。
import {
  isServerIdentity,
  UnionError,
  type ShopConvertReq,
  type ShopConvertResult,
  type UnionIdentity,
} from '../../domain/types.ts';
import type { DataokeExchange, DataokeParameters } from '../dataoke/dataoke-client.ts';

/** The request path of the 大淘客 shop convert. */
export type DataokeShopConvertPath = '/api/dels/shop/convert';

/** The interface version of the 大淘客 shop convert. */
export type DataokeShopConvertVersion = 'v1.0.0';

export const DATAOKE_SHOP_CONVERT_PATH: DataokeShopConvertPath = '/api/dels/shop/convert';
export const DATAOKE_SHOP_CONVERT_VERSION: DataokeShopConvertVersion = 'v1.0.0';

/**
 * Taobao union promotion redirect hosts a shopLinks may point at, compared for exact equality
 * (规划/09 2_TB §2.11: shopLinks is an https://s.click.taobao.com/… long link). Any other host,
 * including other *.taobao.com hosts such as a shop's own page, is refused.
 */
export const SHOP_LINK_HOSTS: ReadonlySet<string> = new Set(['s.click.taobao.com']);

const PORT = 'convertShop';
const SHOP_REF = /^[1-9][0-9]*$/;

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(reason: string): UnionError {
  return new UnionError('upstream_unavailable', `taobao ${PORT}: ${reason}`, 'taobao');
}

/**
 * Business parameters (sellerId, pid, shopName, relationId) of one shop conversion, checked before
 * any credential is fetched or request sent.
 */
export function shopConvertParameters(
  req: ShopConvertReq,
  identity: UnionIdentity,
): DataokeParameters {
  const refuse = (reason: string) =>
    new UnionError('invalid_identity', `taobao ${PORT}: identity ${reason}`, 'taobao');
  if (!isServerIdentity(identity) || identity.claims.platform !== 'taobao') {
    throw refuse('is not a server-built taobao identity');
  }
  const { promotionSlot, relationId } = identity.claims;
  if (!nonBlank(promotionSlot)) throw refuse('has no promotion slot');
  // 进店没有「无返利」路径：null 也拒绝。
  if (!nonBlank(relationId)) throw refuse('has no relation id');

  const shopRef = isRecord(req) ? req.shopRef : undefined;
  const shopName = isRecord(req) ? req.shopName : undefined;
  if (typeof shopRef !== 'string' || !SHOP_REF.test(shopRef)) {
    throw new UnionError('invalid_dto', `taobao ${PORT}: shopRef is not a seller id`, 'taobao');
  }
  if (!nonBlank(shopName)) {
    throw new UnionError('invalid_dto', `taobao ${PORT}: shopName is required`, 'taobao');
  }
  return { sellerId: shopRef, pid: promotionSlot, shopName, relationId };
}

/** True for an https Taobao union redirect link with a path or query (see the header). */
export function isShopLink(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https:\/\/[^\s]+$/i.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    SHOP_LINK_HOSTS.has(url.hostname) &&
    (url.pathname !== '/' || url.search !== '')
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The 大淘客 answer (HTTP status and `data`) → ShopConvertResult, or upstream_unavailable. */
export function mapShopConvert(exchange: DataokeExchange): ShopConvertResult {
  const { status } = exchange.response;
  if (!(status >= 200 && status < 300)) throw unavailable('unexpected HTTP status');
  const { data } = exchange;
  if (!isRecord(data)) throw unavailable('response data is not an object');
  // 链接原文不进错误信息。
  if (!isShopLink(data.shopLinks)) throw unavailable('no promoted shop link');
  const tpwd = text(data.tpwd) ?? text(data.Tpwd);
  const longTpwd = text(data.longTpwd);
  return {
    url: data.shopLinks,
    ...(tpwd === undefined ? {} : { tpwd }),
    ...(longTpwd === undefined ? {} : { longTpwd }),
  };
}
