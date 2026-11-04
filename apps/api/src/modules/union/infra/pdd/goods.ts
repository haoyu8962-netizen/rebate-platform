// 拼多多商品侧映射（B1-04u；BR-PRICE-01 / BR-PRICE-02，09 4_PDD CAP-PDD-01/02/03/10）：
// goods.search / goods.detail / goods.recommend.get 的请求参数、游标编码与商品 DTO 映射，
// 以及查询身份（D-u2：已备案的 pid + custom_parameters）的校验。
// 映射只读任务书 probe 字段清单里、三个商品接口共有的下列字段，从不 spread 整份报文：
// goods_id、goods_sign、goods_name、goods_desc（只详情用）、min_group_price、coupon_discount、
// coupon_min_order_amount、coupon_start_time、coupon_end_time、coupon_remain_quantity、promotion_rate，
// 以及图片 goods_image_url、goods_gallery_urls（B1-04zzf）。
// 单买价 min_normal_price、预测 / 分享比例、平台券、店铺券、收藏券、补贴都不计入（待 CAP-PDD-02 实测另开）。
// 金额是 JSON 整数分，经 @couli/money 的 parseFen / subFen 运算；不经浮点。
import { InvalidAmount, parseFen, subFen } from '@couli/money';
import { normalizeItemImages } from '../../domain/item-images.ts';
import type { PriceAnomalyReason } from '../../domain/taobao-price.ts';
import { UnionError, type ItemRef, type UnionItemDetail } from '../../domain/types.ts';

export const PDD_GOODS_SEARCH = 'pdd.ddk.goods.search';
export const PDD_GOODS_DETAIL = 'pdd.ddk.goods.detail';
export const PDD_GOODS_RECOMMEND = 'pdd.ddk.goods.recommend.get';
export const PDD_URL_SHORT_PARSE = 'pdd.ddk.url.short.parse';

/** goods.search 的 page_size 取值 10–100（probe：传 5 报 50001 / sub_code 3000000）。 */
export const PDD_SEARCH_PAGE_SIZE = 20;
/** goods.recommend.get 每页条数（probe 用 10 成功）。 */
export const PDD_FEED_LIMIT = 20;
/** 本段固定精选频道（台账：与进宝网站一致）；要按频道取另开任务改端口。 */
export const PDD_FEED_CHANNEL = 4;
/** 游标页码 / 偏移的上限，只用于拒绝畸形游标。 */
const MAX_SEARCH_PAGE = 10_000;
const MAX_FEED_OFFSET = 1_000_000;
/** custom_parameters 按 UTF-8 字节计不超过 64（D-u2）。 */
const MAX_CUSTOM_PARAMETERS_BYTES = 64;
/** promotion_rate 是千分比整数；100 % = 1000。 */
const MAX_PROMOTION_RATE = 1000;

export type PddGoodsSource = 'search' | 'detail' | 'feed';

/** D-u2：服务端提供已备案的查询身份；customParameters 是不超过 64 字节的 JSON。 */
export interface PddQueryIdentity {
  readonly pid: string;
  readonly customParameters: string;
}

function invalid(message: string): UnionError {
  return new UnionError('invalid_dto', `pdd goods: ${message}`, 'pdd');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受提供者给出的两段字符串；空 pid、非 JSON、超长一律不出站。 */
export function checkQueryIdentity(value: unknown): {
  readonly pid: string;
  readonly custom_parameters: string;
} {
  const refuse = (reason: string) =>
    new UnionError('invalid_identity', `pdd goods: query identity ${reason}`, 'pdd');
  if (!isRecord(value)) throw refuse('is not an object');
  const { pid, customParameters } = value;
  if (typeof pid !== 'string' || pid.trim() === '') throw refuse('has no pid');
  if (typeof customParameters !== 'string') throw refuse('has no custom_parameters');
  if (new TextEncoder().encode(customParameters).length > MAX_CUSTOM_PARAMETERS_BYTES) {
    throw refuse('custom_parameters exceeds 64 bytes');
  }
  try {
    JSON.parse(customParameters);
  } catch {
    throw refuse('custom_parameters is not JSON');
  }
  // 原字节透传：不重新序列化 JSON，不 trim。
  return { pid, custom_parameters: customParameters };
}

// ---- 游标 -------------------------------------------------------------------------------
// search：`pdd-search:<page>:<list_id 的 base64url>`（list_id 缺失时为空串）；keyword 不进游标，
// 由调用方续传同一个关键词。feed：`pdd-feed:<offset>`（recommend 的 probe 响应没有 list_id，用 offset / limit）。

export interface SearchCursor {
  readonly page: number;
  readonly listId: string | null;
}

export function searchCursor(page: number, listId: string | null): string {
  return `pdd-search:${page}:${Buffer.from(listId ?? '', 'utf8').toString('base64url')}`;
}

export function parseSearchCursor(cursor: string): SearchCursor {
  const match = /^pdd-search:([1-9][0-9]{0,4}):([A-Za-z0-9_-]*)$/.exec(cursor);
  const page = match === null ? Number.NaN : Number(match[1]);
  if (match === null || page < 2 || page > MAX_SEARCH_PAGE) {
    throw invalid('cursor does not belong to a goods search');
  }
  const encoded = match[2]!;
  const listId = Buffer.from(encoded, 'base64url').toString('utf8');
  if (Buffer.from(listId, 'utf8').toString('base64url') !== encoded) {
    throw invalid('cursor does not belong to a goods search');
  }
  return { page, listId: listId === '' ? null : listId };
}

export function feedCursor(offset: number): string {
  return `pdd-feed:${offset}`;
}

export function parseFeedCursor(cursor: string): number {
  const match = /^pdd-feed:([1-9][0-9]{0,6})$/.exec(cursor);
  const offset = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > MAX_FEED_OFFSET) {
    throw invalid('cursor does not belong to a material feed');
  }
  return offset;
}

// ---- 外层列表 ----------------------------------------------------------------------------

const LIST_KEYS: Readonly<Record<PddGoodsSource, string>> = {
  search: 'goods_list',
  detail: 'goods_details',
  feed: 'list',
};

/** 外层里的商品数组；不是数组即报错，不当作空页。 */
export function goodsRows(envelope: unknown, source: PddGoodsSource): readonly unknown[] {
  const key = LIST_KEYS[source];
  if (!isRecord(envelope) || !Array.isArray(envelope[key])) {
    throw invalid(`${key} is not an array`);
  }
  return envelope[key];
}

/** 外层的非负安全整数（total_count / total）；其他一律视为未给出。 */
export function envelopeCount(envelope: unknown, key: 'total_count' | 'total'): number | null {
  if (!isRecord(envelope)) return null;
  const value = envelope[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** goods.search 的 list_id；非空字符串才算。 */
export function envelopeListId(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  const value = envelope.list_id;
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---- 商品身份与 DTO ----------------------------------------------------------------------

/** 缺失与 JSON null 都当作没有。 */
function field(row: Record<string, unknown>, name: string): unknown {
  const value = row[name];
  return value === null ? undefined : value;
}

/** D-u1：goods_id 取响应 JSON 整数转十进制字符串，非安全整数 invalid_dto；goods_sign 必填。 */
export function pddGoodsRef(input: unknown): ItemRef & {
  readonly goods_id: string;
  readonly goods_sign: string;
} {
  if (!isRecord(input)) throw invalid('goods row is not an object');
  const id = input.goods_id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw invalid('goods_id must be a non-negative safe integer');
  }
  const sign = input.goods_sign;
  if (typeof sign !== 'string' || sign.trim() === '') {
    throw invalid('goods_sign must be a non-empty string');
  }
  return { platform: 'pdd', goods_id: String(id), goods_sign: sign };
}

function commissionBp(value: unknown): bigint {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_PROMOTION_RATE
  ) {
    throw invalid('promotion_rate must be an integer per-mille within 0..1000');
  }
  return BigInt(value) * 10n;
}

/** JSON 非负安全整数分 → bigint；不合格返回 undefined（由调用方按价格异常处理）。 */
function fen(value: unknown): bigint | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  try {
    return parseFen(value);
  } catch (error) {
    if (error instanceof InvalidAmount) return undefined;
    throw error;
  }
}

/** JSON 非负安全整数（秒级时间戳、余量）；不合格返回 undefined。 */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

type PriceResult =
  | {
      readonly status: 'ok';
      readonly price: bigint;
      readonly coupon: bigint;
      readonly final: bigint;
    }
  | { readonly status: 'anomaly'; readonly reason: PriceAnomalyReason };

/**
 * BR-PRICE-01 / 02 拼多多：price = min_group_price；coupon 只取 coupon_discount，三条都满足才可用
 * （门槛 coupon_min_order_amount ≤ min_group_price、coupon_start_time ≤ now < coupon_end_time〔秒〕、
 * coupon_remain_quantity > 0，未返回余量视为有余量），否则 0；has_coupon 不参与判断。
 */
function pddPrice(row: Record<string, unknown>, nowMs: number): PriceResult {
  const price = fen(field(row, 'min_group_price'));
  if (price === undefined || price <= 0n) return { status: 'anomaly', reason: 'missing_field' };
  const discount = fen(field(row, 'coupon_discount'));
  if (discount === undefined) return { status: 'anomaly', reason: 'missing_field' };
  let coupon = 0n;
  if (discount > 0n) {
    const threshold = fen(field(row, 'coupon_min_order_amount'));
    const start = count(field(row, 'coupon_start_time'));
    const end = count(field(row, 'coupon_end_time'));
    const remainRaw = field(row, 'coupon_remain_quantity');
    const remain = remainRaw === undefined ? undefined : count(remainRaw);
    if (
      threshold === undefined ||
      start === undefined ||
      end === undefined ||
      (remainRaw !== undefined && remain === undefined)
    ) {
      return { status: 'anomaly', reason: 'missing_field' };
    }
    const usable =
      threshold <= price &&
      start * 1000 <= nowMs &&
      nowMs < end * 1000 &&
      (remain === undefined || remain > 0);
    if (usable) coupon = discount;
  }
  if (coupon >= price) return { status: 'anomaly', reason: 'invalid_price' };
  const final = subFen(price, coupon);
  if (final <= 0n) return { status: 'anomaly', reason: 'invalid_price' };
  return { status: 'ok', price, coupon, final };
}

/**
 * 一行商品 → 统一 DTO。身份、标题、佣金比例不合格整行 invalid_dto；价格不合格出
 * price_status='anomaly'（金额置 0 占位，不显示；出不出卡由 catalog 决定）并回调 onAnomaly。
 */
export function mapPddGoods(
  input: unknown,
  source: PddGoodsSource,
  now: Date,
  onAnomaly: (reason: PriceAnomalyReason) => void,
): UnionItemDetail {
  const ref = pddGoodsRef(input);
  const row = input as Record<string, unknown>;
  const title = field(row, 'goods_name');
  if (typeof title !== 'string') throw invalid('goods_name must be a string');
  const commission = commissionBp(field(row, 'promotion_rate'));
  const description = source === 'detail' ? field(row, 'goods_desc') : undefined;
  // B1-04zzf：按录制（cap-tests/2026-10-15/pdd）已映射图片，搜索 / 推荐行与详情行同口径：
  // 主图取 goods_image_url，多图取 goods_gallery_urls，经 domain/item-images.ts 的 normalizeItemImages；
  // goods_thumbnail_url 不当主图，主图缺失时不从多图或缩略图补；报文里同名的 main_image_url / image_urls 不透传。
  const images = normalizeItemImages({
    main_image_url: field(row, 'goods_image_url'),
    image_urls: field(row, 'goods_gallery_urls'),
  });
  const base = {
    ...ref,
    title,
    commission_rate_bp: commission,
    quoted_at: now.toISOString(),
    ...(typeof description === 'string' ? { description } : {}),
    ...images,
  };
  const price = pddPrice(row, now.getTime());
  if (price.status === 'anomaly') {
    onAnomaly(price.reason);
    return Object.freeze({
      ...base,
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
      price_status: 'anomaly',
      price_anomaly_reason: price.reason,
    });
  }
  return Object.freeze({
    ...base,
    price_fen: price.price,
    coupon_fen: price.coupon,
    final_price_fen: price.final,
    price_status: 'ok',
  });
}
