// 淘宝商品详情映射（B1-04l，② 段）：taobao.tbk.item.info.upgrade.get 的请求参数、results 解包与
// TbkItemDetail → UnionItemDetail。字段按 10-06 物料搜索升级版形状（详情按同族假定）只读下列项，
// 从不 spread 整份报文：item_basic_info.{title, pict_url, small_images.string[],
// level_one_category_id, level_one_category_name}、price_promotion_info.{zk_final_price,
// final_promotion_price, final_promotion_path_list.final_promotion_path_map_data[]}、
// publish_info.income_info.commission_rate。white_image、reserve_price、income_rate、seller_id
// （超 JS 安全整数）都不读。元转分只用 @couli/domain 的 parseYuanToFen（BR-PRICE-01：超两位小数、
// 非数字、空串、负数一律按缺失，不截断；有限 number 先 String 再解析），价格经 mapTaobaoPrice。
// TODO(规划/09 CAP-TB-02): 外层键与 results 包装键待商品物料权限批下后复录核对 — blocked on 详情录制
import { parseYuanToFen } from '@couli/domain';
import { normalizeItemImages } from '../../domain/item-images.ts';
import {
  mapTaobaoPrice,
  type TaobaoPriceOptions,
  type TaobaoPromotion,
} from '../../domain/taobao-price.ts';
import { UnionError, type ItemRef, type UnionItemDetail } from '../../domain/types.ts';

export const TAOBAO_ITEM_DETAIL = 'taobao.tbk.item.info.upgrade.get';
/** 按同族已录外层键 tbk_*_response 登记（TODO 待详情录制核对）。 */
export const TAOBAO_ITEM_DETAIL_ENVELOPE = 'tbk_item_info_upgrade_get_response';
/** 本段固定 1（2 → 15/1911 scene 不支持，已录）。 */
export const TAOBAO_ITEM_DETAIL_SCENE = 1;
/** commission_rate 是万分比整数；100 % = 10000。 */
const MAX_COMMISSION_BP = 10_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): UnionError {
  return new UnionError('invalid_dto', `taobao getItem: ${message}`, 'taobao');
}

function unavailable(message: string): UnionError {
  return new UnionError(
    'upstream_unavailable',
    `taobao ${TAOBAO_ITEM_DETAIL}: ${message}`,
    'taobao',
  );
}

function itemUnavailable(): UnionError {
  return new UnionError('item_unavailable', `taobao ${TAOBAO_ITEM_DETAIL}: no result`, 'taobao');
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

/**
 * ItemRef → item_id 参数：上游商品 ID 原样，一次一个。不是淘宝商品、缺失 / 空白 / 含逗号
 * （接口按逗号分批）→ invalid_dto，不取凭据、不发请求。
 */
export function detailItemId(ref: ItemRef): string {
  if (!isRecord(ref) || ref.platform !== 'taobao') throw invalid('item is not a taobao item');
  const id = ref.item_id;
  if (typeof id !== 'string' || id.trim() === '') throw invalid('item_id is required');
  if (id.includes(',')) throw invalid('item_id must name exactly one item');
  return id;
}

/**
 * results 下的商品数组：非精简 JSON 每层数组外多一层单键包装，包装名未录到 → 取唯一键的数组，
 * 不写死包装名。results 缺失 / 空对象 / 空数组 → item_unavailable；results 不是对象、多个键、
 * 包装值不是数组 → upstream_unavailable。
 */
export function detailRows(inner: unknown): readonly unknown[] {
  if (!isRecord(inner)) throw unavailable('response envelope is not an object');
  const results = field(inner, 'results');
  if (results === undefined) throw itemUnavailable();
  if (!isRecord(results)) throw unavailable('results is not an object');
  const keys = Object.keys(results);
  if (keys.length === 0) throw itemUnavailable();
  if (keys.length !== 1) throw unavailable('results has more than one wrapper');
  const rows = results[keys[0]!];
  if (!Array.isArray(rows)) throw unavailable('results wrapper is not an array');
  if (rows.length === 0) throw itemUnavailable();
  return rows;
}

/**
 * 元串 → 分（parseYuanToFen）。有限 JSON number 先转为最短十进制字符串（String）再走同一解析
 * （BR-PRICE-01「金额解析」，D10-525；指数写法如 1e+21 自然判缺失）。不合格串、非有限数与
 * 其他非字符串都返回 undefined，交给 mapTaobaoPrice 判 missing_field。
 */
function yuanFen(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return parseYuanToFen(String(value)) ?? undefined;
  }
  if (typeof value !== 'string') return undefined;
  return parseYuanToFen(value) ?? undefined;
}

/**
 * 13 位毫秒串（或安全整数）→ 毫秒；缺失 → undefined（不限）；其余原样交给 mapTaobaoPrice
 * 判 missing_field（不当作不限）。
 */
function epochMs(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && /^[0-9]{1,16}$/.test(value)) {
    const ms = Number(value);
    return Number.isSafeInteger(ms) ? ms : value;
  }
  return value;
}

/** 优惠路径项 → TaobaoPromotion；title 非字符串由 mapTaobaoPrice 判 missing_field。 */
function promotionOf(entry: unknown): TaobaoPromotion {
  const row = isRecord(entry) ? entry : {};
  const id = field(row, 'promotion_id');
  const start = epochMs(field(row, 'promotion_start_time'));
  const end = epochMs(field(row, 'promotion_end_time'));
  return {
    title: field(row, 'promotion_title') as string,
    amount_fen: yuanFen(field(row, 'promotion_fee')),
    ...(typeof id === 'string' ? { id } : {}),
    ...(start === undefined ? {} : { start_ms: start }),
    ...(end === undefined ? {} : { end_ms: end }),
  };
}

/** 路径列表缺失 → 无明细；包装不是数组 → 原值交给 mapTaobaoPrice 判 missing_field。 */
function promotionsOf(price: Record<string, unknown>): readonly TaobaoPromotion[] {
  const list = field(price, 'final_promotion_path_list');
  if (list === undefined) return [];
  const entries = isRecord(list) ? field(list, 'final_promotion_path_map_data') : list;
  if (!Array.isArray(entries)) return entries as readonly TaobaoPromotion[];
  return entries.map(promotionOf);
}

/** 万分比整数串（或安全整数）→ bp，0..10000；其余 undefined。 */
function commissionBp(value: unknown): bigint | undefined {
  let bp: bigint | undefined;
  if (typeof value === 'string' && /^[0-9]{1,5}$/.test(value)) bp = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    bp = BigInt(value);
  }
  return bp === undefined || bp > MAX_COMMISSION_BP ? undefined : bp;
}

function rowTitle(row: Record<string, unknown>): string | undefined {
  const title = field(recordField(row, 'item_basic_info'), 'title');
  return typeof title === 'string' && title.trim() !== '' ? title : undefined;
}

function rowCommissionBp(row: Record<string, unknown>): bigint | undefined {
  const income = recordField(recordField(row, 'publish_info'), 'income_info');
  return commissionBp(field(income, 'commission_rate'));
}

/** 一级类目 ID：非负安全整数或十进制数字串 → 十进制串；其余不填。 */
function categoryId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^[0-9]{1,19}$/.test(value)) return value;
  return undefined;
}

/**
 * mapTaobaoDetail 会拒绝这一行的原因（同一判定，先标题后佣金）；合格 → null。官方搜索（B1-04zx）据此
 * 跳行，合格的行直接交 mapTaobaoDetail，不另写一份解析。
 */
export function detailRowFault(
  row: Record<string, unknown>,
): 'title_missing' | 'commission_invalid' | null {
  if (rowTitle(row) === undefined) return 'title_missing';
  return rowCommissionBp(row) === undefined ? 'commission_invalid' : null;
}

/**
 * 一条 TbkItemDetail → UnionItemDetail。身份取请求的 ItemRef（item_id 原样）；标题缺失、佣金比例
 * 不合格 → upstream_unavailable；价格不合格经 mapTaobaoPrice 出 price_status='anomaly'（三价 0）。
 */
export function mapTaobaoDetail(
  input: unknown,
  itemId: string,
  now: Date,
  priceOptions: TaobaoPriceOptions | undefined,
): UnionItemDetail {
  if (!isRecord(input)) throw unavailable('result is not an object');
  const basic = recordField(input, 'item_basic_info');
  const price = recordField(input, 'price_promotion_info');
  const title = rowTitle(input);
  if (title === undefined) throw unavailable('title is missing');
  const commission = rowCommissionBp(input);
  if (commission === undefined) {
    throw unavailable('commission_rate must be an integer per-ten-thousand within 0..10000');
  }
  const small = field(basic, 'small_images');
  const images = normalizeItemImages({
    main_image_url: field(basic, 'pict_url'),
    image_urls: isRecord(small) ? field(small, 'string') : undefined,
  });
  const category = categoryId(field(basic, 'level_one_category_id'));
  const categoryName = field(basic, 'level_one_category_name');
  const result = mapTaobaoPrice(
    {
      discount_fen: yuanFen(field(price, 'zk_final_price')),
      promotion_final_fen: yuanFen(field(price, 'final_promotion_price')),
      promotions: promotionsOf(price),
    },
    now.getTime(),
    priceOptions,
  );
  return Object.freeze({
    platform: 'taobao',
    item_id: itemId,
    title,
    price_fen: result.price_fen,
    coupon_fen: result.coupon_fen,
    final_price_fen: result.final_price_fen,
    commission_rate_bp: commission,
    quoted_at: now.toISOString(),
    ...(result.coupon_ids === undefined ? {} : { coupon_ids: result.coupon_ids }),
    price_status: result.price_status,
    ...(result.price_anomaly_reason === undefined
      ? {}
      : { price_anomaly_reason: result.price_anomaly_reason }),
    ...(category === undefined ? {} : { category_l1_id: category }),
    ...(typeof categoryName === 'string' && categoryName.trim() !== ''
      ? { category_l1_name: categoryName }
      : {}),
    ...images,
  });
}
