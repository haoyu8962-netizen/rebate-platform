// 淘宝订单（B1-04f，D10-486 ② / D10-488 / D10-504 补）：经大淘客 GET /api/tb-service/get-order-details
// （version v1.0.0）取 publisher_order_dto，映射到 UnionOrder（平台无关字段 + TaobaoOrderFields）。
// - 请求：queryType 由 OrderQueryOpt.timeBasis 定（update 4 默认 / pay 2 / settle 3 / create 1）；
//   startTime / endTime 是北京时间「YYYY-MM-DD HH:MM:SS」（由 TimeWindow 换算：from 向下、to 向上取整到秒，
//   与注入时钟无关），窗口 > 3 小时按 3 小时顺序切窗；每窗首页不带 positionIndex，续页原样带上一页的
//   position_index，直到 has_next 不为 true；pageSize 100，orderScene 1。每个上游请求经
//   CallCtx.gateUpstream 各取一个配额（per_request）。
// - 一次 listOrders 取一个上游页；nextCursor 是不透明串，承载查询口径、整个窗口、当前窗起点与
//   position_index。游标与本次的口径或窗口不符 → invalid_dto（不按游标里的窗口去查）。
// - has_next 为 true 但 position_index 缺失 / 空串 / 与本次所带相同 → upstream_unavailable（不得不带位点
//   重拉首页，也不得原地打转）。
// - 推广位过滤：只留 adzone_id 属于 TaobaoOrderSlotReader 给出的推广位（PID 最后一段）的订单；
//   清单为空 → 不发请求、返回空页并告警一次；端口未注入 → adapter_unimplemented。
// - 金额（BR-CALC-26）：元字符串或 JSON 数字原文经 @couli/money yuanStrToFen；比例经 pctStrToBp；
//   JSON 数字一律取原文（JSON.parse reviver 的 context.source），不经 JS number。
// - 不映射大淘客自算字段（income、income_by_one、price_by_one、day、*_for_commission、*_for_sdy）。
// TODO(规划/11 §4.5): results 列表键与翻页结束条件按文档字段写，待大淘客订单录制复核 — blocked on 大淘客录制
import { InvalidAmount, InvalidRatio, pctStrToBp, yuanStrToFen } from '@couli/money';
import { makeUnionOrder } from '../../domain/dto.ts';
import {
  UnionError,
  type CallCtx,
  type OrderQueryOpt,
  type TaobaoOrderFields,
  type TimeWindow,
  type UnionOrder,
  type UnionOrderNeutralFields,
} from '../../domain/types.ts';
import type { OrderRowIdentity } from '../order-row.ts';

/**
 * Every Taobao PID (`mm_<memberid>_<siteid>_<adzoneid>`) the platform registered in union_pids for
 * the caller, retired ones included (orders placed before retirement are still ours). Called with
 * the listOrders CallCtx, at most once per call and before any upstream request.
 */
export type TaobaoOrderSlotReader = (ctx: CallCtx) => Promise<readonly string[]>;

/**
 * Order warnings. None carries an order number, an amount, a PID or credentials:
 * - taobao_order_field_invalid: one optional field was missing or invalid and became null
 *   (`field` is the upstream field name);
 * - taobao_order_row_skipped: a row lacked a required field (trade_id, alipay_total_price,
 *   pub_share_pre_fee) or had it invalid, and was left out (`field` names it); under
 *   CallCtx.rowErrors also pub_share_fee of a settled row (requireTaobaoOrder);
 * - taobao_order_foreign_slot: once per upstream page that held orders of other promotion slots
 *   (`count` is how many were left out);
 * - taobao_order_no_slots: the slot reader gave no usable PID; nothing was requested.
 */
export type TaobaoOrderWarningEvent =
  | 'taobao_order_field_invalid'
  | 'taobao_order_row_skipped'
  | 'taobao_order_foreign_slot'
  | 'taobao_order_no_slots';

export interface TaobaoOrderWarning {
  readonly event: TaobaoOrderWarningEvent;
  readonly field?: string;
  readonly count?: number;
}

export const TAOBAO_ORDER_PATH = '/api/tb-service/get-order-details';
export const TAOBAO_ORDER_VERSION = 'v1.0.0';
export const TAOBAO_ORDER_PAGE_SIZE = 100;
export const TAOBAO_ORDER_SCENE = 1;
/** 大淘客单次查询的时间跨度上限：3 小时。 */
export const TAOBAO_ORDER_MAX_SPAN_SECONDS = 3 * 3_600;

const QUERY_TYPES: Readonly<Record<string, number>> = Object.freeze({
  update: 4,
  pay: 2,
  settle: 3,
  create: 1,
});

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const SECONDS_PER_DAY = 86_400;
const BEIJING_TEXT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
/** 上游以「--」表示尚未发生 / 没有值。 */
const ABSENT_TEXT = '--';
const INTEGER_TEXT = /^-?(?:0|[1-9][0-9]*)$/;
const ID_TEXT = /^(?:0|[1-9][0-9]*)$/;

type Warn = ((event: TaobaoOrderWarning) => void) | undefined;

/**
 * Official publisher_order_dto fields every order row carries (the recorded shape), among those
 * mapped here: a missing key is warned (taobao_order_field_invalid) before it becomes null.
 * Fields that appear only on some orders (relation_id, special_id, tk_earning_time, pay_price,
 * the deposit times, alimm_share_info_dto …) stay quietly null when missing; "--" and JSON null
 * are quiet everywhere.
 */
const EXPECTED_FIELDS: ReadonlySet<string> = new Set([
  'trade_parent_id',
  'item_id',
  'item_num',
  'site_id',
  'tk_status',
  'refund_tag',
  'tk_order_role',
  'item_price',
  'pub_share_fee',
  'total_commission_fee',
  'alimama_share_fee',
  'subsidy_fee',
  'income_rate',
  'pub_share_rate',
  'total_commission_rate',
  'tk_paid_time',
  'modified_time',
]);

function invalid(message: string, operation = 'listOrders'): UnionError {
  return new UnionError('invalid_dto', `taobao ${operation}: ${message}`, 'taobao');
}

function unavailable(message: string, operation = 'listOrders'): UnionError {
  return new UnionError('upstream_unavailable', `taobao ${operation}: ${message}`, 'taobao');
}

/** B1-04z: invalid_dto / upstream_unavailable of another 大淘客 operation (same wording). */
export const taobaoInvalid = invalid;
export const taobaoUnavailable = unavailable;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// 查询计划：口径、窗口、游标（都在读推广位、取凭据、发请求之前校验）
// ---------------------------------------------------------------------------------------------

/** One upstream request: the sub-window [subStart, subEnd] and the position to continue from. */
export interface TaobaoOrderPlan {
  readonly queryType: number;
  /** Whole window in Unix seconds (from floored, to ceiled). */
  readonly start: number;
  readonly end: number;
  readonly subStart: number;
  readonly subEnd: number;
  /** null = first page of the sub-window. */
  readonly position: string | null;
}

function queryTypeOf(basis: unknown): number {
  if (basis === undefined) return QUERY_TYPES.update!;
  const queryType = typeof basis === 'string' && Object.hasOwn(QUERY_TYPES, basis);
  if (!queryType) throw invalid('unknown timeBasis');
  return QUERY_TYPES[basis as string]!;
}

/** Seconds of the window: validated on the millisecond values, then rounded outward. */
export function windowSeconds(
  win: TimeWindow,
  operation = 'listOrders',
): { readonly start: number; readonly end: number } {
  const fromMs = typeof win?.from === 'string' ? Date.parse(win.from) : Number.NaN;
  const toMs = typeof win?.to === 'string' ? Date.parse(win.to) : Number.NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw invalid('time window must be two ISO-8601 instants', operation);
  }
  if (fromMs >= toMs) throw invalid('time window must have from < to', operation);
  return { start: Math.floor(fromMs / 1000), end: Math.ceil(toMs / 1000) };
}

function subEndOf(subStart: number, end: number): number {
  return Math.min(subStart + TAOBAO_ORDER_MAX_SPAN_SECONDS, end);
}

/*
 * 游标编码（不透明，调用方原样回传）：`tbo1.<queryType>.<start>.<end>.<subStart>.<position>`，
 * start / end 是整个窗口（秒），subStart 是当前窗起点，position 是 position_index 的 base64url
 * （空 = 该窗首页）。格式不对、口径或窗口与本次调用不符、subStart 不在切窗网格上 → invalid_dto。
 */
const CURSOR =
  /^tbo1\.([1-4])\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.([A-Za-z0-9_-]*)$/;

export function taobaoOrderCursor(plan: {
  readonly queryType: number;
  readonly start: number;
  readonly end: number;
  readonly subStart: number;
  readonly position: string | null;
}): string {
  const position =
    plan.position === null ? '' : Buffer.from(plan.position, 'utf8').toString('base64url');
  return `tbo1.${plan.queryType}.${plan.start}.${plan.end}.${plan.subStart}.${position}`;
}

function cursorPosition(encoded: string): string | null {
  if (encoded === '') return null;
  const position = Buffer.from(encoded, 'base64url').toString('utf8');
  // 只认本实现编出的规范形式（解码再编码须原样）。
  if (position === '' || Buffer.from(position, 'utf8').toString('base64url') !== encoded) {
    throw invalid('cursor is not a taobao order cursor');
  }
  return position;
}

/** The request this listOrders call makes; every check here precedes slots, credentials, I/O. */
export function planTaobaoOrders(win: TimeWindow, opt: OrderQueryOpt): TaobaoOrderPlan {
  const queryType = queryTypeOf(opt?.timeBasis);
  const { start, end } = windowSeconds(win);
  const cursor: unknown = opt?.cursor;
  if (cursor === undefined) {
    return { queryType, start, end, subStart: start, subEnd: subEndOf(start, end), position: null };
  }
  const match = typeof cursor === 'string' ? CURSOR.exec(cursor) : null;
  if (match === null) throw invalid('cursor is not a taobao order cursor');
  if (Number(match[1]) !== queryType) throw invalid('cursor belongs to another timeBasis');
  if (Number(match[2]) !== start || Number(match[3]) !== end) {
    throw invalid('cursor belongs to another time window');
  }
  const subStart = Number(match[4]);
  if (
    subStart < start ||
    subStart >= end ||
    (subStart - start) % TAOBAO_ORDER_MAX_SPAN_SECONDS !== 0
  ) {
    throw invalid('cursor is not a taobao order cursor');
  }
  return {
    queryType,
    start,
    end,
    subStart,
    subEnd: subEndOf(subStart, end),
    position: cursorPosition(match[5]!),
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Unix seconds → Beijing "YYYY-MM-DD HH:MM:SS"; integer civil-from-days, no Date, no clock. */
export function beijingText(unixSeconds: number): string {
  const local = unixSeconds + BEIJING_OFFSET_MS / 1000;
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

/** Business parameters of the plan's request. */
export function taobaoOrderParameters(
  plan: TaobaoOrderPlan,
): Readonly<Record<string, string | number>> {
  return {
    queryType: plan.queryType,
    startTime: beijingText(plan.subStart),
    endTime: beijingText(plan.subEnd),
    pageSize: TAOBAO_ORDER_PAGE_SIZE,
    orderScene: TAOBAO_ORDER_SCENE,
    ...(plan.position === null ? {} : { positionIndex: plan.position }),
  };
}

/**
 * The cursor after a page: the next page of the same sub-window while has_next is true, else the
 * first page of the next sub-window, else null.
 */
export function nextTaobaoOrderCursor(
  plan: TaobaoOrderPlan,
  page: { readonly hasNext: boolean; readonly position: string | null },
): string | null {
  if (page.hasNext) {
    if (page.position === null || page.position === plan.position) {
      throw unavailable('has_next without a new position_index');
    }
    return taobaoOrderCursor({ ...plan, position: page.position });
  }
  if (plan.subEnd >= plan.end) return null;
  return taobaoOrderCursor({ ...plan, subStart: plan.subEnd, position: null });
}

// ---------------------------------------------------------------------------------------------
// 推广位
// ---------------------------------------------------------------------------------------------

/** adzone ids (decimal text) of the PIDs: the last "_" segment when it is a plain decimal id. */
export function slotAdzones(pids: unknown): ReadonlySet<string> {
  const adzones = new Set<string>();
  if (!Array.isArray(pids)) return adzones;
  for (const pid of pids) {
    if (typeof pid !== 'string') continue;
    const segments = pid.split('_');
    const last = segments[segments.length - 1]!;
    if (segments.length >= 2 && ID_TEXT.test(last)) adzones.add(last);
  }
  return adzones;
}

// ---------------------------------------------------------------------------------------------
// 报文：JSON 数字原文
// ---------------------------------------------------------------------------------------------

/** A JSON number of the order body, kept as its literal (only made by parseTaobaoOrderBody). */
export class TaobaoRawNumber {
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
 * The page in an order response body (already checked by the DataokeClient decoder). Every JSON
 * number becomes its literal (TaobaoRawNumber), so amounts never go through a JS number.
 */
export interface TaobaoOrderPageData {
  readonly rows: readonly unknown[];
  readonly hasNext: boolean;
  readonly position: string | null;
}

/**
 * The `data` object of a 大淘客 response body, every JSON number kept as its literal
 * (TaobaoRawNumber). Not JSON / no data object → upstream_unavailable.
 */
export function parseTaobaoRawData(
  body: string,
  operation = 'listOrders',
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body, (_name: string, value: unknown, context?: ReviverContext) =>
      typeof value === 'number'
        ? new TaobaoRawNumber(typeof context?.source === 'string' ? context.source : String(value))
        : value,
    );
  } catch {
    throw unavailable('response is not JSON', operation);
  }
  const data = isRecord(parsed) ? parsed.data : undefined;
  if (!isRecord(data)) throw unavailable('response data is not an object', operation);
  return data;
}

export function parseTaobaoOrderBody(body: string): TaobaoOrderPageData {
  const data = parseTaobaoRawData(body);
  return {
    rows: orderRows(data.results),
    hasNext: data.has_next === true,
    position:
      typeof data.position_index === 'string' && data.position_index !== ''
        ? data.position_index
        : null,
  };
}

/** results.publisher_order_dto; absent / null results or list = no orders, other shapes fail. */
function orderRows(results: unknown): readonly unknown[] {
  if (results === undefined || results === null) return [];
  if (!isRecord(results)) throw unavailable('results is not an object');
  const list = results.publisher_order_dto;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw unavailable('results.publisher_order_dto is not an array');
  return list;
}

/** Decimal id text of a JSON integer or a decimal string; otherwise null. */
export function taobaoDecimalId(value: unknown): string | null {
  const text =
    value instanceof TaobaoRawNumber ? value.text : typeof value === 'string' ? value : null;
  return text !== null && ID_TEXT.test(text) ? text : null;
}

/** adzone_id as decimal text when it is a JSON integer (or a decimal string); otherwise null. */
function adzoneOf(row: unknown): string | null {
  if (!isRecord(row)) return null;
  return taobaoDecimalId(row.adzone_id);
}

/**
 * Keeps the rows of our promotion slots, in upstream order; the others (unknown, missing or
 * invalid adzone_id included) are counted and reported once for the page.
 */
export function ourRows(
  rows: readonly unknown[],
  adzones: ReadonlySet<string>,
  warn: Warn,
): readonly unknown[] {
  const kept = rows.filter((row) => {
    const adzone = adzoneOf(row);
    return adzone !== null && adzones.has(adzone);
  });
  const foreign = rows.length - kept.length;
  if (foreign > 0) warn?.({ event: 'taobao_order_foreign_slot', count: foreign });
  return kept;
}

// ---------------------------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------------------------

/** Metadata of one order page: archive row id (or null) and a Date template from the clock. */
export interface TaobaoOrderPageMeta {
  readonly rawPayloadId: string | null;
  readonly like: Date;
}

class Skip {
  readonly field: string;

  constructor(field: string) {
    this.field = field;
  }
}

class Reader {
  readonly #row: Record<string, unknown>;
  readonly #warn: Warn;
  readonly #like: Date;

  constructor(row: Record<string, unknown>, warn: Warn, like: Date) {
    this.#row = row;
    this.#warn = warn;
    this.#like = like;
  }

  #bad(field: string): null {
    this.#warn?.({ event: 'taobao_order_field_invalid', field });
    return null;
  }

  /**
   * No value for a top-level field: JSON null and "--" quietly; a missing key quietly too, unless
   * the field is one every row carries (EXPECTED_FIELDS), which is warned once.
   */
  #absent(field: string): boolean {
    if (!Object.hasOwn(this.#row, field)) {
      if (EXPECTED_FIELDS.has(field)) this.#bad(field);
      return true;
    }
    return Reader.absent(this.#row[field]);
  }

  /** Missing, JSON null and "--" are "no value" (null, no warning). */
  static absent(value: unknown): boolean {
    return value === undefined || value === null || value === ABSENT_TEXT;
  }

  /** Text of a scalar: a string as is, a JSON number as its literal. */
  static text(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value instanceof TaobaoRawNumber) return value.text;
    return null;
  }

  static fen(value: unknown): bigint | null {
    const text = Reader.text(value);
    if (text === null || text.startsWith('-') || text.startsWith('+')) return null;
    try {
      return yuanStrToFen(text);
    } catch (error) {
      if (error instanceof InvalidAmount) return null;
      throw error;
    }
  }

  /**
   * A well-formed negative amount. Reader.fen refuses it like any invalid text; B1-04zv tells it
   * apart because how to treat it is not decided yet, so it stays as it was (null and a warning).
   */
  static negative(value: unknown): boolean {
    const text = Reader.text(value);
    return text !== null && text.startsWith('-') && Reader.fen(text.slice(1)) !== null;
  }

  /** Required yuan amount; missing / invalid → the row is skipped. */
  requiredFen(field: string): bigint {
    const value = this.#row[field];
    const fen = Reader.absent(value) ? null : Reader.fen(value);
    if (fen === null) throw new Skip(field);
    return fen;
  }

  fenOf(value: unknown, field: string): bigint | null {
    if (Reader.absent(value)) return null;
    return Reader.fen(value) ?? this.#bad(field);
  }

  fen(field: string): bigint | null {
    if (this.#absent(field)) return null;
    return this.fenOf(this.#row[field], field);
  }

  bp(field: string): bigint | null {
    if (this.#absent(field)) return null;
    const value = this.#row[field];
    const text = Reader.text(value);
    if (text === null || text.startsWith('-') || text.startsWith('+')) return this.#bad(field);
    try {
      return pctStrToBp(text);
    } catch (error) {
      if (error instanceof InvalidRatio || error instanceof InvalidAmount) return this.#bad(field);
      throw error;
    }
  }

  integer(field: string): number | null {
    if (this.#absent(field)) return null;
    const value = this.#row[field];
    const text = value instanceof TaobaoRawNumber ? value.text : null;
    if (text === null || !INTEGER_TEXT.test(text) || !Number.isSafeInteger(Number(text))) {
      return this.#bad(field);
    }
    return Number(text);
  }

  /** An id: JSON integer → decimal text, a non-empty string as is. */
  id(field: string): string | null {
    if (this.#absent(field)) return null;
    const value = this.#row[field];
    if (value === '') return null;
    if (value instanceof TaobaoRawNumber)
      return ID_TEXT.test(value.text) ? value.text : this.#bad(field);
    if (typeof value === 'string' && value.trim() !== '') return value;
    return this.#bad(field);
  }

  string(field: string): string | null {
    if (this.#absent(field)) return null;
    const value = this.#row[field];
    return typeof value === 'string' && value !== '' ? value : this.#bad(field);
  }

  /** Beijing "YYYY-MM-DD HH:MM:SS" → Date (copied from the clock template, no system clock). */
  time(field: string): Date | null {
    if (this.#absent(field)) return null;
    const value = this.#row[field];
    const ms = typeof value === 'string' ? beijingMs(value) : null;
    if (ms === null) return this.#bad(field);
    const result = structuredClone(this.#like);
    result.setTime(ms);
    return result;
  }
}

/** B1-04z: "no value" of the 大淘客 wire (missing, JSON null, "--"). */
export function taobaoAbsent(value: unknown): boolean {
  return Reader.absent(value);
}

/** B1-04z: text of a scalar (a string as is, a JSON number as its literal); otherwise null. */
export function taobaoText(value: unknown): string | null {
  return Reader.text(value);
}

/** B1-04z: BR-CALC-26 fen of a non-negative yuan text / JSON number literal; otherwise null. */
export function taobaoFen(value: unknown): bigint | null {
  return Reader.fen(value);
}

/**
 * B1-04z: Beijing "YYYY-MM-DD HH:MM:SS" → Date copied from the clock template `like` (no system
 * clock); not such a text → null.
 */
export function taobaoBeijingDate(value: unknown, like: Date): Date | null {
  const ms = typeof value === 'string' ? beijingMs(value) : null;
  if (ms === null) return null;
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Instant (ms) of a Beijing wall-clock text, or null when it is not a real time. */
export function beijingMs(text: string): number | null {
  const match = BEIJING_TEXT.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) - BEIJING_OFFSET_MS;
}

export type TaobaoOrder = UnionOrder & UnionOrderNeutralFields & TaobaoOrderFields;

/**
 * One publisher_order_dto → UnionOrder, or null when a required field (trade_id,
 * alipay_total_price, pub_share_pre_fee) is missing or invalid (warned as row_skipped). Optional
 * fields that are invalid become null and are warned once each; "--" and missing are plain null.
 */
export function mapTaobaoOrder(
  input: unknown,
  meta: TaobaoOrderPageMeta,
  warn: Warn,
): TaobaoOrder | null {
  const result = mapOrSkip(input, meta, warn, false);
  return result instanceof Skip ? null : result;
}

/**
 * B1-04zv: the same mapping for CallCtx.rowErrors: a skipped row throws invalid_dto naming the field
 * (the warning stays), so it can be collected. Stricter on one field: a settled row
 * (tk_earning_time is valid) needs pub_share_fee, because it is the row's N (BR-CALC-03) and a null
 * there would be settled on the estimate. Without rowErrors that stays null plus a warning.
 */
export function requireTaobaoOrder(
  input: unknown,
  meta: TaobaoOrderPageMeta,
  warn: Warn,
): TaobaoOrder {
  const result = mapOrSkip(input, meta, warn, true);
  if (result instanceof Skip) throw invalid(`${result.field} is missing or invalid`);
  return result;
}

/** B1-04zv: what a refused row still says about itself; reading it does not throw or warn. */
export function taobaoRowIdentity(input: unknown, like: Date): OrderRowIdentity {
  if (!isRecord(input)) return { sub_order_id: null, raw_status: null };
  const tradeId = input.trade_id;
  const tkStatus = new Reader(input, undefined, like).integer('tk_status');
  return {
    sub_order_id: typeof tradeId === 'string' && tradeId.trim() !== '' ? tradeId : null,
    raw_status: tkStatus === null ? null : String(tkStatus),
  };
}

function mapOrSkip(
  input: unknown,
  meta: TaobaoOrderPageMeta,
  warn: Warn,
  strict: boolean,
): TaobaoOrder | Skip {
  if (!isRecord(input)) {
    warn?.({ event: 'taobao_order_row_skipped' });
    return new Skip('order row');
  }
  try {
    return mapRow(input, meta, warn, strict);
  } catch (error) {
    if (!(error instanceof Skip)) throw error;
    warn?.({ event: 'taobao_order_row_skipped', field: error.field });
    return error;
  }
}

function mapRow(
  row: Record<string, unknown>,
  meta: TaobaoOrderPageMeta,
  warn: Warn,
  strict: boolean,
): TaobaoOrder {
  const f = new Reader(row, warn, meta.like);
  const tradeId = row.trade_id;
  if (typeof tradeId !== 'string' || tradeId.trim() === '') throw new Skip('trade_id');
  const paidFen = f.requiredFen('alipay_total_price');
  const estFen = f.requiredFen('pub_share_pre_fee');
  const base = makeUnionOrder({
    platform: 'taobao',
    order_id: tradeId,
    item_id: f.string('item_id'),
    paid_fen: paidFen,
    commission_fen: estFen,
  });
  const tkStatus = f.integer('tk_status');
  // 已结算的判据是 tk_earning_time 有合法时间；未结算时 pub_share_fee（常为 "0.00"）不当结算佣金。
  const settledAt = f.time('tk_earning_time');
  const pubShareFee = f.fen('pub_share_fee');
  if (strict && settledAt !== null && pubShareFee === null) {
    if (!Reader.negative(row.pub_share_fee)) throw new Skip('pub_share_fee');
  }
  const share = row.alimm_share_info_dto;
  let techFee: bigint | null = null;
  let techPreFee: bigint | null = null;
  if (isRecord(share)) {
    techFee = f.fenOf(share.alimm_tech_service_fee, 'alimm_share_info_dto.alimm_tech_service_fee');
    techPreFee = f.fenOf(
      share.alimm_tech_service_pre_fee,
      'alimm_share_info_dto.alimm_tech_service_pre_fee',
    );
  } else if (!Reader.absent(share)) {
    warn?.({ event: 'taobao_order_field_invalid', field: 'alimm_share_info_dto' });
  }
  return Object.freeze({
    ...base,
    // 平台无关字段（D10-20）。
    sub_order_id: tradeId,
    parent_order_id: f.id('trade_parent_id'),
    promotion_slot: adzoneOf(row),
    attr_params: Object.freeze({
      relation_id: f.id('relation_id'),
      custom_parameters: null,
      sub_union_id: null,
    }),
    raw_status: tkStatus === null ? null : String(tkStatus),
    deposit_paid_at: f.time('tk_deposit_time'),
    paid_at: f.time('tk_paid_time'),
    // 淘宝订单报文没有确认收货时间字段。
    received_at: null,
    settled_at: settledAt,
    modified_at: f.time('modified_time'),
    est_commission_fen: estFen,
    settle_commission_fen: settledAt === null ? null : pubShareFee,
    raw_payload_id: meta.rawPayloadId,
    // TaobaoOrderFields（官方同名字段原样；不是归因 N，D10-488）。
    tk_status: tkStatus,
    refund_tag: f.integer('refund_tag'),
    tk_order_role: f.integer('tk_order_role'),
    item_num: f.integer('item_num'),
    site_id: f.id('site_id'),
    special_id: f.id('special_id'),
    item_price_fen: f.fen('item_price'),
    alimama_share_fen: f.fen('alimama_share_fee'),
    subsidy_fen: f.fen('subsidy_fee'),
    total_commission_fen: f.fen('total_commission_fee'),
    tech_service_fee_fen: techFee,
    tech_service_pre_fee_fen: techPreFee,
    income_rate_bp: f.bp('income_rate'),
    pub_share_rate_bp: f.bp('pub_share_rate'),
    total_commission_rate_bp: f.bp('total_commission_rate'),
  });
}
