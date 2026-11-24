// Order list / detail helpers: contract types, the list query (applied conditions <-> request
// parameters), Beijing dates and times, admin amounts (BR-TEXT-10 through @couli/money, integer
// fen only), basis-point percentages (integer arithmetic) and the console dictionary names of the
// statuses (BR-TEXT-25 admin_dict.*; the code itself while the dictionary has no row for it).
// No copy lives here (texts/orders.ts).
import type { Schema } from '@couli/contracts-ts';
import { formatYuanAdmin, parseFen } from '@couli/money';
import { AdminApiError } from '../../providers/data/index.ts';
import { ordersTexts as t } from '../../texts/orders.ts';
import { platformCodes, platformConfig } from './platforms.ts';

export type OrderRow = Schema<'AdminOrderListItem'>;
export type OrderPage = Schema<'AdminOrderPage'>;
export type OrderDetail = Schema<'AdminOrderDetail'>;
export type PlatformCode = Schema<'PlatformCode'>;
export type PlatformStatus = Schema<'AdminOrderPlatformStatus'>;
export type RebateStatus = Schema<'AdminOrderRebateStatus'>;
export type OrderFlag = Schema<'AdminOrderFlag'>;

export const ORDERS_URL = '/admin/v1/orders';
export const orderUrl = (orderId: string): string => `${ORDERS_URL}/${encodeURIComponent(orderId)}`;

/** Default page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;
/** The page sizes the list offers (F1-07ed). */
export const PAGE_SIZES = [20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
/** q after removing spaces: 1–64 characters (adminListOrders). */
export const QUERY_MAX = 64;

/** Contract enum order (PlatformCode), from the platform settings (./platforms.ts). */
export const PLATFORMS: readonly PlatformCode[] = platformCodes();
/** Contract enum order (AdminOrderPlatformStatus). */
export const PLATFORM_STATUSES: readonly PlatformStatus[] = [
  'DEPOSIT_PAID',
  'PAID',
  'RECEIVED',
  'SETTLED',
  'INVALID',
];
/** Contract enum order (AdminOrderRebateStatus). */
export const REBATE_STATUSES: readonly RebateStatus[] = [
  'UNATTRIBUTED',
  'ESTIMATED',
  'WAITING',
  'CREDITED',
  'VOID',
  'CLAWED_BACK',
];
/** Contract enum order (AdminOrderFlag). */
export const FLAGS: readonly OrderFlag[] = ['locked', 'status_locked', 'rights_pending', 'hold'];

/** Applied list conditions (what the last 【查询】 sent); dates are Beijing calendar days. */
export interface OrderQuery {
  readonly page: number;
  /** Absent: the default PAGE_SIZE. */
  readonly pageSize?: PageSize | undefined;
  readonly platform?: PlatformCode | undefined;
  readonly platformStatus?: PlatformStatus | undefined;
  readonly rebateStatus?: RebateStatus | undefined;
  readonly flag?: OrderFlag | undefined;
  readonly q?: string | undefined;
  readonly userId?: string | undefined;
  /** YYYY-MM-DD, first paid day (inclusive). */
  readonly paidFrom?: string | undefined;
  /** YYYY-MM-DD, last paid day (inclusive on screen; sent as the next day's midnight). */
  readonly paidTo?: string | undefined;
}

export const FIRST_PAGE: OrderQuery = { page: 1 };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** Midnight at the start of a Beijing day as ISO 8601 with offset. */
export function dayStart(day: string): string {
  return `${day}T00:00:00+08:00`;
}

/** Midnight after a Beijing day (the exclusive end of that day) as ISO 8601 with offset. */
export function dayEnd(day: string): string {
  const found = DAY.exec(day);
  if (found === null) return dayStart(day);
  // setUTCFullYear takes the year as written: Date.UTC would read years 0–99 as 1900–1999.
  const next = new Date(0);
  next.setUTCFullYear(Number(found[1]), Number(found[2]) - 1, Number(found[3]) + 1);
  const year = String(next.getUTCFullYear()).padStart(4, '0');
  return dayStart(`${year}-${two(next.getUTCMonth() + 1)}-${two(next.getUTCDate())}`);
}

/** The order_id of a detail drawer address (detail=<order_id>, F1-07edb), else undefined. */
export function detailOf(search: string): string | undefined {
  const value = new URLSearchParams(search).get('detail');
  return value !== null && ORDER_ID.test(value) ? value : undefined;
}

/** Request parameters of adminListOrders (absent conditions are left out). */
export function requestQuery(query: OrderQuery): Record<string, string | number> {
  return {
    page: query.page,
    page_size: query.pageSize ?? PAGE_SIZE,
    ...(query.platform === undefined ? {} : { platform: query.platform }),
    ...(query.platformStatus === undefined ? {} : { platform_status: query.platformStatus }),
    ...(query.rebateStatus === undefined ? {} : { rebate_status: query.rebateStatus }),
    ...(query.flag === undefined ? {} : { flag: query.flag }),
    ...(query.q === undefined ? {} : { q: query.q }),
    ...(query.userId === undefined ? {} : { user_id: query.userId }),
    ...(query.paidFrom === undefined ? {} : { paid_from: dayStart(query.paidFrom) }),
    ...(query.paidTo === undefined ? {} : { paid_to: dayEnd(query.paidTo) }),
  };
}

/** Whether any filter (not the page) is applied. */
export function hasConditions(query: OrderQuery): boolean {
  return (
    query.platform !== undefined ||
    query.platformStatus !== undefined ||
    query.rebateStatus !== undefined ||
    query.flag !== undefined ||
    query.q !== undefined ||
    query.userId !== undefined ||
    query.paidFrom !== undefined ||
    query.paidTo !== undefined
  );
}

/** Router state of the detail subpage and of 【返回】: the list conditions to restore. */
export interface OrdersBackState {
  readonly ordersQuery: OrderQuery;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A real calendar day YYYY-MM-DD (year ≥ 1, month 1–12, day within that month), else undefined. */
export function dayOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const found = DAY.exec(value);
  if (found === null) return undefined;
  const [year, month, day] = [Number(found[1]), Number(found[2]), Number(found[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return undefined;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] ?? 0) ? value : undefined;
}

/**
 * The browser history state without the conditions of an older 【返回】 (F1-07ed): once the list
 * has written its conditions to the address, the address is their only source, so a refresh with
 * an empty search must not bring the old router state back. Other entries are kept as they are.
 */
export function withoutBackState(historyState: unknown): unknown {
  if (typeof historyState !== 'object' || historyState === null) return historyState;
  const { usr } = historyState as { readonly usr?: unknown };
  if (typeof usr !== 'object' || usr === null || !('ordersQuery' in usr)) return historyState;
  const rest: Record<string, unknown> = { ...usr };
  delete rest['ordersQuery'];
  return { ...historyState, usr: Object.keys(rest).length === 0 ? undefined : rest };
}

/** The conditions carried by router state (only well-formed values survive), else undefined. */
export function backQueryOf(state: unknown): OrderQuery | undefined {
  if (typeof state !== 'object' || state === null || !('ordersQuery' in state)) return undefined;
  const raw: unknown = state.ordersQuery;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const page = value['page'];
  return {
    page: typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: PAGE_SIZES.find((size) => size === value['pageSize']),
    platform: oneOf(PLATFORMS, value['platform']),
    platformStatus: oneOf(PLATFORM_STATUSES, value['platformStatus']),
    rebateStatus: oneOf(REBATE_STATUSES, value['rebateStatus']),
    flag: oneOf(FLAGS, value['flag']),
    q: textOf(value['q']),
    userId: textOf(value['userId']),
    paidFrom: dayOf(value['paidFrom']),
    paidTo: dayOf(value['paidTo']),
  };
}

/** A q as the list sends it: spaces removed, 1–QUERY_MAX characters; else undefined. */
export function cleanQ(value: string): string | undefined {
  const compact = value.replace(/\s/g, '');
  return compact === '' || compact.length > QUERY_MAX ? undefined : compact;
}

function trimmed(value: string | null): string | undefined {
  const text = value?.trim() ?? '';
  return text === '' ? undefined : text;
}

/**
 * The list conditions in an address (F1-07ed): the request parameter names of adminListOrders,
 * with paid_from / paid_to as the Beijing days shown in the form. A value that is not valid
 * (unknown code, not a page size, not a day, not a positive page) counts as not set.
 */
export function queryFromSearch(search: string): OrderQuery {
  const params = new URLSearchParams(search);
  const page = params.get('page');
  const size = params.get('page_size');
  const q = params.get('q');
  return {
    page: page !== null && /^[1-9]\d{0,8}$/.test(page) ? Number(page) : 1,
    pageSize: PAGE_SIZES.find((value) => String(value) === size),
    platform: oneOf(PLATFORMS, params.get('platform')),
    platformStatus: oneOf(PLATFORM_STATUSES, params.get('platform_status')),
    rebateStatus: oneOf(REBATE_STATUSES, params.get('rebate_status')),
    flag: oneOf(FLAGS, params.get('flag')),
    q: q === null ? undefined : cleanQ(q),
    userId: trimmed(params.get('user_id')),
    paidFrom: dayOf(params.get('paid_from')),
    paidTo: dayOf(params.get('paid_to')),
  };
}

/**
 * Whether the pager is shown with an answer (F1-07ed): whenever orders match, also when the asked
 * page is past the last one (no rows, total > 0), so the user can go back or change the page size.
 */
export function showsPager(answer: Pick<OrderPage, 'total'>): boolean {
  return answer.total > 0;
}

/** The address search (with 「?」, or empty) of the list conditions; defaults are left out. */
export function searchOf(query: OrderQuery): string {
  const params = new URLSearchParams();
  const put = (name: string, value: string | undefined) => {
    if (value !== undefined) params.set(name, value);
  };
  put('platform', query.platform);
  put('platform_status', query.platformStatus);
  put('rebate_status', query.rebateStatus);
  put('flag', query.flag);
  put('q', query.q);
  put('user_id', query.userId);
  put('paid_from', query.paidFrom);
  put('paid_to', query.paidTo);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.pageSize !== undefined && query.pageSize !== PAGE_SIZE)
    params.set('page_size', String(query.pageSize));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingParts(iso: string): Date | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : new Date(ms + BEIJING_OFFSET_MS);
}

/** YYYY-MM-DD of a time in Beijing; null shows the dash, unreadable input is shown as is. */
export function beijingDate(iso: string | null): string {
  if (iso === null) return t.dash;
  const date = beijingParts(iso);
  if (date === undefined) return iso;
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/** HH:mm (or HH:mm:ss) of a time in Beijing; null shows the dash. */
export function beijingClock(iso: string | null, seconds = false): string {
  if (iso === null) return t.dash;
  const date = beijingParts(iso);
  if (date === undefined) return iso;
  const base = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
  return seconds ? `${base}:${two(date.getUTCSeconds())}` : base;
}

/** YYYY-MM-DD HH:mm:ss in Beijing; null shows the dash. */
export function beijingTime(iso: string | null): string {
  if (iso === null) return t.dash;
  if (beijingParts(iso) === undefined) return iso;
  return `${beijingDate(iso)} ${beijingClock(iso, true)}`;
}

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals); null (not known) shows the dash. */
export function money(fen: number | null): string {
  if (fen === null) return t.dash;
  return formatYuanAdmin(parseFen(fen));
}

/** Basis points (1/10000) as a percentage with two decimals, integer arithmetic only. */
export function percent(bp: number | null): string {
  if (bp === null || !Number.isSafeInteger(bp)) return t.dash;
  const magnitude = Math.abs(bp);
  const sign = bp < 0 ? '-' : '';
  return `${sign}${Math.trunc(magnitude / 100)}.${two(magnitude % 100)}%`;
}

export const platformLabel = (code: string): string => {
  const known = oneOf(PLATFORMS, code);
  return known === undefined ? (t.platforms[code] ?? code) : platformConfig(known).label;
};

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// The bundled console dictionary (contracts/texts.admin.default.json, BR-TEXT-25). A Vite glob
// keeps the JSON outside this package's TypeScript project while Vite and Vitest inline it.
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

export type DictKind = 'platform_status' | 'rebate_status' | 'hold_reason';

/** The dictionary name of a code (admin_dict.<kind>.<code>), undefined while it has no row. */
export function dictName(kind: DictKind, code: string): string | undefined {
  const key = `admin_dict.${kind}.${code}`;
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

/** 「中文 CODE」 with a dictionary row (BR-TEXT-18 double column), else the code alone. */
export function codeLabel(kind: DictKind, code: string): string {
  const name = dictName(kind, code);
  return name === undefined ? code : `${name} ${code}`;
}

/** antd preset Tag colour by status (the text carries the meaning). */
export function toneOf(code: string): 'success' | 'warning' | 'error' | 'processing' | 'default' {
  if (code === 'SETTLED' || code === 'CREDITED') return 'success';
  if (code === 'UNATTRIBUTED') return 'warning';
  if (code === 'INVALID' || code === 'VOID' || code === 'CLAWED_BACK') return 'error';
  return 'default';
}

export type FailureKind = 'forbidden' | 'invalid' | 'failed';

/** 10403 no permission, 20001 parameters (unknown or not visible for the detail), else failed. */
export function failureOf(cause: unknown): FailureKind {
  if (!(cause instanceof AdminApiError)) return 'failed';
  if (cause.code === 10403) return 'forbidden';
  if (cause.code === 20001) return 'invalid';
  return 'failed';
}

/** A detail address is only a UUID-shaped order_id (/orders/<uuid>). */
export const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- manual order sync (CT-24n adminCreateOrderSync / adminListOrderSyncs / limits) ---------

export type SyncCreateRequest = Schema<'AdminOrderSyncCreateRequest'>;
export type SyncCreated = Schema<'AdminOrderSyncCreated'>;
export type SyncItem = Schema<'AdminOrderSyncListItem'>;
export type SyncPage = Schema<'AdminOrderSyncPage'>;
export type SyncLimit = Schema<'AdminOrderSyncPlatformLimit'>;
export type SyncLimits = Schema<'AdminOrderSyncLimits'>;
export type SyncStatus = Schema<'AdminOrderSyncStatus'>;

export const SYNCS_URL = '/admin/v1/order-syncs';
export const SYNC_LIMITS_URL = '/admin/v1/order-syncs/limits';
/** page_size of the sync records. */
export const SYNC_PAGE_SIZE = 20;
/** The contract's ceiling of order numbers per request (AdminOrderSyncOrderNos). */
export const SYNC_MAX_ORDER_NOS = 50;
/** One order number: 1–64 characters. */
export const ORDER_NO_MAX = 64;

const TYPED_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A typed Beijing time 「YYYY-MM-DD HH:mm」 (seconds optional) as ISO 8601 with the +08:00
 * offset; undefined when it is not a real calendar time.
 */
export function beijingInput(value: string): string | undefined {
  const found = TYPED_TIME.exec(value.trim());
  if (found === null) return undefined;
  const [year, month, day, hour, minute, second] = found
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const ms = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month! - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  )
    return undefined;
  return `${found[1]}-${found[2]}-${found[3]}T${found[4]}:${found[5]}:${two(second!)}+08:00`;
}

/** YYYY-MM-DD HH:mm in Beijing; null shows the dash. */
export function beijingMinute(iso: string | null): string {
  if (iso === null) return t.dash;
  if (beijingParts(iso) === undefined) return iso;
  return `${beijingDate(iso)} ${beijingClock(iso)}`;
}

/**
 * An instant rounded up to the next whole minute (unchanged when already whole), as ISO 8601;
 * an unreadable value comes back as given. The dialog shows and checks the earliest window start
 * with this one value, so the minute it offers is one it accepts.
 */
export function minuteUp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(Math.ceil(ms / 60_000) * 60_000).toISOString();
}

/**
 * The 【同步此单】 notice for a 20001: [platform], or [order_nos] for its one valid number, means
 * the platform cannot be synced by order number (not a format or count problem); else failed.
 */
export function thisOrderRejectedText(fields: readonly string[]): string {
  return fields.includes('platform') || fields.includes('order_nos')
    ? t.sync.thisOrderUnsupported
    : t.sync.failed;
}

/** Order numbers typed one per line (also split on spaces and commas), blanks and repeats dropped. */
export function orderNosOf(text: string): string[] {
  const seen: string[] = [];
  for (const part of text.split(/[\s,，]+/)) {
    if (part !== '' && !seen.includes(part)) seen.push(part);
  }
  return seen;
}

/** The dictionary name of a sync status (admin_dict.order_sync_requests.status.*), else the code. */
export function syncStatusName(code: string): string {
  const key = `admin_dict.order_sync_requests.status.${code}`;
  return Object.hasOwn(dictionary, key) ? dictionary[key]! : code;
}

/** antd preset Tag colour of a sync status. */
export function syncTone(code: string): 'success' | 'error' | 'processing' | 'default' {
  if (code === 'done') return 'success';
  if (code === 'failed') return 'error';
  if (code === 'running') return 'processing';
  return 'default';
}

/** What a manual sync submit came to. */
export type SyncOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'reused' }
  | { readonly kind: 'paused'; readonly platform: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'fields'; readonly fields: readonly string[] }
  | { readonly kind: 'network' }
  | { readonly kind: 'failed' };

/** The outcome of a failed POST /admin/v1/order-syncs. */
export function syncFailureOf(cause: unknown, platform: string): SyncOutcome {
  if (!(cause instanceof AdminApiError)) return { kind: 'failed' };
  if (cause.kind === 'network') return { kind: 'network' };
  if (cause.code === 10403) return { kind: 'forbidden' };
  if (cause.code === 42901 || cause.httpStatus === 429) return { kind: 'rateLimited' };
  if (cause.code === 30156) {
    const data = cause.data;
    const named =
      typeof data === 'object' && data !== null && 'platform' in data
        ? (data as { platform: unknown }).platform
        : undefined;
    return { kind: 'paused', platform: typeof named === 'string' ? named : platform };
  }
  if (cause.code === 20001) {
    const data = cause.data;
    const fields =
      typeof data === 'object' && data !== null && 'fields' in data
        ? (data as { fields: unknown }).fields
        : undefined;
    return {
      kind: 'fields',
      fields: Array.isArray(fields)
        ? fields.filter((one): one is string => typeof one === 'string')
        : [],
    };
  }
  return { kind: 'failed' };
}

/** The dictionary name of a sync mode (admin_dict.order_sync_requests.mode.*), else the code. */
export function syncModeName(code: string): string {
  const key = `admin_dict.order_sync_requests.mode.${code}`;
  return Object.hasOwn(dictionary, key) ? dictionary[key]! : code;
}
