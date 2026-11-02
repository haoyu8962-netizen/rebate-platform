// 京东订单接口（jd.union.open.order.row.query，B1-04zb）的时间窗、游标、翻页判定与 DTO 映射。
// 规则测试：test/spec/union/jd-orders/**、jd-orders-settle/**；映射口径见 specs/union/jd.md
// （D10-520、D10-522、D10-529）。
// 只读下面映射到的字段，从不 spread 整份报文；订单号与金额都取内层数字的原文（JdRawNumber），
// 不经 JS number。错误信息只带字段名，不带报文内容。
// 不做：按推广位过滤、拆时间窗（归 order-sync）；状态映射（归 B1-04zg）；图片。
import { InvalidAmount, yuanStrToFen } from '@couli/money';
import { makeUnionOrder } from '../../domain/dto.ts';
import {
  UnionError,
  type TimeWindow,
  type UnionOrder,
  type UnionOrderNeutralFields,
} from '../../domain/types.ts';
import { JdRawNumber, type JdInner, type JdResponseKeys } from './response.ts';
import { jdTimestamp } from './sign.ts';

export const JD_ORDER_ROW_QUERY = 'jd.union.open.order.row.query';
/** 外层键的 `_responce` 是网关自己的拼写。 */
export const JD_ORDER_KEYS: JdResponseKeys = {
  envelope: 'jd_union_open_order_row_query_responce',
  resultKey: 'queryResult',
};
export const JD_ORDER_PAGE_SIZE = 200;
/** orderReq.type：3 = 按更新时间。 */
export const JD_ORDER_QUERY_BY_UPDATE_TIME = 3;
/** 窗口内订单量超接口上限（规划/02 §7.1）。缩窗归 order-sync，这里只带 windowTooLarge。 */
export const JD_ORDER_WINDOW_TOO_LARGE_CODES: ReadonlySet<string> = new Set(['2002452']);

/** 单窗不超过 1 小时，起点不早于注入时钟的 90 天前。 */
const MAX_SPAN_SECONDS = 3_600;
const MAX_AGE_MS = 90 * 86_400_000;

/** 只有已完成单有实际佣金与实际计佣金额（D10-529）；它不是已结算，官方 validCode 没有已结算码。 */
const FINISHED_CODE = '17';
const AWAITING_PAYMENT_CODE = '15';
const DEPOSIT_PAID_CODE = '24';

const DECIMAL_ID = /^[0-9]+$/;
const VALID_CODE = /^-?[0-9]+$/;
const WIRE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;

/** BR-PROD-03 / 05：订单的商品键取 itemId 全串还是 skuId。 */
export type JdProductKeyMode = 'sku' | 'item';

/** 一页订单报文的元数据；rawPayloadId 是该页归档行 id，like 只作构造 Date 的模板（同 PddOrderPage）。 */
export interface JdOrderPage {
  readonly rawPayloadId: string | null;
  readonly like: Date;
  readonly productKeyMode: JdProductKeyMode;
}

function invalid(message: string): UnionError {
  return new UnionError('invalid_dto', `jd order: ${message}`, 'jd');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Date 从注入时钟的时刻复制后 setTime 得到，不读系统时钟（apps/api 不写 new Date）。 */
function instant(ms: number, like: Date): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

/**
 * 校验并转成上游的秒级 GMT+8 文本。from < to、跨度 ≤ 1 小时、from ≥ now − 90 天都按毫秒原值判，
 * 拆窗是 order-sync 的事。合法窗口再向外取整（from 向下、to 向上）；取整若越过限制，只把越界的
 * 那一秒收回，不因取整拒绝合法窗口。
 */
export function jdOrderWindow(
  win: TimeWindow,
  now: Date,
): { readonly startTime: string; readonly endTime: string } {
  const fromMs = typeof win?.from === 'string' ? Date.parse(win.from) : Number.NaN;
  const toMs = typeof win?.to === 'string' ? Date.parse(win.to) : Number.NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw invalid('time window must be two ISO-8601 instants');
  }
  if (fromMs >= toMs) throw invalid('time window must have from < to');
  if (toMs - fromMs > MAX_SPAN_SECONDS * 1000) throw invalid('time window exceeds 1 hour');
  const oldestMs = now.getTime() - MAX_AGE_MS;
  if (fromMs < oldestMs) throw invalid('time window starts more than 90 days ago');
  const start = Math.max(Math.floor(fromMs / 1000), Math.ceil(oldestMs / 1000));
  let end = Math.min(Math.ceil(toMs / 1000), start + MAX_SPAN_SECONDS);
  // 整窗落在 90 天界那一秒里时，起点收回后可能追上终点：终点外扩一秒，宁多不漏。
  if (end <= start) end = start + 1;
  return {
    startTime: jdTimestamp(instant(start * 1000, now)),
    endTime: jdTimestamp(instant(end * 1000, now)),
  };
}

/** 游标 `jd-order:<页码>` 指下一次要取的页，不透明，调用方原样回传；第 1 页没有游标。 */
export function jdOrderCursor(pageIndex: number): string {
  return `jd-order:${pageIndex}`;
}

export function parseJdOrderCursor(cursor: string): number {
  const match = /^jd-order:([1-9][0-9]{0,8})$/.exec(cursor);
  const pageIndex = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(pageIndex) || pageIndex < 2) {
    throw invalid('cursor does not belong to an order query');
  }
  return pageIndex;
}

/**
 * 一页内层结果的行与 hasMore。实测（D10-524）：hasMore 的含义是「本页已满」，不是「后面还有」，
 * 行数恰为页大小整数倍的窗口，末页满页时 hasMore 仍为 true，下一页只有 code / message / requestId。
 * 所以任何一页 data 与 hasMore 都缺都是翻完了，返回空页（无单的时间窗也是这个形状）。其余形状都
 * 报错：data 必须是数组、hasMore 必须是布尔，hasMore 为 true 时 data 不能为空。
 */
export function jdOrderRows(inner: JdInner): {
  readonly rows: readonly unknown[];
  readonly hasMore: boolean;
} {
  if (!Object.hasOwn(inner, 'data') && !Object.hasOwn(inner, 'hasMore')) {
    return { rows: [], hasMore: false };
  }
  const { data, hasMore } = inner;
  if (!Array.isArray(data)) throw invalid('data is not an array');
  if (typeof hasMore !== 'boolean') throw invalid('hasMore is not a boolean');
  if (hasMore && data.length === 0) throw invalid('hasMore is true on an empty page');
  return { rows: data, hasMore };
}

export function checkJdProductKeyMode(value: unknown): JdProductKeyMode {
  if (value === 'sku' || value === 'item') return value;
  throw invalid('product key mode must be sku or item');
}

/** 数字的原文或字符串本身；其余类型 undefined。 */
export function scalarText(value: unknown): string | undefined {
  if (value instanceof JdRawNumber) return value.text;
  return typeof value === 'string' ? value : undefined;
}

function requiredId(row: Record<string, unknown>, name: string): string {
  const text = scalarText(row[name]);
  if (text === undefined || !DECIMAL_ID.test(text)) throw invalid(`${name} must be a decimal id`);
  return text;
}

/** 缺键与 JSON null 是 null；有值就按 requiredId 校验。 */
function optionalId(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  return value === undefined || value === null ? null : requiredId(row, name);
}

/** 缺键、JSON null、空串都是 null。 */
function optionalText(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  return value;
}

function validCodeOf(row: Record<string, unknown>): string {
  const text = scalarText(row.validCode);
  if (text === undefined || !VALID_CODE.test(text)) throw invalid('validCode must be an integer');
  return text;
}

/** 元 → 分（BR-CALC-26），只认报文数字的原文；非数字、缺字段报错，不按 0 处理。 */
function yuanField(row: Record<string, unknown>, name: string): bigint {
  const value = row[name];
  if (!(value instanceof JdRawNumber)) throw invalid(`${name} must be a number`);
  try {
    return yuanStrToFen(value.text);
  } catch (error) {
    if (error instanceof InvalidAmount) throw invalid(`${name} is not an amount`);
    throw error;
  }
}

/** D10-522：commission_fen、paid_fen 必填非负，负值收到 0；真实负值留在 est 与归档报文。 */
function atLeastZero(fen: bigint): bigint {
  return fen < 0n ? 0n : fen;
}

/** `yyyy-MM-dd HH:mm:ss`（GMT+8）→ 时刻，与进程时区无关。 */
function wireTime(value: unknown, name: string, like: Date): Date {
  const ms =
    typeof value === 'string' && WIRE_TIME.test(value)
      ? Date.parse(`${value.replace(' ', 'T')}+08:00`)
      : Number.NaN;
  if (!Number.isFinite(ms)) throw invalid(`${name} is not a time`);
  const result = instant(ms, like);
  // Date.parse 会把 02-30 这样的日期滚到下月：转回文本不等于原文就不是合法时间。
  if (jdTimestamp(result) !== value) throw invalid(`${name} is not a time`);
  return result;
}

/** 下单时刻近似付款时刻（文档列的 orderPayTime 实际不出现），定金单与待付款单单列（D10-520）。 */
function paymentTimes(
  row: Record<string, unknown>,
  validCode: string,
  like: Date,
): { readonly deposit_paid_at: Date | null; readonly paid_at: Date | null } {
  if (validCode === AWAITING_PAYMENT_CODE) return { deposit_paid_at: null, paid_at: null };
  const orderTime = wireTime(row.orderTime, 'orderTime', like);
  return validCode === DEPOSIT_PAID_CODE
    ? { deposit_paid_at: orderTime, paid_at: null }
    : { deposit_paid_at: null, paid_at: orderTime };
}

/**
 * 一条订单行（内层数字都是 JdRawNumber）→ UnionOrder。validCode 只用于选金额字段与付款时点，
 * 不判订单状态、不丢弃无效单。actualFee、actualCosPrice 只在 17 读，estimateFee、estimateCosPrice
 * 只在其余状态读：没读的字段缺失或不合格都不影响该行。
 */
export function mapJdOrder(
  input: unknown,
  page: JdOrderPage,
): UnionOrder & UnionOrderNeutralFields {
  if (!isRecord(input)) throw invalid('order row is not an object');
  const validCode = validCodeOf(input);
  const finished = validCode === FINISHED_CODE;
  // 未完成单的 actualFee 是 0.0，取它就把预估佣金冲成 0：只有 17 取实际值。
  const estimated = yuanField(input, finished ? 'actualFee' : 'estimateFee');
  const base = makeUnionOrder({
    platform: 'jd',
    order_id: requiredId(input, 'orderId'),
    item_id:
      page.productKeyMode === 'sku' ? optionalId(input, 'skuId') : optionalText(input, 'itemId'),
    paid_fen: atLeastZero(yuanField(input, finished ? 'actualCosPrice' : 'estimateCosPrice')),
    commission_fen: atLeastZero(estimated),
  });
  const parentId = optionalId(input, 'parentId');
  const finishTime = optionalText(input, 'finishTime');
  return Object.freeze({
    ...base,
    sub_order_id: requiredId(input, 'id'),
    parent_order_id: parentId === '0' ? null : parentId,
    promotion_slot: optionalId(input, 'positionId'),
    attr_params: Object.freeze({
      relation_id: null,
      custom_parameters: null,
      sub_union_id: optionalText(input, 'subUnionId'),
    }),
    raw_status: validCode,
    ...paymentTimes(input, validCode, page.like),
    received_at: finishTime === null ? null : wireTime(finishTime, 'finishTime', page.like),
    // payMonth 只是预估结算月，不读。
    settled_at: null,
    modified_at: wireTime(input.modifyTime, 'modifyTime', page.like),
    est_commission_fen: estimated,
    // BR-FUND-02：只有平台明确已结算才写，京东官方 validCode 没有已结算码，所以恒不写；
    // 结算额只由联盟结算明细导入写 order_settlements（source=STATEMENT）。
    settle_commission_fen: null,
    raw_payload_id: page.rawPayloadId,
  });
}
