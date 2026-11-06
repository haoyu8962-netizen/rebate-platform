// 京东商品接口（jd.union.open.goods.query，B1-04zc）的请求参数、游标、选券、价格与 DTO 映射。
// 规则测试：test/spec/union/jd-goods/**；映射口径见 specs/union/jd.md（D10-525）。
// 权限批下前只按文档，字段待实测再校。映射只读下列字段，从不 spread 整份报文：itemId、skuId、skuName、
// priceInfo.{price, lowestCouponPrice}、commissionInfo.commissionShare、
// couponInfo.couponList[].{discount, quota, useStartTime, useEndTime, couponStatus}，
// 以及 shopInfo.{shopName, shopLevel, shopId}（B1-04zzg / B1-04zzm）。
// lowestPrice 不读；lowestCouponPrice 只用于比对告警，不参与计算；isBest 不看；图片不映射（B1-22s）。
// 报价字段的 JSON 数字先 String(Number(原文)) 再交 parseYuanToFen（D10-525），佣金比例取原文按
// BR-CALC-26 floor。错误与告警只带固定文案、商品标识与分值，不带报文内容、比例原文、关键词、券链接。
// TODO(规划/09 CAP-JD-02): 字段名、空结果形状、skuId 是否出现待权限批下后实测核对 — blocked on 商品接口权限
import { parseYuanToFen } from '@couli/domain';
import { InvalidRatio, pctStrToBp, subFen } from '@couli/money';
import type { PriceAnomalyReason } from '../../domain/taobao-price.ts';
import {
  couponEndAtField,
  shopNameField,
  shopRefField,
  shopScoresField,
  UnionError,
  type ItemRef,
  type UnionItemDetail,
} from '../../domain/types.ts';
import { scalarText, type JdProductKeyMode } from './orders.ts';
import {
  JdRawNumber,
  type JdInner,
  type JdInnerCodeMap,
  type JdResponseKeys,
  type JdWarning,
} from './response.ts';

export const JD_GOODS_QUERY = 'jd.union.open.goods.query';
/** 外层键的 `_responce` 是网关自己的拼写。 */
export const JD_GOODS_KEYS: JdResponseKeys = {
  envelope: 'jd_union_open_goods_query_responce',
  resultKey: 'queryResult',
};
export const JD_GOODS_PAGE_SIZE = 20;
/** sceneId 固定 1；2 须申请，本段不用。 */
export const JD_GOODS_SCENE = 1;

/** 410、411：sceneId 无权限或格式不匹配。201 空结果、202 分页上限各端口含义不同，分开登记。 */
const UNRECOGNIZED_CODES: JdInnerCodeMap = {
  '410': 'link_unrecognized',
  '411': 'link_unrecognized',
};
/** 搜索把 201、202 都登记成 item_unavailable，由适配器收成空页。 */
export const JD_SEARCH_INNER_CODES: JdInnerCodeMap = {
  ...UNRECOGNIZED_CODES,
  '201': 'item_unavailable',
  '202': 'item_unavailable',
};
export const JD_DETAIL_INNER_CODES: JdInnerCodeMap = {
  ...UNRECOGNIZED_CODES,
  '201': 'item_unavailable',
};
export const JD_LINK_INNER_CODES: JdInnerCodeMap = {
  ...UNRECOGNIZED_CODES,
  '201': 'link_unrecognized',
};

/** 严格匹配 jingfen 详情页；仿冒的域名与路径走 keyword。itemId 字符集之外的同样走 keyword。 */
const JINGFEN_DETAIL =
  /^(?:https?:\/\/)?jingfen\.jd\.com\/detail\/([A-Za-z0-9_-]+)\.html(?:[?#].*)?$/;
/** skuId 为 0 不是商品标识：当作缺失，否则所有商品落到同一个键上。 */
const SKU_ID = /^[1-9][0-9]*$/;
const NOT_CLAIMABLE_STATUS = '-1';

/** 一页商品报文的取数信息；warn 收 PRICE_ANOMALY、PRICE_CALC_DIFF。 */
export interface JdGoodsPage {
  readonly now: Date;
  readonly productKeyMode: JdProductKeyMode;
  readonly warn: ((event: JdWarning) => void) | undefined;
}

/** 选中的券，整数分。 */
export interface JdCouponChoice {
  readonly discount_fen: bigint;
  readonly quota_fen: bigint;
}

/** 价格数据异常；不带报文内容。 */
export interface JdPriceAnomalyWarning extends JdWarning {
  readonly code: 'PRICE_ANOMALY';
  readonly item_id: string | null;
  readonly reason: PriceAnomalyReason;
}

/** 自算券后价与 lowestCouponPrice 相差 ≥ 1 分：只带商品标识与两个分值。 */
export interface JdPriceDiffWarning extends JdWarning {
  readonly code: 'PRICE_CALC_DIFF';
  readonly item_id: string;
  readonly final_price_fen: bigint;
  readonly lowest_coupon_price_fen: bigint;
}

function invalid(message: string): UnionError {
  return new UnionError('invalid_dto', `jd goods: ${message}`, 'jd');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 缺失与 JSON null 都当作没有。 */
function field(row: Record<string, unknown>, name: string): unknown {
  const value = row[name];
  return value === null ? undefined : value;
}

function recordField(row: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = field(row, name);
  return isRecord(value) ? value : {};
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// ---- 请求与游标 --------------------------------------------------------------------------

/** 关键词取一页的 goodsReqDTO；resolveLink 把链接原样当关键词。 */
export function jdKeywordQuery(
  keyword: string,
  pageIndex: number,
): Readonly<Record<string, unknown>> {
  return { keyword, pageIndex, pageSize: JD_GOODS_PAGE_SIZE, sceneId: JD_GOODS_SCENE };
}

/** 游标 `jd-goods:<页码>` 指下一次要取的页，不透明；keyword 不进游标，由调用方续传。 */
export function jdGoodsCursor(pageIndex: number): string {
  return `jd-goods:${pageIndex}`;
}

export function parseJdGoodsCursor(cursor: string): number {
  const match = /^jd-goods:([1-9][0-9]{0,8})$/.exec(cursor);
  const pageIndex = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(pageIndex) || pageIndex < 2) {
    throw invalid('cursor does not belong to a goods search');
  }
  return pageIndex;
}

/** 内层 data：缺失是空结果（照订单实测），在但不是数组报错，不当空结果。 */
export function jdGoodsRows(inner: JdInner): readonly unknown[] {
  if (!Object.hasOwn(inner, 'data')) return [];
  const { data } = inner;
  if (!Array.isArray(data)) throw invalid('data is not an array');
  return data as readonly unknown[];
}

/**
 * 已取条数按上游行数算，不按出卡数。空页结束；totalCount 不可用时退回「满页才继续」。
 * totalCount 偏大时多取的一页由 201、202 或空页收尾。
 */
export function jdGoodsHasMore(inner: JdInner, rowCount: number, pageIndex: number): boolean {
  if (rowCount === 0) return false;
  const total = inner.totalCount;
  if (!(total instanceof JdRawNumber) || !/^[0-9]{1,15}$/.test(total.text)) {
    return rowCount >= JD_GOODS_PAGE_SIZE;
  }
  return (pageIndex - 1) * JD_GOODS_PAGE_SIZE + rowCount < Number(total.text);
}

/**
 * ItemRef → itemIds 的一项：item_id 优先，其次 catalog 给的 itemId。sku 模式没有 sceneId=2 权限，
 * 手里的 skuId 也不能当 itemIds 传，所以不发请求，直接 item_unavailable。
 */
export function jdDetailItemId(ref: ItemRef, mode: JdProductKeyMode): string {
  if (!isRecord(ref) || ref.platform !== 'jd') throw invalid('item is not a jd item');
  const id = nonBlank(ref.item_id) ?? nonBlank(ref.itemId);
  if (mode === 'item' && id !== undefined) return id;
  if (mode === 'item' || (id === undefined && nonBlank(ref.skuId) === undefined)) {
    throw invalid('item_id is required');
  }
  throw new UnionError('item_unavailable', 'jd goods: no detail lookup in sku mode', 'jd');
}

/** jingfen 详情页里的 itemId；不是这个形态为 null。只认这一种，不从别的链接抽标识。 */
export function jingfenItemId(link: string): string | null {
  return JINGFEN_DETAIL.exec(link)?.[1] ?? null;
}

// ---- 商品身份 ----------------------------------------------------------------------------

/**
 * 一行的商品引用（BR-PROD-03 / 05）：item 模式 item_id = itemId 全串，sku 模式 item_id = skuId 原文，
 * 另一个字段有值才给。当前模式的键缺失为 null，两者不互相顶替，也不从链接补。
 */
export function jdGoodsRef(
  input: unknown,
  mode: JdProductKeyMode,
): (ItemRef & { readonly item_id: string }) | null {
  if (!isRecord(input)) return null;
  const itemId = nonBlank(field(input, 'itemId'));
  const skuText = scalarText(field(input, 'skuId'));
  const skuId = skuText !== undefined && SKU_ID.test(skuText) ? skuText : undefined;
  const key = mode === 'sku' ? skuId : itemId;
  if (key === undefined) return null;
  return {
    platform: 'jd',
    item_id: key,
    ...(itemId === undefined ? {} : { itemId }),
    ...(skuId === undefined ? {} : { skuId }),
  };
}

// ---- 价格 --------------------------------------------------------------------------------

/**
 * 报价字段 → 分（D10-525）：JSON 数字先转 String(n)，字符串原样；parseYuanToFen 不收的都算缺失，
 * 不舍入。这里的 Number 只为得到默认十进制写法，不做运算。
 */
function quoteFen(value: unknown): bigint | undefined {
  const text = value instanceof JdRawNumber ? String(Number(value.text)) : value;
  if (typeof text !== 'string') return undefined;
  return parseYuanToFen(text) ?? undefined;
}

/** 毫秒时间戳；只收 JSON 非负安全整数，其余 undefined（该券不算候选）。 */
function epochMs(value: unknown): number | undefined {
  if (!(value instanceof JdRawNumber) || !/^[0-9]{1,16}$/.test(value.text)) return undefined;
  const ms = Number(value.text);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/** 百分比原文 → bp（BR-CALC-26，超两位小数 floor），0..100 %；其余 undefined，不当 0。 */
function commissionBp(value: unknown): bigint | undefined {
  const text = scalarText(value);
  if (text === undefined) return undefined;
  try {
    return pctStrToBp(text);
  } catch (error) {
    if (error instanceof InvalidRatio) return undefined;
    throw error;
  }
}

/** 选中的券连同它的 useEndTime（毫秒）；只在本文件内用，不外露券的其他字段。 */
interface JdSelectedCoupon {
  readonly choice: JdCouponChoice;
  readonly end_ms: number;
}

/** 一张券合格时给出面额与门槛。缺 discount、quota 或有效期，或不可领取的，都不是候选。 */
function eligibleCoupon(entry: unknown, priceFen: bigint, nowMs: number): JdSelectedCoupon | null {
  if (!isRecord(entry)) return null;
  if (scalarText(field(entry, 'couponStatus')) === NOT_CLAIMABLE_STATUS) return null;
  const discount = quoteFen(field(entry, 'discount'));
  const quota = quoteFen(field(entry, 'quota'));
  const start = epochMs(field(entry, 'useStartTime'));
  const end = epochMs(field(entry, 'useEndTime'));
  if (discount === undefined || quota === undefined) return null;
  if (start === undefined || end === undefined) return null;
  if (nowMs < start || nowMs >= end || priceFen < quota) return null;
  return { choice: { discount_fen: discount, quota_fen: quota }, end_ms: end };
}

/**
 * 选券本体（BR-PRICE-01）：合格券里面额最大，面额相同取门槛低的；完全并列保留先出现的那张。
 * pickJdCoupon 与 coupon_end_at（B1-04zzm）都从这里取，保证结束时刻与 coupon_fen 是同一张券。
 */
function selectJdCoupon(
  coupons: unknown,
  priceFen: bigint,
  nowMs: number,
): JdSelectedCoupon | null {
  if (!Array.isArray(coupons)) return null;
  let best: JdSelectedCoupon | null = null;
  for (const entry of coupons as readonly unknown[]) {
    const candidate = eligibleCoupon(entry, priceFen, nowMs);
    if (candidate === null) continue;
    const better =
      best === null ||
      candidate.choice.discount_fen > best.choice.discount_fen ||
      (candidate.choice.discount_fen === best.choice.discount_fen &&
        candidate.choice.quota_fen < best.choice.quota_fen);
    if (better) best = candidate;
  }
  return best;
}

/**
 * 从 couponInfo.couponList 选券（BR-PRICE-01）；一张都不合格为 null。合格券里面额最大，面额相同取
 * 门槛低的；isBest 不参与。接口没有剩余量字段，视为有余量。
 */
export function pickJdCoupon(
  coupons: unknown,
  priceFen: bigint,
  nowMs: number,
): JdCouponChoice | null {
  return selectJdCoupon(coupons, priceFen, nowMs)?.choice ?? null;
}

type PriceResult =
  | {
      readonly status: 'ok';
      readonly price: bigint;
      readonly coupon: bigint;
      readonly final: bigint;
      /** useEndTime（毫秒）of the coupon counted in `coupon`; null when coupon is 0. */
      readonly couponEndMs: number | null;
    }
  | { readonly status: 'anomaly'; readonly reason: PriceAnomalyReason };

/**
 * BR-PRICE-01 京东：price = priceInfo.price，final = price − coupon 一律自算，平台券后价白名单为空。
 * coupon < price 已保证 final > 0，不再单判。
 */
function jdPrice(row: Record<string, unknown>, nowMs: number): PriceResult {
  const price = quoteFen(field(recordField(row, 'priceInfo'), 'price'));
  if (price === undefined) return { status: 'anomaly', reason: 'missing_field' };
  const coupons = field(recordField(row, 'couponInfo'), 'couponList');
  const selected = selectJdCoupon(coupons, price, nowMs);
  const coupon = selected?.choice.discount_fen ?? 0n;
  if (price <= 0n || coupon >= price) return { status: 'anomaly', reason: 'invalid_price' };
  const couponEndMs = selected !== null && coupon > 0n ? selected.end_ms : null;
  return { status: 'ok', price, coupon, final: subFen(price, coupon), couponEndMs };
}

/**
 * B1-04zzm（S-09 S09c，D10-736 ⑥）：店铺等级与商品侧店铺标识，只读 shopInfo，顶层同名键不读。
 * shop_scores 只出 shopInfo.shopLevel → level（原文），不出 desc / serv / lgst；shop_ref =
 * shopInfo.shopId 原文，只收正整数（0、负数、小数、空串都不出）。京东不出 sales_text、shop_logo。
 */
function jdShopExtras(
  row: Record<string, unknown>,
): Pick<UnionItemDetail, 'shop_scores' | 'shop_ref'> {
  const shop = recordField(row, 'shopInfo');
  return {
    ...shopScoresField([['level', scalarText(field(shop, 'shopLevel'))]]),
    ...shopRefField(scalarText(field(shop, 'shopId'))),
  };
}

type QuotedFields = 'price_fen' | 'coupon_fen' | 'final_price_fen' | 'commission_rate_bp';
type UnquotedItem = Omit<UnionItemDetail, QuotedFields> & { readonly item_id: string };

/** 三价与比例置 0 占位，不显示：price_status 已标异常。告警只带固定字段。 */
function anomalyItem(
  base: UnquotedItem,
  reason: PriceAnomalyReason,
  warn: JdGoodsPage['warn'],
): UnionItemDetail {
  const event: JdPriceAnomalyWarning = {
    method: JD_GOODS_QUERY,
    code: 'PRICE_ANOMALY',
    item_id: base.item_id,
    reason,
  };
  warn?.(event);
  return Object.freeze({
    ...base,
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    commission_rate_bp: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: reason,
  });
}

/**
 * 一条商品（内层数字都是 JdRawNumber）→ 统一 DTO。商品键、标题不合格 invalid_dto；价格或佣金不合格
 * 出 price_status='anomaly' 并告警一次（搜索不出卡，详情照样返回）。价格算得出时再比对 lowestCouponPrice，
 * 差 ≥ 1 分只告警，不改结果。
 */
export function mapJdGoods(input: unknown, page: JdGoodsPage): UnionItemDetail {
  const ref = jdGoodsRef(input, page.productKeyMode);
  if (ref === null) throw invalid('goods row has no product key');
  const row = input as Record<string, unknown>;
  const title = nonBlank(field(row, 'skuName'));
  if (title === undefined) throw invalid('skuName must be a non-empty string');
  // B1-22s：图片在实测前不映射，imageInfo 不读。
  // B1-04zzg：店铺名只取 shopInfo.shopName，商品项顶层的同名键不读。
  const base = {
    ...ref,
    title,
    ...shopNameField(field(recordField(row, 'shopInfo'), 'shopName')),
    quoted_at: page.now.toISOString(),
    ...jdShopExtras(row),
  };
  const price = jdPrice(row, page.now.getTime());
  if (price.status === 'anomaly') return anomalyItem(base, price.reason, page.warn);
  const commission = commissionBp(field(recordField(row, 'commissionInfo'), 'commissionShare'));
  if (commission === undefined) return anomalyItem(base, 'missing_field', page.warn);
  const lowest = quoteFen(field(recordField(row, 'priceInfo'), 'lowestCouponPrice'));
  if (lowest !== undefined && lowest !== price.final) {
    const event: JdPriceDiffWarning = {
      method: JD_GOODS_QUERY,
      code: 'PRICE_CALC_DIFF',
      item_id: ref.item_id,
      final_price_fen: price.final,
      lowest_coupon_price_fen: lowest,
    };
    page.warn?.(event);
  }
  return Object.freeze({
    ...base,
    price_fen: price.price,
    coupon_fen: price.coupon,
    final_price_fen: price.final,
    commission_rate_bp: commission,
    price_status: 'ok',
    // B1-04zzm：券结束时刻来自与 coupon_fen 同一张券（selectJdCoupon），只在 coupon_fen > 0 时出。
    ...(price.couponEndMs === null ? {} : couponEndAtField(price.couponEndMs)),
  });
}
