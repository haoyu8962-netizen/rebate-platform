// 淘宝违规（B1-04z，D10-486 ③ / D10-488 ②③）：经大淘客 GET /api/tb-service/get-foul-order-list
// （version v1.0.0）取违规订单，映射到 UnionPunish。
// - 请求：startTime（北京时间「YYYY-MM-DD HH:MM:SS」，由窗口起点换算，同 orders.ts）+ span（天）；
//   窗口按 30 天一段顺序切，每段 span = min(30, 该段剩余时长向上取整到天)；段内 pageNo 从 1 起逐页，
//   累计条数达到该页的 total_count 即该段结束。一页没有记录而累计仍不足 total_count、或 total_count
//   缺失 / 非法 → upstream_unavailable。pageSize 10（与录制请求一致，文档默认值）。一次 listPunishments 取一个上游页（listPunishmentsMetering =
//   per_request，经 ctx.gateUpstream），nextCursor 是不透明串。归档 kind = order。上游只能查近 30 天，
//   本地不另做裁剪。
// - 映射（data.results[]）：order_id = tb_trade_id；punishment_id = `<tb_trade_id>:<settle_month>`；
//   deduction_fen = null（违规无扣款字段，按 BR-FUND 走 PUNISH 全额扣回）；punish_status /
//   violation_type / settle_month 原样字符串（JSON 数字取原文）。tb_trade_id 或 settle_month 缺失 /
//   非法 → 跳过该条并告警。
// - 推广位过滤：只留 tk_adzone_id 属于 orderSlots 给出的推广位（PID 最后一段，含 retired，与 orders.ts
//   同口径）的记录；别家每页计数告警一次；清单为空 → 不发请求、返回空页并告警一次；订单源或推广位
//   端口未注入 → adapter_unimplemented。
// - 归档（B1-04zzp，D10-793 ①）：违规请求的归档只存 taobaoPunishArchiveBody 改写后的报文——data.results
//   里 tk_adzone_id 可读且不在推广位清单的行去掉，其余（含读不出推广位的行与外层字段）与数字原文照旧。
// TODO(规划/11 §4.5): 明细字段按文档写（录制窗口内 0 条），待大淘客违规录制复核 — blocked on 大淘客录制
import type {
  PunishmentQueryOpt,
  TimeWindow,
  UnionError,
  UnionPunish,
} from '../../domain/types.ts';
import {
  beijingText,
  isRecord,
  parseTaobaoRawData,
  TaobaoRawNumber,
  taobaoAbsent,
  taobaoDecimalId,
  taobaoInvalid,
  taobaoText,
  taobaoUnavailable,
  windowSeconds,
} from './orders.ts';

/**
 * Punishment warnings. None carries an order number, an amount or a PID:
 * - taobao_punish_row_skipped: tb_trade_id or settle_month was missing or invalid (`field`);
 * - taobao_punish_foreign_slot: once per upstream page that held records of other promotion
 *   slots (`count` is how many were left out);
 * - taobao_punish_no_slots: the slot reader gave no usable PID; nothing was requested.
 */
export type TaobaoPunishWarningEvent =
  'taobao_punish_row_skipped' | 'taobao_punish_foreign_slot' | 'taobao_punish_no_slots';

export interface TaobaoPunishWarning {
  readonly event: TaobaoPunishWarningEvent;
  readonly field?: string;
  readonly count?: number;
}

export const TAOBAO_PUNISH_PATH = '/api/tb-service/get-foul-order-list';
export const TAOBAO_PUNISH_VERSION = 'v1.0.0';
/** 文档默认 10；录制请求（2026-10-31 F1）即用 10。 */
export const TAOBAO_PUNISH_PAGE_SIZE = 10;
/** span 上限 30 天。 */
export const TAOBAO_PUNISH_MAX_SPAN_DAYS = 30;

const OPERATION = 'listPunishments';
const SECONDS_PER_DAY = 86_400;
const SEGMENT_SECONDS = TAOBAO_PUNISH_MAX_SPAN_DAYS * SECONDS_PER_DAY;
const COUNT_TEXT = /^(?:0|[1-9][0-9]{0,14})$/;

type Warn = ((event: TaobaoPunishWarning) => void) | undefined;

function invalid(message: string): UnionError {
  return taobaoInvalid(message, OPERATION);
}

function unavailable(message: string): UnionError {
  return taobaoUnavailable(message, OPERATION);
}

// ---------------------------------------------------------------------------------------------
// 查询计划：窗口、游标（都在读推广位、取凭据、发请求之前校验）
// ---------------------------------------------------------------------------------------------

/** One upstream request: the segment, its page and how many records the segment gave so far. */
export interface TaobaoPunishPlan {
  /** Whole window in Unix seconds (from floored, to ceiled). */
  readonly start: number;
  readonly end: number;
  readonly segStart: number;
  readonly segEnd: number;
  /** 1-based page of the segment. */
  readonly pageNo: number;
  /** Records (every slot, skipped rows included) the earlier pages of the segment held. */
  readonly seen: number;
}

function segEndOf(segStart: number, end: number): number {
  return Math.min(segStart + SEGMENT_SECONDS, end);
}

/*
 * 游标编码（不透明；与订单 tbo1、维权 tbr1 互不通用）：`tbp1.<start>.<end>.<segStart>.<pageNo>.<seen>`。
 * 格式不对、窗口与本次调用不符、segStart 不在 30 天网格上、首页却带累计数 → invalid_dto。
 */
const CURSOR =
  /^tbp1\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.([1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,8})$/;

function cursorOf(plan: TaobaoPunishPlan): string {
  return `tbp1.${plan.start}.${plan.end}.${plan.segStart}.${plan.pageNo}.${plan.seen}`;
}

export function planTaobaoPunishments(
  win: TimeWindow,
  opt: PunishmentQueryOpt | undefined,
): TaobaoPunishPlan {
  const { start, end } = windowSeconds(win, OPERATION);
  const cursor: unknown = opt?.cursor;
  if (cursor === undefined) {
    return { start, end, segStart: start, segEnd: segEndOf(start, end), pageNo: 1, seen: 0 };
  }
  const match = typeof cursor === 'string' ? CURSOR.exec(cursor) : null;
  if (match === null) throw invalid('cursor is not a taobao punishment cursor');
  if (Number(match[1]) !== start || Number(match[2]) !== end) {
    throw invalid('cursor belongs to another time window');
  }
  const segStart = Number(match[3]);
  const pageNo = Number(match[4]);
  const seen = Number(match[5]);
  if (
    segStart < start ||
    segStart >= end ||
    (segStart - start) % SEGMENT_SECONDS !== 0 ||
    (pageNo === 1) !== (seen === 0)
  ) {
    throw invalid('cursor is not a taobao punishment cursor');
  }
  return { start, end, segStart, segEnd: segEndOf(segStart, end), pageNo, seen };
}

/** Business parameters: startTime (Beijing) + span (whole days, rounded up, ≤ 30). */
export function taobaoPunishParameters(
  plan: TaobaoPunishPlan,
): Readonly<Record<string, string | number>> {
  return {
    startTime: beijingText(plan.segStart),
    span: Math.ceil((plan.segEnd - plan.segStart) / SECONDS_PER_DAY),
    pageNo: plan.pageNo,
    pageSize: TAOBAO_PUNISH_PAGE_SIZE,
  };
}

export interface TaobaoPunishPageData {
  readonly rows: readonly unknown[];
  readonly total: number;
}

/** data.results and data.total_count; total missing / not a count or results not a list fail. */
export function parseTaobaoPunishBody(body: string): TaobaoPunishPageData {
  const data = parseTaobaoRawData(body, OPERATION);
  const text = taobaoText(data.total_count);
  if (text === null || !COUNT_TEXT.test(text)) throw unavailable('total_count is not a count');
  const results = data.results;
  let rows: readonly unknown[];
  if (results === undefined || results === null) rows = [];
  else if (Array.isArray(results)) rows = results;
  else throw unavailable('results is not an array');
  return { rows, total: Number(text) };
}

/**
 * The cursor after a page: the next page while the segment has given fewer records than
 * total_count, else the first page of the next segment, else null. An empty page short of
 * total_count is upstream_unavailable (no endless paging).
 */
export function nextTaobaoPunishCursor(
  plan: TaobaoPunishPlan,
  page: TaobaoPunishPageData,
): string | null {
  const seen = plan.seen + page.rows.length;
  if (seen < page.total) {
    if (page.rows.length === 0) throw unavailable('empty page before total_count');
    return cursorOf({ ...plan, pageNo: plan.pageNo + 1, seen });
  }
  if (plan.segEnd >= plan.end) return null;
  return cursorOf({
    ...plan,
    segStart: plan.segEnd,
    segEnd: segEndOf(plan.segEnd, plan.end),
    pageNo: 1,
    seen: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// 推广位与映射
// ---------------------------------------------------------------------------------------------

/**
 * Keeps the records of our promotion slots (tk_adzone_id among `adzones`, the PID last segments),
 * in upstream order; the others (missing or invalid tk_adzone_id included) are counted and
 * reported once for the page.
 */
export function ourPunishRows(
  rows: readonly unknown[],
  adzones: ReadonlySet<string>,
  warn: Warn,
): readonly unknown[] {
  const kept = rows.filter((row) => {
    const adzone = punishAdzone(row);
    return adzone !== null && adzones.has(adzone);
  });
  const foreign = rows.length - kept.length;
  if (foreign > 0) warn?.({ event: 'taobao_punish_foreign_slot', count: foreign });
  return kept;
}

/** tk_adzone_id of a record as ourPunishRows reads it (decimal text), else null (unreadable). */
function punishAdzone(row: unknown): string | null {
  return isRecord(row) ? taobaoDecimalId(row.tk_adzone_id) : null;
}

/** JSON text of a parsed tree, every TaobaoRawNumber written as its literal. */
function literalJson(value: unknown): string {
  if (value instanceof TaobaoRawNumber) return value.text;
  if (Array.isArray(value)) return `[${value.map(literalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value).map(
      ([name, member]) => `${JSON.stringify(name)}:${literalJson(member)}`,
    );
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * B1-04zzp（D10-793 ①，同 B1-04zzc 方案 A）: the get-foul-order-list body as the archive stores
 * it. Rows of other companies' promotion slots (tk_adzone_id readable as ourPunishRows reads it,
 * and not in `adzones`) are dropped from data.results; our rows (retired included) and rows whose
 * slot cannot be read stay, in upstream order. Every other member (total_count included) is kept
 * and JSON number literals are written as received. A body with nothing to drop (or whose
 * data.results is not a list) is returned unchanged. Throws when the body is not JSON. Pure: no
 * warning here (the foreign count comes from ourPunishRows only).
 */
export function taobaoPunishArchiveBody(body: string, adzones: ReadonlySet<string>): string {
  // 先确认正文是一个完整的 JSON 值（不是就抛），再借 parseTaobaoRawData（数字保原文）取整棵树。
  const plain: unknown = JSON.parse(body);
  if (!isRecord(plain)) return body;
  const tree = parseTaobaoRawData(`{"data":${body}}`, OPERATION);
  const data = tree.data;
  if (!isRecord(data) || data instanceof TaobaoRawNumber) return body;
  const list = data.results;
  if (!Array.isArray(list)) return body;
  const kept = list.filter((row) => {
    const adzone = punishAdzone(row);
    return adzone === null || adzones.has(adzone);
  });
  if (kept.length === list.length) return body;
  data.results = kept;
  return literalJson(tree);
}

/** Text of a required key part: a non-blank string (not "--") or a JSON integer literal. */
function keyText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' || value === '--' ? null : value;
  return taobaoDecimalId(value);
}

function optionalText(value: unknown): string | null {
  if (taobaoAbsent(value) || value === '') return null;
  return taobaoText(value);
}

/** One data.results record → UnionPunish, or null (warned) when its key is missing or invalid. */
export function mapTaobaoPunish(input: unknown, warn: Warn): UnionPunish | null {
  if (!isRecord(input)) {
    warn?.({ event: 'taobao_punish_row_skipped' });
    return null;
  }
  const orderId = keyText(input.tb_trade_id);
  if (orderId === null) {
    warn?.({ event: 'taobao_punish_row_skipped', field: 'tb_trade_id' });
    return null;
  }
  const settleMonth = keyText(input.settle_month);
  if (settleMonth === null) {
    warn?.({ event: 'taobao_punish_row_skipped', field: 'settle_month' });
    return null;
  }
  return Object.freeze({
    order_id: orderId,
    punishment_id: `${orderId}:${settleMonth}`,
    // 违规无扣款字段：处罚按 BR-FUND 走 PUNISH 全额扣回（D10-488 ②）。
    deduction_fen: null,
    punish_status: optionalText(input.punish_status),
    violation_type: optionalText(input.violation_type),
    settle_month: settleMonth,
  });
}
