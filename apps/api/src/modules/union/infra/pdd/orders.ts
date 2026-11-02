// 拼多多订单接口的请求参数、时间窗、游标与 DTO 映射（09 4_PDD CAP-PDD-04/07/08，4_PDD_附 §6、§7A）。
// 映射只用任务书附的 probe 字段清单，按接口分别登记（下面三张 *_FIELDS 表）：某接口 probe 未见的字段
// 即使出现在报文里也不读、不校验、不进 DTO；从不 spread 整份报文。金额 / 费率 / 时间都是 JSON 整数，
// 非安全整数或非整数一律 invalid_dto（不舍入）；金额经 @couli/money 的 parseFen。
// 状态映射（specs/order-status-map/pdd.csv）、可分配基数扣减、时间窗拆分都不在这里。
import { InvalidAmount, parseFen, subFen } from '@couli/money';
import { makeUnionOrder } from '../../domain/dto.ts';
import {
  UnionError,
  type TimeWindow,
  type UnionOrder,
  type UnionOrderNeutralFields,
} from '../../domain/types.ts';
import type { OrderRowIdentity } from '../order-row.ts';

export const PDD_ORDER_INCREMENT = 'pdd.ddk.order.list.increment.get';
export const PDD_ORDER_RANGE = 'pdd.ddk.order.list.range.get';
export const PDD_ORDER_DETAIL = 'pdd.ddk.order.detail.get';

/** increment 每页条数：文档建议 40–50，取 50。 */
export const PDD_INCREMENT_PAGE_SIZE = 50;
/** increment 的 page 取值范围 1..10000（文档）。 */
export const PDD_INCREMENT_MAX_PAGE = 10_000;

const SECONDS_PER_DAY = 86_400;
/** increment：更新时间窗不超过 24 小时，起点不早于注入时钟的 90 天前（文档）。 */
const INCREMENT_MAX_SPAN_SECONDS = SECONDS_PER_DAY;
const INCREMENT_MAX_AGE_SECONDS = 90 * SECONDS_PER_DAY;
/** range 的 start_time / end_time 是北京时间（UTC+8，无夏令时）。 */
const BEIJING_OFFSET_SECONDS = 8 * 3_600;
/**
 * goods_id 的上限 2^53（含，AC-B1-04i-DTO#12）。B1-04w：比较的是上游原始 JSON 文本（见
 * parsePddOrderEnvelope），2^53+1 不会再被 JSON.parse 舍成 2^53 而混过去。
 */
const MAX_GOODS_ID = 2n ** 53n;
/** 无损商品号只接受十进制非负整数字面量：无符号、无小数点、无指数、无前导零。 */
const GOODS_ID_TEXT = /^(?:0|[1-9][0-9]*)$/;
/** B1-08p：店铺 ID 只接受十进制正整数字面量（无符号、无小数点、无指数、无前导零），且 ≤ 2^53 − 1。 */
const SHOP_ID_TEXT = /^[1-9][0-9]*$/;
const MAX_SHOP_ID = BigInt(Number.MAX_SAFE_INTEGER);
/** parsePddOrderEnvelope 按原始文本保留的数值字段（B1-04w goods_id；B1-08p mall_id）。 */
const RAW_INTEGER_FIELDS: ReadonlySet<string> = new Set(['goods_id', 'mall_id']);

export type PddOrderSource = 'increment' | 'range' | 'detail';

/** 各接口 probe 见到、且本任务映射的字段（任务书 probe 字段清单的子集，另加两处任务书明示的例外）。 */
const COMMON_FIELDS = [
  'order_sn',
  'goods_id',
  'goods_sign',
  'custom_parameters',
  'goods_price',
  'order_amount',
  'promotion_amount',
  'duo_id_service_fee',
  'promotion_rate',
  'sep_rate',
  'platform_discount',
  'sep_market_fee',
  'order_status',
  'order_status_desc',
  'order_create_time',
  'order_pay_time',
  'order_group_success_time',
  'order_modify_at',
  'subsidy_duo_amount_level',
  // probe 未见、任务书明示按可选透传（4_PDD_附 §7A）；与详情的 return_status 同为显式例外。
  'subsidy_duo_amount_ten_million',
  'subsidy_type',
  'subsidy_list',
  // B1-08p：店铺 ID（LONG）。出处：三个订单接口的文档（docs-mirror/pdd/api/<接口名>.md）都列有 mall_id；
  // 只读这个 ID，不以 mall_name 等名称代替。映射见 shopId()。
  'mall_id',
] as const;
const FIELDS: Readonly<Record<PddOrderSource, ReadonlySet<string>>> = {
  increment: new Set([
    ...COMMON_FIELDS,
    'order_id',
    'p_id',
    'fail_reason',
    'order_receive_time',
    'order_verify_time',
    'order_settle_time',
  ]),
  range: new Set([...COMMON_FIELDS, 'p_id', 'fail_reason', 'order_settle_time']),
  detail: new Set([...COMMON_FIELDS, 'pid', 'url_last_generate_time', 'return_status']),
};

function invalid(message: string): UnionError {
  return new UnionError('invalid_dto', `pdd order: ${message}`, 'pdd');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 毫秒原值的时间窗；from < to 按毫秒判（同秒内逆序或相等不能靠向外取整变合法）。 */
function windowMillis(win: TimeWindow): { readonly fromMs: number; readonly toMs: number } {
  const fromMs = typeof win?.from === 'string' ? Date.parse(win.from) : Number.NaN;
  const toMs = typeof win?.to === 'string' ? Date.parse(win.to) : Number.NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw invalid('time window must be two ISO-8601 instants');
  }
  if (fromMs >= toMs) throw invalid('time window must have from < to');
  return { fromMs, toMs };
}

/** 秒级 UTC 边界：先按毫秒校验，再 from 向下取整、to 向上取整（向外，不漏边界上的订单）。 */
function windowSeconds(win: TimeWindow): { readonly start: number; readonly end: number } {
  const { fromMs, toMs } = windowMillis(win);
  return { start: Math.floor(fromMs / 1000), end: Math.ceil(toMs / 1000) };
}

/**
 * increment 的更新时间窗：跨度 ≤ 24 小时、起点不早于 now − 90 天、from < to，都按毫秒原值判；
 * 拆分窗口是 order-sync 的事。合法窗口再转成上游的秒：from 向下、to 向上取整；取整若越过限制，
 * 只把越界的那一秒收回（起点收到 90 天界内的第一个整秒，终点收到起点 + 24 小时），不发 86401 秒跨度。
 */
export function incrementWindow(
  win: TimeWindow,
  nowMs: number,
): { readonly start_update_time: number; readonly end_update_time: number } {
  const { fromMs, toMs } = windowMillis(win);
  const oldestMs = nowMs - INCREMENT_MAX_AGE_SECONDS * 1000;
  if (toMs - fromMs > INCREMENT_MAX_SPAN_SECONDS * 1000) {
    throw invalid('increment window exceeds 24 hours');
  }
  if (fromMs < oldestMs) throw invalid('increment window starts more than 90 days ago');
  // fromMs ≥ oldestMs，所以收回后的起点仍 ≤ ceil(from)；toMs − fromMs ≤ 24h，所以 start + 24h ≥ floor(to)。
  const start = Math.max(Math.floor(fromMs / 1000), Math.ceil(oldestMs / 1000));
  let end = Math.min(Math.ceil(toMs / 1000), start + INCREMENT_MAX_SPAN_SECONDS);
  // 整个窗口落在 90 天界所在的那一秒里时，起点被收回后可能追上终点：终点外扩一秒，宁多不漏。
  if (end <= start) end = start + 1;
  return { start_update_time: start, end_update_time: end };
}

/** range 的支付时间窗，转成北京时间 "yyyy-MM-dd HH:mm:ss"。 */
export function rangeWindow(win: TimeWindow): {
  readonly start_time: string;
  readonly end_time: string;
} {
  const { start, end } = windowSeconds(win);
  return { start_time: beijingText(start), end_time: beijingText(end) };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Unix 秒 → 北京时间文本；纯整数换算（civil-from-days），不读时钟、不经 Date 对象。 */
function beijingText(unixSeconds: number): string {
  const local = unixSeconds + BEIJING_OFFSET_SECONDS;
  const days = Math.floor(local / SECONDS_PER_DAY);
  const secondOfDay = local - days * SECONDS_PER_DAY;
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const hour = Math.floor(secondOfDay / 3_600);
  const minute = Math.floor((secondOfDay % 3_600) / 60);
  const second = secondOfDay % 60;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/*
 * 游标编码（不透明，调用方原样回传）：
 * - increment：`inc:<page>`，指下一次要取的页码。首次调用（无游标）先探出最后一个非空页并返回它，
 *   游标指向前一页；之后逐页往回取到第 1 页，nextCursor=null（倒序翻页，文档要求，避免漏单）。
 * - pay_time：`range:<last_order_id>`，原样回传上游迭代器。
 * 与查询方式不符或格式不对的游标报 invalid_dto。
 */
export function incrementCursor(page: number): string {
  return `inc:${page}`;
}

export function parseIncrementCursor(cursor: string): number {
  const match = /^inc:([1-9][0-9]{0,4})$/.exec(cursor);
  const page = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(page) || page < 1 || page > PDD_INCREMENT_MAX_PAGE) {
    throw invalid('cursor does not belong to an increment query');
  }
  return page;
}

export function rangeCursor(lastOrderId: string): string {
  return `range:${lastOrderId}`;
}

export function parseRangeCursor(cursor: string): string {
  if (!cursor.startsWith('range:') || cursor.length === 'range:'.length) {
    throw invalid('cursor does not belong to a pay_time query');
  }
  return cursor.slice('range:'.length);
}

/** 列表接口外层的 order_list；不是数组即报错，不当作空页。 */
export function orderList(envelope: unknown): readonly unknown[] {
  if (!isRecord(envelope) || !Array.isArray(envelope.order_list)) {
    throw invalid('order_list_get_response.order_list is not an array');
  }
  return envelope.order_list;
}

/** range 的迭代器；缺失、空串或非字符串都当作没有下一批。 */
export function lastOrderId(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  const value = envelope.last_order_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

class Fields {
  readonly #row: Record<string, unknown>;
  readonly #allowed: ReadonlySet<string>;

  constructor(row: Record<string, unknown>, source: PddOrderSource) {
    this.#row = row;
    this.#allowed = FIELDS[source];
  }

  /** 只读本接口登记过的字段；缺失与 JSON null 都是 undefined。 */
  raw(name: string): unknown {
    if (!this.#allowed.has(name)) return undefined;
    const value = this.#row[name];
    return value === null ? undefined : value;
  }

  text(name: string): string | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    if (typeof value !== 'string') throw invalid(`${name} must be a string`);
    return value;
  }

  integer(name: string): number | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw invalid(`${name} must be a safe integer`);
    }
    return value;
  }

  /** 秒级时间戳，保留整数。 */
  seconds(name: string): number | null {
    const value = this.integer(name);
    if (value !== null && value < 0) throw invalid(`${name} must be a non-negative timestamp`);
    return value;
  }

  /** 非负整数分 → bigint，经 @couli/money parseFen（只接受安全整数）。 */
  fen(name: string): bigint | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    return nonNegativeFen(value, name);
  }

  /** 非负整数（千分比费率、补贴档位）→ bigint；不是金额运算，只做类型转换。 */
  count(name: string): bigint | null {
    const value = this.integer(name);
    if (value === null) return null;
    if (value < 0) throw invalid(`${name} must be non-negative`);
    return BigInt(value);
  }
}

function nonNegativeFen(value: unknown, name: string): bigint {
  if (typeof value !== 'number' || Object.is(value, -0)) {
    throw invalid(`${name} must be a non-negative integer amount in fen`);
  }
  let fen: bigint;
  try {
    fen = parseFen(value);
  } catch (error) {
    if (error instanceof InvalidAmount) {
      throw invalid(`${name} must be a non-negative integer amount in fen`);
    }
    throw error;
  }
  if (fen < 0n) throw invalid(`${name} must be a non-negative integer amount in fen`);
  return fen;
}

/** 订单报文里数值型 goods_id / mall_id 的原始 JSON 文本（B1-04w、B1-08p；只由 parsePddOrderEnvelope 产生）。 */
export class PddRawInteger {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** JSON.parse 的源文本访问（Node ≥ 21；本仓库 engines 为 Node 24）。 */
interface ReviverContext {
  readonly source?: string;
}

/**
 * B1-04w：订单接口专用的二次解析。与 JSON.parse 相同，只是名为 goods_id（B1-08p 起另加 mall_id）的
 * 数值换成它的原始文本（PddRawInteger），从而能无损区分 2^53 与 2^53+1。字段名按 JSON 解码后比较
 * （转义写法同样命中）；嵌套对象里的同名数值也会被换掉，但映射只读订单本层登记过的字段，不读它们。
 * 网关错误、外层键缺失仍由 unwrapPddResponse 先判；全局解包（request）不受影响。
 */
export function parsePddOrderEnvelope(body: string, key: string): unknown {
  const parsed: unknown = JSON.parse(
    body,
    (name: string, value: unknown, context?: ReviverContext): unknown =>
      RAW_INTEGER_FIELDS.has(name) && typeof value === 'number'
        ? new PddRawInteger(typeof context?.source === 'string' ? context.source : '')
        : value,
  );
  if (!isRecord(parsed) || !Object.hasOwn(parsed, key)) {
    throw new UnionError('upstream_unavailable', `pdd order: missing ${key} in response`, 'pdd');
  }
  return parsed[key];
}

/**
 * 商品号 → 十进制字符串；不经浮点运算。适配器给的是原始文本（PddRawInteger），按 bigint 比较
 * 上限 2^53（含）；直接调用 mapPddOrder 传入的普通数值只接受安全整数（无法判断是否已被舍入）。
 */
function goodsId(value: unknown): string | null {
  if (value === undefined) return null;
  if (value instanceof PddRawInteger) {
    if (!GOODS_ID_TEXT.test(value.text) || BigInt(value.text) > MAX_GOODS_ID) {
      throw invalid('goods_id must be a non-negative integer within 2^53');
    }
    return value.text;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('goods_id must be a non-negative integer within 2^53');
  }
  return String(value);
}

/**
 * B1-08p：店铺 ID（mall_id）→ 十进制字符串，不经浮点运算；只是来源回填（BR-ATTR-15 ③）的辅助，
 * 所以缺失或不合格一律 null（不抛错、不丢单——与 goods_id 非法即拒不同）：
 * - 适配器给的原始文本（PddRawInteger）：须是十进制正整数字面量且 ≤ 2^53 − 1，原样返回；
 * - 直接调用传入的普通数值：只接受正的安全整数（更大的值无法判断是否已被舍入）；
 * - 字符串：同原始文本的口径（空串即空）；
 * - 其余（0、负数、小数、超界、其他类型）→ null。
 */
function shopId(value: unknown): string | null {
  if (value instanceof PddRawInteger || typeof value === 'string') {
    const text = value instanceof PddRawInteger ? value.text : value;
    return SHOP_ID_TEXT.test(text) && BigInt(text) <= MAX_SHOP_ID ? text : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/**
 * probe 只见过空数组，成员结构未经确认：成员一律不进 DTO（也不读），只保留长度（占位 null）。
 */
function subsidyList(value: unknown): readonly null[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw invalid('subsidy_list must be an array');
  return Object.freeze(Array.from({ length: value.length }, () => null));
}

/**
 * B1-08e：一页订单报文的元数据。rawPayloadId 是这页响应在 union_raw_payloads 的行 id（归档传输
 * 回传，没有为 null）；like 是注入时钟给出的任一时刻，只作构造 Date 的模板，取值不进 DTO。
 */
export interface PddOrderPage {
  readonly rawPayloadId: string | null;
  readonly like: Date;
}

/** B1-04zv：被拒的行还能读出的单号与状态码；读不出就是 null，这里不抛错。 */
export function pddRowIdentity(input: unknown): OrderRowIdentity {
  if (!isRecord(input)) return { sub_order_id: null, raw_status: null };
  const { order_sn: orderSn, order_status: orderStatus } = input;
  return {
    sub_order_id: typeof orderSn === 'string' && orderSn.trim() !== '' ? orderSn : null,
    raw_status:
      typeof orderStatus === 'number' && Number.isSafeInteger(orderStatus)
        ? String(orderStatus)
        : null,
  };
}

/**
 * 一条拼多多订单 → UnionOrder。order_id 取 order_sn；platform_order_id 取列表的 order_id（只有
 * increment 的 probe 见到，其余为 null）；推广位：列表 p_id、详情 pid 统一到 pid。
 * commission_fen = promotion_amount（毛额，含软件服务费，不入库），service_fee_fen = duo_id_service_fee。
 * est_commission_fen = 净额 = promotion_amount − duo_id_service_fee（B1-08zh，BR-CALC-03：扣除只在这一处，
 * 下游不再减，可为负）；服务费缺失时 est 为 null，绝不按 0。字段含义见 docs-mirror/pdd/api/
 * pdd.ddk.order.list.increment.get.md。duo_id_service_fee 含基础加奖励佣金的费、这里只从基础佣金扣，
 * 有等级奖励时 N 偏小（负责人 2026-10-02 定的公式，偏保守），待 CAP-PDD-04 实测。
 * subsidy_* 单列透传，不并入任何金额。return_status 只读详情接口。
 * B1-08e：另填平台无关字段（sub_order_id = order_sn，promotion_slot = pid，attr_params 只填原样的
 * custom_parameters，raw_status = String(order_status)，五个时刻由秒转 Date，
 * settle = null）；raw_payload_id 由调用方给出该页报文的归档行 id，没有为 null。
 * B1-08p：shop_id = mall_id 的十进制字符串（缺失或不合格为 null，见 shopId）。
 */
export function mapPddOrder(
  input: unknown,
  source: PddOrderSource,
  page: PddOrderPage,
): UnionOrder & UnionOrderNeutralFields & { readonly shop_id: string | null } {
  if (!isRecord(input)) throw invalid('order row is not an object');
  const f = new Fields(input, source);
  const orderSn = f.raw('order_sn');
  if (typeof orderSn !== 'string' || orderSn.trim() === '') {
    throw invalid('order_sn must be a non-empty string');
  }
  const orderAmount = f.raw('order_amount');
  const promotionAmount = f.raw('promotion_amount');
  if (orderAmount === undefined) throw invalid('order_amount is missing');
  if (promotionAmount === undefined) throw invalid('promotion_amount is missing');
  const base = makeUnionOrder({
    platform: 'pdd',
    order_id: orderSn,
    goods_id: goodsId(f.raw('goods_id')),
    goods_sign: f.text('goods_sign'),
    paid_fen: nonNegativeFen(orderAmount, 'order_amount'),
    commission_fen: nonNegativeFen(promotionAmount, 'promotion_amount'),
  });
  const pid = source === 'detail' ? f.text('pid') : f.text('p_id');
  const customParameters = f.text('custom_parameters');
  const orderStatus = f.integer('order_status');
  const payTime = f.seconds('order_pay_time');
  const receiveTime = f.seconds('order_receive_time');
  const settleTime = f.seconds('order_settle_time');
  const modifyAt = f.seconds('order_modify_at');
  const serviceFeeFen = f.fen('duo_id_service_fee');
  return Object.freeze({
    ...base,
    platform_order_id: f.text('order_id'),
    pid,
    custom_parameters: customParameters,
    order_status: orderStatus,
    order_status_desc: f.text('order_status_desc'),
    fail_reason: f.text('fail_reason'),
    return_status: f.integer('return_status'),
    service_fee_fen: serviceFeeFen,
    goods_price_fen: f.fen('goods_price'),
    platform_discount_fen: f.fen('platform_discount'),
    sep_market_fee_fen: f.fen('sep_market_fee'),
    promotion_rate: f.count('promotion_rate'),
    sep_rate: f.count('sep_rate'),
    order_create_time: f.seconds('order_create_time'),
    order_pay_time: payTime,
    order_group_success_time: f.seconds('order_group_success_time'),
    order_receive_time: receiveTime,
    order_verify_time: f.seconds('order_verify_time'),
    order_settle_time: settleTime,
    order_modify_at: modifyAt,
    url_last_generate_time: f.seconds('url_last_generate_time'),
    subsidy_duo_amount_level: f.count('subsidy_duo_amount_level'),
    subsidy_duo_amount_ten_million: f.count('subsidy_duo_amount_ten_million'),
    subsidy_type: f.integer('subsidy_type'),
    subsidy_list: subsidyList(f.raw('subsidy_list')),
    // B1-08e（D10-20）：平台无关字段。
    sub_order_id: orderSn,
    parent_order_id: null,
    promotion_slot: pid,
    attr_params: Object.freeze({
      relation_id: null,
      custom_parameters: customParameters,
      sub_union_id: null,
    }),
    raw_status: orderStatus === null ? null : String(orderStatus),
    deposit_paid_at: null,
    paid_at: instant(payTime, page.like),
    received_at: instant(receiveTime, page.like),
    settled_at: instant(settleTime, page.like),
    modified_at: instant(modifyAt, page.like),
    est_commission_fen: serviceFeeFen === null ? null : subFen(base.commission_fen, serviceFeeFen),
    // TODO(规划/11 §4.5): 拼多多结算佣金 — blocked on CAP-PDD-07（现有映射没有单独字段，不臆造）
    settle_commission_fen: null,
    raw_payload_id: page.rawPayloadId,
    // B1-08p：拼多多订单总带店铺键（缺失 / 不合格为 null）；淘宝、京东映射不加此键（见 UnionOrder.shop_id）。
    shop_id: shopId(f.raw('mall_id')),
  });
}

/**
 * 秒级时间戳 → Date；0 或缺失为 null（拼多多以 0 表示尚未发生）。Date 从注入时钟的一个时刻复制后
 * setTime 得到，不读系统时钟（apps/api 不写 new Date）。
 */
function instant(seconds: number | null, like: Date): Date | null {
  if (seconds === null || seconds === 0) return null;
  const result = structuredClone(like);
  result.setTime(seconds * 1000);
  return result;
}
