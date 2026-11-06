// 淘宝维权（B1-04z，D10-486 ③ / D10-488 ② / D10-491）：经大淘客 GET /api/tb-service/get-order-refund
// （version v1.0.0；文档写 POST，实测 POST → HTTP 439，按 GET）取维权明细，映射到 UnionRefund。
// - 请求：queryType 由 RefundQueryOpt.timeBasis 定（refund_created 1 / settle 2 / refund_finished 3 /
//   create 4 / update 5 默认）；create / update 的起点早于北京时间 2022-12-20 00:00:00 → invalid_dto；
//   startTime / endTime 北京时间「YYYY-MM-DD HH:MM:SS」（同 orders.ts 换算），窗口 > 3 小时按 3 小时
//   顺序切窗；每窗首页不带 positionIndex，续页带上一页的 position_index；pageSize 100、memberType 4、
//   orderScene 1；pageNo 是该窗内的页序（首页 1，续页逐页 +1，与录制请求一致）。一次 listRefunds 取一个上游页（listRefundsMetering = per_request，经
//   ctx.gateUpstream），nextCursor 是不透明串（与订单游标互不通用）。has_next 为 true 而 position_index
//   缺失 / 空 / 与本次相同 → upstream_unavailable。归档 kind = order。
// - 映射（data.result[]）：order_id = tb_trade_id；refund_id = refund_suit_id；base_refund_fen =
//   tk_commission_fee_refund 原值（B1-04zza，D10-645 ①：该字段已不含技术服务费与渠道专项服务费，
//   alimm / agent 两项只校验、不相减）；subsidy_refund_fen = tk_subsidy_fee_refund −
//   tk_subsidy_alimm_refund_fee − tk_subsidy_agent_refund_fee；refund_fen = base_refund_fen。各金额先按 BR-CALC-26 yuanStrToFen 单独
//   取分（JSON 数字取原文），补贴再相减。必需字段缺失 / 非法 → 跳过该条并告警；补贴差为负 → 跳过并告警。
// - rights_status（B1-04zza，D10-645 ②）：refund_status 4 / 11 → PROCESSING；2 / 12 / 13 → SUCCEEDED；
//   3 → FAILED；14 / 15 → CLOSED_NO_CHARGE；缺失或别的码 → null（不当成功）。
// - 维权记录没有推广位字段：union 侧不过滤，原样返回；是否凑狸订单由 orders / funds 按已入库订单匹配。
// TODO(规划/11 §4.5): 明细字段按文档写（录制窗口内 0 条），待大淘客维权录制复核 — blocked on 大淘客录制
import type {
  RefundQueryOpt,
  TimeWindow,
  UnionError,
  UnionRefund,
  UnionRightsStatus,
} from '../../domain/types.ts';
import {
  beijingText,
  isRecord,
  parseTaobaoRawData,
  taobaoAbsent,
  taobaoBeijingDate,
  taobaoDecimalId,
  taobaoFen,
  taobaoInvalid,
  taobaoText,
  taobaoUnavailable,
  windowSeconds,
} from './orders.ts';

/**
 * Refund warnings. None carries an order number, a refund id or an amount:
 * - taobao_refund_row_skipped: a required field (tb_trade_id, refund_suit_id or one of the six
 *   tk_*_refund amounts) was missing or invalid; `field` is the upstream field name;
 * - taobao_refund_negative: subsidy_refund_fen came out negative (`field` names it); the refund
 *   was left out;
 * - taobao_refund_field_invalid: an optional field was invalid and became null (`field`).
 */
export type TaobaoRefundWarningEvent =
  'taobao_refund_row_skipped' | 'taobao_refund_negative' | 'taobao_refund_field_invalid';

export interface TaobaoRefundWarning {
  readonly event: TaobaoRefundWarningEvent;
  readonly field?: string;
}

export const TAOBAO_REFUND_PATH = '/api/tb-service/get-order-refund';
export const TAOBAO_REFUND_VERSION = 'v1.0.0';
export const TAOBAO_REFUND_PAGE_SIZE = 100;
/** memberType 4 = 不限（二方 / 三方都要）。 */
export const TAOBAO_REFUND_MEMBER_TYPE = 4;
export const TAOBAO_REFUND_SCENE = 1;
/** 大淘客单次查询的时间跨度上限：3 小时（同订单）。 */
export const TAOBAO_REFUND_MAX_SPAN_SECONDS = 3 * 3_600;
/** 北京时间 2022-12-20 00:00:00：queryType 4 / 5 的起点不得更早。 */
export const TAOBAO_REFUND_CREATE_UPDATE_FLOOR = 1_671_465_600;

const OPERATION = 'listRefunds';

const QUERY_TYPES: Readonly<Record<string, number>> = Object.freeze({
  refund_created: 1,
  settle: 2,
  refund_finished: 3,
  create: 4,
  update: 5,
});

/** The six required amounts, in the order they are checked (all six must be valid). */
const COMMISSION_FIELDS = [
  'tk_commission_fee_refund',
  'tk_commission_alimm_refund_fee',
  'tk_commission_agent_refund_fee',
] as const;
const SUBSIDY_FIELDS = [
  'tk_subsidy_fee_refund',
  'tk_subsidy_alimm_refund_fee',
  'tk_subsidy_agent_refund_fee',
] as const;

/** Taobao refund_status → the normalized refund state (D10-645 ②); other codes are unknown. */
const RIGHTS_STATUS: Readonly<Record<string, UnionRightsStatus>> = Object.freeze({
  '4': 'PROCESSING',
  '11': 'PROCESSING',
  '2': 'SUCCEEDED',
  '12': 'SUCCEEDED',
  '13': 'SUCCEEDED',
  '3': 'FAILED',
  '14': 'CLOSED_NO_CHARGE',
  '15': 'CLOSED_NO_CHARGE',
});

/** null for a missing status or a code not listed (never taken as a success). */
export function taobaoRightsStatus(code: string | null): UnionRightsStatus | null {
  if (code === null || !Object.hasOwn(RIGHTS_STATUS, code)) return null;
  return RIGHTS_STATUS[code] ?? null;
}

type Warn = ((event: TaobaoRefundWarning) => void) | undefined;

function invalid(message: string): UnionError {
  return taobaoInvalid(message, OPERATION);
}

function unavailable(message: string): UnionError {
  return taobaoUnavailable(message, OPERATION);
}

// ---------------------------------------------------------------------------------------------
// 查询计划：口径、窗口、游标（都在取凭据、发请求之前校验）
// ---------------------------------------------------------------------------------------------

/** One upstream request: the sub-window, its page number and the position to continue from. */
export interface TaobaoRefundPlan {
  readonly queryType: number;
  /** Whole window in Unix seconds (from floored, to ceiled). */
  readonly start: number;
  readonly end: number;
  readonly subStart: number;
  readonly subEnd: number;
  /** 1-based page of the sub-window; 1 exactly when position is null. */
  readonly pageNo: number;
  /** null = first page of the sub-window. */
  readonly position: string | null;
}

function queryTypeOf(basis: unknown): number {
  if (basis === undefined) return QUERY_TYPES.update!;
  if (typeof basis !== 'string' || !Object.hasOwn(QUERY_TYPES, basis)) {
    throw invalid('unknown timeBasis');
  }
  return QUERY_TYPES[basis]!;
}

function subEndOf(subStart: number, end: number): number {
  return Math.min(subStart + TAOBAO_REFUND_MAX_SPAN_SECONDS, end);
}

/*
 * 游标编码（不透明，调用方原样回传；与订单游标 tbo1 互不通用）：
 * `tbr1.<queryType>.<start>.<end>.<subStart>.<pageNo>.<position>`，position 是 position_index 的
 * base64url（空 = 该窗首页，此时 pageNo 必为 1）。格式不对、口径或窗口与本次调用不符、subStart 不在
 * 切窗网格上 → invalid_dto。
 */
const CURSOR =
  /^tbr1\.([1-5])\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.([1-9][0-9]{0,5})\.([A-Za-z0-9_-]*)$/;

function cursorOf(plan: TaobaoRefundPlan): string {
  const position =
    plan.position === null ? '' : Buffer.from(plan.position, 'utf8').toString('base64url');
  return `tbr1.${plan.queryType}.${plan.start}.${plan.end}.${plan.subStart}.${plan.pageNo}.${position}`;
}

function cursorPosition(encoded: string): string | null {
  if (encoded === '') return null;
  const position = Buffer.from(encoded, 'base64url').toString('utf8');
  // 只认本实现编出的规范形式（解码再编码须原样）。
  if (position === '' || Buffer.from(position, 'utf8').toString('base64url') !== encoded) {
    throw invalid('cursor is not a taobao refund cursor');
  }
  return position;
}

/** The request this listRefunds call makes; every check here precedes credentials and I/O. */
export function planTaobaoRefunds(
  win: TimeWindow,
  opt: RefundQueryOpt | undefined,
): TaobaoRefundPlan {
  const queryType = queryTypeOf(opt?.timeBasis);
  const { start, end } = windowSeconds(win, OPERATION);
  if (queryType >= 4 && start < TAOBAO_REFUND_CREATE_UPDATE_FLOOR) {
    throw invalid('queryType 4 / 5 cannot start before 2022-12-20 (Beijing)');
  }
  const cursor: unknown = opt?.cursor;
  if (cursor === undefined) {
    return {
      queryType,
      start,
      end,
      subStart: start,
      subEnd: subEndOf(start, end),
      pageNo: 1,
      position: null,
    };
  }
  const match = typeof cursor === 'string' ? CURSOR.exec(cursor) : null;
  if (match === null) throw invalid('cursor is not a taobao refund cursor');
  if (Number(match[1]) !== queryType) throw invalid('cursor belongs to another timeBasis');
  if (Number(match[2]) !== start || Number(match[3]) !== end) {
    throw invalid('cursor belongs to another time window');
  }
  const subStart = Number(match[4]);
  if (
    subStart < start ||
    subStart >= end ||
    (subStart - start) % TAOBAO_REFUND_MAX_SPAN_SECONDS !== 0
  ) {
    throw invalid('cursor is not a taobao refund cursor');
  }
  const pageNo = Number(match[5]);
  const position = cursorPosition(match[6]!);
  if ((position === null) !== (pageNo === 1)) throw invalid('cursor is not a taobao refund cursor');
  return { queryType, start, end, subStart, subEnd: subEndOf(subStart, end), pageNo, position };
}

/** Business parameters of the plan's request. */
export function taobaoRefundParameters(
  plan: TaobaoRefundPlan,
): Readonly<Record<string, string | number>> {
  return {
    queryType: plan.queryType,
    startTime: beijingText(plan.subStart),
    endTime: beijingText(plan.subEnd),
    pageNo: plan.pageNo,
    pageSize: TAOBAO_REFUND_PAGE_SIZE,
    memberType: TAOBAO_REFUND_MEMBER_TYPE,
    orderScene: TAOBAO_REFUND_SCENE,
    ...(plan.position === null ? {} : { positionIndex: plan.position }),
  };
}

/** The page in a refund response body (data.result; numbers kept as literals). */
export interface TaobaoRefundPageData {
  readonly rows: readonly unknown[];
  readonly hasNext: boolean;
  readonly position: string | null;
}

export function parseTaobaoRefundBody(body: string): TaobaoRefundPageData {
  const data = parseTaobaoRawData(body, OPERATION);
  const result = data.result;
  let rows: readonly unknown[];
  if (result === undefined || result === null) rows = [];
  else if (Array.isArray(result)) rows = result;
  else throw unavailable('result is not an array');
  return {
    rows,
    hasNext: data.has_next === true,
    position:
      typeof data.position_index === 'string' && data.position_index !== ''
        ? data.position_index
        : null,
  };
}

/**
 * The cursor after a page: the next page of the same sub-window while has_next is true, else the
 * first page of the next sub-window, else null.
 */
export function nextTaobaoRefundCursor(
  plan: TaobaoRefundPlan,
  page: { readonly hasNext: boolean; readonly position: string | null },
): string | null {
  if (page.hasNext) {
    if (page.position === null || page.position === plan.position) {
      throw unavailable('has_next without a new position_index');
    }
    return cursorOf({ ...plan, pageNo: plan.pageNo + 1, position: page.position });
  }
  if (plan.subEnd >= plan.end) return null;
  return cursorOf({
    ...plan,
    subStart: plan.subEnd,
    subEnd: subEndOf(plan.subEnd, plan.end),
    pageNo: 1,
    position: null,
  });
}

// ---------------------------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------------------------

class Skip {
  readonly event: TaobaoRefundWarningEvent;
  readonly field: string;

  constructor(event: TaobaoRefundWarningEvent, field: string) {
    this.event = event;
    this.field = field;
  }
}

/** An id: JSON integer → decimal text, a non-blank string as is; otherwise the row is skipped. */
function requiredId(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === 'string') {
    if (value.trim() === '' || value === '--') throw new Skip('taobao_refund_row_skipped', field);
    return value;
  }
  const id = taobaoDecimalId(value);
  if (id === null) throw new Skip('taobao_refund_row_skipped', field);
  return id;
}

function requiredFen(row: Record<string, unknown>, field: string): bigint {
  const value = row[field];
  const fen = taobaoAbsent(value) ? null : taobaoFen(value);
  if (fen === null) throw new Skip('taobao_refund_row_skipped', field);
  return fen;
}

/** The three amounts of a group, each floored to fen on its own (BR-CALC-26). */
function netFen(
  row: Record<string, unknown>,
  fields: readonly [string, string, string],
): readonly [bigint, bigint, bigint] {
  return [requiredFen(row, fields[0]), requiredFen(row, fields[1]), requiredFen(row, fields[2])];
}

function difference(parts: readonly [bigint, bigint, bigint], name: string): bigint {
  const net = parts[0] - parts[1] - parts[2];
  if (net < 0n) throw new Skip('taobao_refund_negative', name);
  return net;
}

/**
 * One data.result row → UnionRefund, or null when it is left out (warned). Optional fields that
 * are invalid become null and are warned once each; missing / JSON null / "--" are plain null.
 */
export function mapTaobaoRefund(input: unknown, like: Date, warn: Warn): UnionRefund | null {
  if (!isRecord(input)) {
    warn?.({ event: 'taobao_refund_row_skipped' });
    return null;
  }
  try {
    return mapRow(input, like, warn);
  } catch (error) {
    if (!(error instanceof Skip)) throw error;
    warn?.({ event: error.event, field: error.field });
    return null;
  }
}

function mapRow(row: Record<string, unknown>, like: Date, warn: Warn): UnionRefund {
  const orderId = requiredId(row, 'tb_trade_id');
  const refundId = requiredId(row, 'refund_suit_id');
  const commission = netFen(row, COMMISSION_FIELDS);
  const subsidy = netFen(row, SUBSIDY_FIELDS);
  // D10-645 ①：应扣佣金取 tk_commission_fee_refund 原值（已不含两项服务费），alimm / agent 只校验。
  const baseFen = commission[0];
  const subsidyFen = difference(subsidy, 'subsidy_refund_fen');

  const bad = (field: string): null => {
    warn?.({ event: 'taobao_refund_field_invalid', field });
    return null;
  };
  const optionalFen = (field: string): bigint | null => {
    const value = row[field];
    if (taobaoAbsent(value)) return null;
    return taobaoFen(value) ?? bad(field);
  };
  const optionalText = (field: string): string | null => {
    const value = row[field];
    if (taobaoAbsent(value) || value === '') return null;
    return taobaoText(value) ?? bad(field);
  };
  const time = (field: string): Date | null => {
    const value = row[field];
    if (taobaoAbsent(value)) return null;
    return taobaoBeijingDate(value, like) ?? bad(field);
  };

  // Same evaluation order as before, so the optional-field warnings keep their order.
  const showReturnFen = optionalFen('show_return_fee');
  const refundStatus = optionalText('refund_status');
  return Object.freeze({
    order_id: orderId,
    refund_id: refundId,
    // 维权应扣佣金只用 base_refund_fen（D10-488 ②）；补贴退款留作参考，不并入。
    refund_fen: baseFen,
    base_refund_fen: baseFen,
    subsidy_refund_fen: subsidyFen,
    show_return_fen: showReturnFen,
    refund_status: refundStatus,
    rights_status: taobaoRightsStatus(refundStatus),
    refund_created_at: time('tk_refund_time'),
    refund_finished_at: time('tk_refund_suit_time'),
    modified_at: time('modified_time'),
    earning_at: time('earning_time'),
  });
}
