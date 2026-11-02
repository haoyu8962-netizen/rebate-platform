// B1-08l: the one order query surface behind GET /v1/orders, GET /v1/orders/{order_id} and, later,
// B3-08's list_my_orders / explain_order. Read only: no table is written here.
//
// Scope (编排者口径 2): app_id + user_id of the subject (token only), rebate_status ≠ UNATTRIBUTED,
// buy_type self | share (a shared order's user_id is the sharer, BR-ATTR-10; referral
// beneficiaries are never the user_id). pay_time = COALESCE(paid_at, deposit_paid_at) orders the
// list (pay_time DESC, order_id DESC) and is what paid_month and the BR-ID-30 visible range
// filter. display_status (BR-FUND-17) and a shared order's is_other_product are derived in the
// application, so the list scans in batches, filters, and fills the page; the cursor names the
// last row examined. Every value returned is already the projection of BR-TEXT-02 细则「订单的
// 检索范围与分享单的投影」: a shared order carries masked_order_no only, and is_other_product=true
// carries no title, image, or product_key.
// B1-10h (J-6): with scope=self and linking's claim-entry reader wired, every page (any cursor or
// filter) also carries claim_entry_pinned (BR-ATTR-17, judged by domain/claim-entry.ts at the one
// clock reading of the request); scope=share and an assembly without the reader leave it out.
// The reader's facts cover [now − 72 hours, now], since an older latest jump-out is never pinned;
// read errors propagate like any other list read (never a silent false, nothing cached).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { chinaDayRange, chinaMonthRange } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { ClaimEntryReader } from '../../linking/index.ts';
import type { Clock } from '../../platform/index.ts';
import { CLAIM_ENTRY_PIN_UNTIL_MS, claimEntryPinned } from '../domain/claim-entry.ts';
import {
  buildTimeline,
  deriveDisplayStatus,
  maskOrderNo,
  matchesStatusGroup,
  orderReasonActions,
  visibleOrderStart,
  type DisplayStatus,
  type DisplayStatusInput,
} from '../domain/query-rules.ts';

export interface OrderSubject {
  app_id: string;
  user_id: string;
}

export interface OrderFilter {
  scope: Schema<'OrderScope'>;
  status_group?: Schema<'OrderStatusGroup'>;
  display_status?: Schema<'OrderDisplayStatus'>;
  platform?: Schema<'PlatformCode'>;
  q?: string;
  paid_month?: string;
  cursor?: string;
  limit?: number;
}

/** BR-AI-07: local +08:00 payment dates, inclusive, across self and share. */
export interface AgentOrderSearch {
  date_from: string;
  date_to: string;
  keyword?: string;
  platform?: Schema<'PlatformCode'>;
  limit?: number;
}

export interface OwnOrderNumberQuery {
  order_no: string;
  platform?: Schema<'PlatformCode'>;
}

/** contracts/agent-stream.schema.json#/$defs/card_order_status (the eight fields only). */
export type AgentOrderItem = Pick<
  Schema<'OrderDetail'>,
  | 'order_id'
  | 'platform'
  | 'title'
  | 'is_other_product'
  | 'display_status'
  | 'reason'
  | 'est_rebate_fen'
  | 'expected_credit_period'
>;

export interface AgentOrderSearchResult {
  orders: AgentOrderItem[];
  total: number;
}

/** The factory guarantees the new methods; legacy HTTP-only injected readers need not. */
export type AgentCapableOrderQueries = OrderQueries &
  Required<Pick<OrderQueries, 'searchForAgent' | 'findOwnByNumber'>>;

export interface OrderFigures {
  b_est: bigint | null;
  est_rebate_fen: bigint | null;
  actual_fen: bigint | null;
  clawback_fen: bigint | null;
  has_clawback: boolean;
  part_clawed_at: string | null;
  viewer_share_held: boolean;
  expected_credit_period: string | null;
  credit_overdue: boolean;
  appeal_pending: boolean;
}

export interface OrderFiguresReader {
  forOrders(
    subject: OrderSubject,
    orderIds: readonly string[],
  ): Promise<ReadonlyMap<string, OrderFigures>>;
}

export interface OrderLinkReader {
  productKeys(
    appId: string,
    linkIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

export interface OrderQueryDeps {
  /** Optional only for legacy direct callers; production must supply linking's raw reader. */
  claimEntry?: ClaimEntryReader;
  db: Kysely<DB>;
  clock: Clock;
  config: ContentReader;
  figures?: OrderFiguresReader;
  links: OrderLinkReader;
}

/** A list query outside the contract (cursor, limit or paid_month): the HTTP layer answers 20001. */
export class OrderQueryError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`orders: invalid ${fields.join(', ')}`);
    this.name = 'OrderQueryError';
    this.fields = fields;
  }
}

/** Contract Limit: default 20, at most 50 (04 §5). */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Rows read per batch while filling a page with application-side filters. */
const MIN_BATCH = 50;
const BATCH_FACTOR = 5;
/** Upper bound of exact order-number candidates looked at before choosing number vs title mode. */
const NUMBER_PROBE_LIMIT = 200;
/** BR-AI-07 订单类工具契约: list_my_orders limit 1–8, default 8. */
const AGENT_DEFAULT_LIMIT = 8;
const AGENT_MAX_LIMIT = 8;
/** Rows read per batch while counting an agent search (total spans every match, not one page). */
const AGENT_BATCH = 200;
/** Upper bound of child orders returned for one own order number. */
const OWN_NUMBER_LIMIT = 200;
const QUERY_MONTHS_KEY = 'order.user_query_months';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UTC instant as the cursor carries it: milliseconds, or microseconds when they are not zero. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3}|\d{6})Z$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const UNKNOWN_FIGURES: Readonly<OrderFigures> = Object.freeze({
  b_est: null,
  est_rebate_fen: null,
  actual_fen: null,
  clawback_fen: null,
  has_clawback: false,
  part_clawed_at: null,
  viewer_share_held: false,
  expected_credit_period: null,
  credit_overdue: false,
  appeal_pending: false,
});

/**
 * Everything unknown: for direct callers without a reader. Every production entry wires settlement's
 * createOrderFiguresReader (app.module).
 */
export function createUnknownOrderFigures(): OrderFiguresReader {
  return {
    forOrders: async (_subject, orderIds) =>
      new Map(orderIds.map((id): [string, OrderFigures] => [id, { ...UNKNOWN_FIGURES }])),
  };
}

/**
 * The month on the timeline's credit_expected node and the Agent order card. BR-FUND-17 row 12 shows
 * no expired month, while the detail's top-level expected_credit_period keeps it; the timeline and
 * the card hide a month only when given null.
 */
export function timelineCreditPeriod(
  figures: Pick<OrderFigures, 'expected_credit_period' | 'credit_overdue'>,
): string | null {
  return figures.credit_overdue ? null : figures.expected_credit_period;
}

const ORDER_COLUMNS = [
  'order_id',
  'platform',
  'title',
  'image_url',
  'quantity',
  'pay_amount_fen',
  'parent_order_id',
  'sub_order_id',
  'product_key',
  'link_id',
  'buy_type',
  'rebate_status',
  'platform_status',
  'hold',
  'rights_pending',
  'booked_base_fen',
  'is_presale',
  'deposit_paid_at',
  'paid_at',
  'received_at',
  'credited_at',
  'reason',
  'is_price_compare',
] as const;

interface OrderRow {
  readonly order_id: string;
  readonly platform: string;
  readonly title: string | null;
  readonly image_url: string | null;
  readonly quantity: number | null;
  readonly pay_amount_fen: bigint | null;
  readonly parent_order_id: string | null;
  readonly sub_order_id: string;
  readonly product_key: string | null;
  readonly link_id: string | null;
  readonly buy_type: string | null;
  readonly rebate_status: string;
  readonly platform_status: string;
  readonly hold: boolean;
  readonly rights_pending: boolean;
  readonly booked_base_fen: bigint | null;
  readonly is_presale: boolean;
  readonly deposit_paid_at: Date | null;
  readonly paid_at: Date | null;
  readonly received_at: Date | null;
  readonly credited_at: Date | null;
  readonly reason: string | null;
  readonly is_price_compare: boolean | null;
  /** pay_time as UTC text with microseconds (cursor precision). */
  readonly pay_key: string;
}

/** One row with everything derived, before it is cut to the summary or detail shape. */
interface OrderView {
  readonly row: OrderRow;
  readonly display_status: DisplayStatus;
  readonly is_other_product: boolean;
  readonly figures: OrderFigures;
}

interface Bounds {
  /** Inclusive lower bounds of pay_time (visible range, month start). */
  readonly from: readonly string[];
  /** Exclusive upper bound of pay_time (next month start). */
  readonly before: string | null;
}

type Cursor = { readonly at: string; readonly id: string };

const payTime = sql<Date>`coalesce(${sql.ref('paid_at')}, ${sql.ref('deposit_paid_at')})`;
const payKey = sql<string>`to_char(${payTime} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function cursorInstant(payKeyText: string): string {
  // Whole milliseconds read as an ordinary ISO instant; a sub-millisecond time keeps microseconds.
  return /\.\d{3}000Z$/.test(payKeyText) ? `${payKeyText.slice(0, -4)}Z` : payKeyText;
}

function encodeCursor(row: OrderRow): string {
  return Buffer.from(JSON.stringify([cursorInstant(row.pay_key), row.order_id]), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new OrderQueryError(['cursor']);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !INSTANT.test(parsed[0]) ||
    Number.isNaN(Date.parse(parsed[0])) ||
    !UUID.test(parsed[1])
  ) {
    throw new OrderQueryError(['cursor']);
  }
  return { at: parsed[0], id: parsed[1] };
}

/** The instant `deltaMs` from `from`, derived without reading the system clock. */
function shifted(from: Date, deltaMs: number): Date {
  const date = structuredClone(from);
  date.setTime(from.getTime() + deltaMs);
  return date;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function fen(value: bigint | null): number | null {
  return value === null ? null : fenToJsonNumber(value);
}

/** Only an absolute http(s) URL reaches the client; anything else is null. */
function absoluteHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
    ? value
    : null;
}

type SummaryBase = Omit<Schema<'OrderSummary'>, 'order_no' | 'masked_order_no'>;
type OrderNumber = { order_no: string } | { masked_order_no: string };

/** Shared projection of one view (BR-TEXT-02 细则「订单号的显示」「预售单的付款金额」). */
function summaryFields(view: OrderView): { base: SummaryBase; number: OrderNumber } {
  const { row, display_status, is_other_product, figures } = view;
  const shown = !is_other_product;
  const orderNo = row.parent_order_id ?? row.sub_order_id;
  const number: OrderNumber =
    row.buy_type === 'share' ? { masked_order_no: maskOrderNo(orderNo) } : { order_no: orderNo };
  const depositStage = row.is_presale && row.platform_status === 'DEPOSIT_PAID';
  return {
    base: {
      order_id: row.order_id,
      platform: row.platform as Schema<'PlatformCode'>,
      title: shown ? row.title : null,
      image_url: shown ? absoluteHttpUrl(row.image_url) : null,
      // No deposit amount column exists: the full pay amount is never shown as already paid.
      pay_amount_fen: display_status === 'DEPOSIT_PAID' ? null : fen(row.pay_amount_fen),
      quantity: row.quantity,
      display_status,
      reason: row.reason as Schema<'OrderReasonCode'> | null,
      est_rebate_fen: fen(figures.est_rebate_fen),
      paid_at: depositStage ? null : iso(row.paid_at),
      is_other_product,
    },
    number,
  };
}

function toSummary(view: OrderView): Schema<'OrderSummary'> {
  const { base, number } = summaryFields(view);
  return { ...base, ...number } as Schema<'OrderSummary'>;
}

/** The card_order_status fields cut from the same projection (no order number, image or date). */
function toAgentItem(view: OrderView): AgentOrderItem {
  const { base } = summaryFields(view);
  return {
    order_id: base.order_id,
    platform: base.platform,
    title: base.title,
    is_other_product: base.is_other_product,
    display_status: base.display_status,
    reason: base.reason,
    est_rebate_fen: base.est_rebate_fen,
    // BR-FUND-17 row 12: same rule as the timeline; the card has no credit_overdue of its own.
    expected_credit_period: timelineCreditPeriod(view.figures),
  };
}

/** pay_time DESC, order_id DESC over rows already read (pay_key is fixed-width UTC text). */
function newerFirst(a: OrderView, b: OrderView): number {
  if (a.row.pay_key !== b.row.pay_key) return a.row.pay_key < b.row.pay_key ? 1 : -1;
  if (a.row.order_id === b.row.order_id) return 0;
  return a.row.order_id.toLowerCase() < b.row.order_id.toLowerCase() ? 1 : -1;
}

/** Application-side list filters; a shared title search never hits another product. */
function acceptsFor(filter: OrderFilter): (view: OrderView) => boolean {
  return (view) =>
    (filter.status_group === undefined ||
      matchesStatusGroup(view.display_status, filter.status_group)) &&
    (filter.display_status === undefined || view.display_status === filter.display_status) &&
    !(filter.scope === 'share' && filter.q !== undefined && view.is_other_product);
}

/**
 * Shared, already projected read surface for HTTP and B3-08; also the Nest provider token. This
 * base answers only when no database is wired (it rejects); createOrderQueries builds the real one.
 */
export class OrderQueries {
  /** Same visibility and projection as list/get; total is counted before limit. */
  searchForAgent?(
    subject: OrderSubject,
    filter: AgentOrderSearch,
  ): Promise<AgentOrderSearchResult> {
    void subject;
    void filter;
    return Promise.reject(new Error('orders: order queries need the database'));
  }

  /** Exact parent/child number on self purchases only; never falls back to title. */
  findOwnByNumber?(subject: OrderSubject, query: OwnOrderNumberQuery): Promise<AgentOrderItem[]> {
    void subject;
    void query;
    return Promise.reject(new Error('orders: order queries need the database'));
  }

  list(subject: OrderSubject, filter: OrderFilter): Promise<Schema<'OrderListData'>> {
    void subject;
    void filter;
    return Promise.reject(new Error('orders: order queries need the database'));
  }

  /** Missing, invisible and outside the retention window all return null. */
  get(subject: OrderSubject, orderId: string): Promise<Schema<'OrderDetail'> | null> {
    void subject;
    void orderId;
    return Promise.reject(new Error('orders: order queries need the database'));
  }
}

class DbOrderQueries extends OrderQueries {
  readonly #deps: OrderQueryDeps;
  readonly #figures: OrderFiguresReader;

  /**
   * BR-AI-07 list_my_orders: pay_time inside [date_from 00:00, date_to + 1 day 00:00) at +08:00 and
   * inside the visible range; scope=self and scope=share each searched exactly as the list does
   * (keyword = the list's q), merged by pay_time DESC, order_id DESC; total counts every match.
   */
  override async searchForAgent(
    subject: OrderSubject,
    filter: AgentOrderSearch,
  ): Promise<AgentOrderSearchResult> {
    const limit = filter.limit ?? AGENT_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_MAX_LIMIT) {
      throw new OrderQueryError(['limit']);
    }
    const from = agentDayRange(filter.date_from, 'date_from');
    const to = agentDayRange(filter.date_to, 'date_to');
    if (filter.date_to < filter.date_from) throw new OrderQueryError(['date_to']);
    const visible = this.#bounds(
      visibleOrderStart(this.#required().clock, await this.#queryMonths(subject.app_id)),
      undefined,
    );
    const bounds: Bounds = { from: [...visible.from, from.start], before: to.end };
    const found: OrderView[] = [];
    let total = 0;
    for (const scope of ['self', 'share'] as const) {
      const scoped: OrderFilter = {
        scope,
        ...(filter.platform === undefined ? {} : { platform: filter.platform }),
        ...(filter.keyword === undefined ? {} : { q: filter.keyword }),
      };
      const part = await this.#scan(subject, scoped, bounds, limit);
      found.push(...part.views);
      total += part.total;
    }
    return { orders: found.sort(newerFirst).slice(0, limit).map(toAgentItem), total };
  }

  /**
   * BR-AI-07 explain_order by order_no: the exact parent or child number among the subject's own
   * self purchases in the visible range (optionally one platform). A shared order, a masked number,
   * a fragment or a title never matches.
   */
  override async findOwnByNumber(
    subject: OrderSubject,
    query: OwnOrderNumberQuery,
  ): Promise<AgentOrderItem[]> {
    const deps = this.#required();
    if (query.order_no === '') return [];
    const bounds = this.#bounds(
      visibleOrderStart(deps.clock, await this.#queryMonths(subject.app_id)),
      undefined,
    );
    const filter: OrderFilter = {
      scope: 'self',
      ...(query.platform === undefined ? {} : { platform: query.platform }),
    };
    const search: SearchMode = { kind: 'number', text: query.order_no };
    const rows = (await this.#scoped(subject, filter, bounds, search)
      .orderBy(payTime, 'desc')
      .orderBy('order_id', 'desc')
      .limit(OWN_NUMBER_LIMIT)
      .execute()) as OrderRow[];
    const views = await this.#views(subject, rows);
    return views.filter((view): view is OrderView => view !== undefined).map(toAgentItem);
  }

  constructor(deps: OrderQueryDeps) {
    super();
    this.#deps = deps;
    this.#figures = deps.figures ?? createUnknownOrderFigures();
  }

  override async list(
    subject: OrderSubject,
    filter: OrderFilter,
  ): Promise<Schema<'OrderListData'>> {
    const deps = this.#required();
    const limit = filter.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new OrderQueryError(['limit']);
    }
    if (filter.paid_month !== undefined && !MONTH.test(filter.paid_month)) {
      throw new OrderQueryError(['paid_month']);
    }
    let after = filter.cursor === undefined ? undefined : decodeCursor(filter.cursor);
    // The request's one clock reading: the visible range and the claim-entry pin share it.
    const now = deps.clock.now();
    const at: Clock = { now: () => shifted(now, 0) };
    const earliest = visibleOrderStart(at, await this.#queryMonths(subject.app_id));
    const bounds = this.#bounds(earliest, filter.paid_month);
    const accepts = acceptsFor(filter);
    const search = await this.#searchMode(subject, filter, bounds, accepts);

    const batch = Math.max(MIN_BATCH, limit * BATCH_FACTOR);
    const items: Schema<'OrderSummary'>[] = [];
    let last: OrderRow | undefined;
    let exhausted = false;
    while (items.length < limit) {
      let query = this.#scoped(subject, filter, bounds, search);
      if (after !== undefined) {
        const { at, id } = after;
        query = query.where(
          sql<boolean>`(${payTime}, ${sql.ref('order_id')}) < (${at}::timestamptz, ${id}::uuid)`,
        );
      }
      const rows = (await query
        .orderBy(payTime, 'desc')
        .orderBy('order_id', 'desc')
        .limit(batch)
        .execute()) as OrderRow[];
      const views = await this.#views(subject, rows);
      let examined = 0;
      for (const [index, row] of rows.entries()) {
        examined += 1;
        last = row;
        const view = views[index];
        if (view !== undefined && accepts(view)) items.push(toSummary(view));
        if (items.length === limit) break;
      }
      if (rows.length < batch && examined === rows.length) {
        exhausted = true;
        break;
      }
      if (last === undefined) break;
      after = { at: cursorInstant(last.pay_key), id: last.order_id };
    }
    const pinned = filter.scope === 'self' ? await this.#claimEntryPinned(subject, now) : undefined;
    return {
      items,
      next_cursor: exhausted || last === undefined ? null : encodeCursor(last),
      earliest_visible_date: earliest,
      ...(pinned === undefined ? {} : { claim_entry_pinned: pinned }),
    };
  }

  override async get(
    subject: OrderSubject,
    orderId: string,
  ): Promise<Schema<'OrderDetail'> | null> {
    const deps = this.#required();
    if (!UUID.test(orderId)) return null;
    const earliest = visibleOrderStart(deps.clock, await this.#queryMonths(subject.app_id));
    const bounds = this.#bounds(earliest, undefined);
    const rows = (await this.#visible(subject, bounds)
      .where('buy_type', 'in', ['self', 'share'])
      .where('order_id', '=', orderId)
      .limit(1)
      .execute()) as OrderRow[];
    const [view] = await this.#views(subject, rows);
    if (view === undefined) return null;
    const { row, display_status, is_other_product, figures } = view;
    const { base, number } = summaryFields(view);
    const historyAt = async (to: 'VOID' | 'CLAWED_BACK'): Promise<string | null> => {
      const found = await deps.db
        .withSchema('app')
        .selectFrom('order_status_history')
        .select('at')
        .where('app_id', '=', subject.app_id)
        .where('order_id', '=', row.order_id)
        .where('field', '=', 'rebate')
        .where('to_status', '=', to)
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return found === undefined ? null : found.at.toISOString();
    };
    const timeline = buildTimeline({
      is_presale: row.is_presale,
      platform_status: row.platform_status as DisplayStatusInput['platform_status'],
      display_status,
      deposit_paid_at: iso(row.deposit_paid_at),
      paid_at: iso(row.paid_at),
      received_at: iso(row.received_at),
      credited_at: iso(row.credited_at),
      expected_credit_period: timelineCreditPeriod(figures),
      invalid_at: display_status === 'INVALID' ? await historyAt('VOID') : null,
      clawed_at: display_status === 'CLAWED_BACK' ? await historyAt('CLAWED_BACK') : null,
      part_clawed_at: figures.part_clawed_at,
    });
    return {
      ...base,
      ...number,
      product_key: is_other_product ? null : row.product_key,
      reason_action: orderReasonActions(base.reason),
      timeline,
      expected_credit_period: figures.expected_credit_period,
      credit_overdue: figures.credit_overdue,
      actual_fen: fen(figures.actual_fen),
      clawback_fen: fen(figures.clawback_fen),
      appeal_pending: figures.appeal_pending,
      is_price_compare: row.is_price_compare,
    } as Schema<'OrderDetail'>;
  }

  #required(): OrderQueryDeps {
    return this.#deps;
  }

  /**
   * Every accepted row of one scope inside the bounds, by the list's own search mode and filters:
   * the newest `keep` views and the count of all of them.
   */
  async #scan(
    subject: OrderSubject,
    filter: OrderFilter,
    bounds: Bounds,
    keep: number,
  ): Promise<{ views: OrderView[]; total: number }> {
    const accepts = acceptsFor(filter);
    const search = await this.#searchMode(subject, filter, bounds, accepts);
    const views: OrderView[] = [];
    let total = 0;
    let after: Cursor | undefined;
    for (;;) {
      let query = this.#scoped(subject, filter, bounds, search);
      if (after !== undefined) {
        const { at, id } = after;
        query = query.where(
          sql<boolean>`(${payTime}, ${sql.ref('order_id')}) < (${at}::timestamptz, ${id}::uuid)`,
        );
      }
      const rows = (await query
        .orderBy(payTime, 'desc')
        .orderBy('order_id', 'desc')
        .limit(AGENT_BATCH)
        .execute()) as OrderRow[];
      for (const view of await this.#views(subject, rows)) {
        if (view === undefined || !accepts(view)) continue;
        total += 1;
        if (views.length < keep) views.push(view);
      }
      const last = rows.at(-1);
      if (rows.length < AGENT_BATCH || last === undefined) break;
      after = { at: cursorInstant(last.pay_key), id: last.order_id };
    }
    return { views, total };
  }

  /**
   * BR-ATTR-17 for the subject at `now`, without any list filter; undefined when no reader is
   * wired. The orders read runs only when the jump-out facts alone would pin, since an order can
   * only take the pin away; it is bounded below by the facts' window start, which no jump-out
   * that counts precedes.
   */
  async #claimEntryPinned(subject: OrderSubject, now: Date): Promise<boolean | undefined> {
    const reader = this.#deps.claimEntry;
    if (reader === undefined) return undefined;
    const from = shifted(now, -CLAIM_ENTRY_PIN_UNTIL_MS);
    const scope = { app_id: subject.app_id, user_id: subject.user_id };
    const facts = await reader.read({ ...scope, from, to: shifted(now, 0) });
    const input = {
      ...scope,
      now,
      logs: facts.logs,
      bindings: facts.bindings,
      latest_order_attr_at: null,
    };
    if (!claimEntryPinned(input)) return false;
    const latest = await this.#deps.db
      .withSchema('app')
      .selectFrom('orders')
      .select('attr_at')
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .where('attr_at', '>=', from)
      .orderBy('attr_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return claimEntryPinned({ ...input, latest_order_attr_at: latest?.attr_at ?? null });
  }

  /** order.user_query_months (BR-ID-30 ⑰): a non-negative whole number, else 0 (unlimited). */
  async #queryMonths(appId: string): Promise<number> {
    const entry = await this.#required().config.configValue(appId, QUERY_MONTHS_KEY);
    const value = entry?.value;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  #bounds(earliest: string | null, paidMonth: string | undefined): Bounds {
    const from: string[] = [];
    if (earliest !== null) from.push(chinaMonthRange(earliest.slice(0, 7)).start);
    if (paidMonth === undefined) return { from, before: null };
    const month = chinaMonthRange(paidMonth);
    from.push(month.start);
    return { from, before: month.end };
  }

  /** The subject's visible, attributed orders with pay_time inside the bounds. */
  #visible(subject: OrderSubject, bounds: Bounds) {
    let query = this.#required()
      .db.withSchema('app')
      .selectFrom('orders')
      .select([...ORDER_COLUMNS, payKey.as('pay_key')])
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .where('rebate_status', '<>', 'UNATTRIBUTED')
      // An order without any payment time has no place in the paid-time order or range.
      .where(sql<boolean>`${payTime} is not null`);
    for (const start of bounds.from) {
      query = query.where(sql<boolean>`${payTime} >= ${start}::timestamptz`);
    }
    if (bounds.before !== null) {
      query = query.where(sql<boolean>`${payTime} < ${bounds.before}::timestamptz`);
    }
    return query;
  }

  #scoped(subject: OrderSubject, filter: OrderFilter, bounds: Bounds, search: SearchMode) {
    let query = this.#visible(subject, bounds).where('buy_type', '=', filter.scope);
    if (filter.platform !== undefined) query = query.where('platform', '=', filter.platform);
    if (search.kind === 'number') {
      const q = search.text;
      query = query.where((eb) =>
        eb.or([eb('parent_order_id', '=', q), eb('sub_order_id', '=', q)]),
      );
    } else if (search.kind === 'title') {
      query = query.where(sql<boolean>`${sql.ref('title')} ilike ${search.pattern}`);
    }
    return query;
  }

  /**
   * BR-TEXT-02 细则「订单的检索范围」: a self-purchase order matches q by its exact parent or child
   * number when any such order passes the other filters; otherwise, and for shared orders always,
   * q is a case-insensitive literal substring of the title.
   */
  async #searchMode(
    subject: OrderSubject,
    filter: OrderFilter,
    bounds: Bounds,
    accepts: (view: OrderView) => boolean,
  ): Promise<SearchMode> {
    if (filter.q === undefined) return { kind: 'none' };
    const title: SearchMode = { kind: 'title', pattern: `%${escapeLike(filter.q)}%` };
    if (filter.scope !== 'self') return title;
    const number: SearchMode = { kind: 'number', text: filter.q };
    const rows = (await this.#scoped(subject, filter, bounds, number)
      .orderBy(payTime, 'desc')
      .orderBy('order_id', 'desc')
      .limit(NUMBER_PROBE_LIMIT)
      .execute()) as OrderRow[];
    const views = await this.#views(subject, rows);
    return views.some((view) => view !== undefined && accepts(view)) ? number : title;
  }

  /** Derive display status, figures and is_other_product for a batch, index-aligned with rows. */
  async #views(
    subject: OrderSubject,
    rows: readonly OrderRow[],
  ): Promise<(OrderView | undefined)[]> {
    if (rows.length === 0) return [];
    const deps = this.#required();
    const figures = await this.#figures.forOrders(
      subject,
      rows.map((row) => row.order_id),
    );
    const linkIds = [
      ...new Set(
        rows
          .filter((row) => row.buy_type === 'share' && row.link_id !== null)
          .map((row) => row.link_id as string),
      ),
    ];
    const products =
      linkIds.length === 0
        ? new Map<string, string | null>()
        : await deps.links.productKeys(subject.app_id, linkIds);
    const creditEnabled = new Map<string, boolean>();
    for (const platform of new Set(rows.map((row) => row.platform))) {
      const entry = await deps.config.configValue(subject.app_id, `credit.enabled.${platform}`);
      creditEnabled.set(platform, entry?.value === true);
    }
    return rows.map((row) => {
      const figure = figures.get(row.order_id) ?? { ...UNKNOWN_FIGURES };
      const status = deriveDisplayStatus({
        rebate_status: row.rebate_status as DisplayStatusInput['rebate_status'],
        platform_status: row.platform_status as DisplayStatusInput['platform_status'],
        hold: row.hold,
        rights_pending: row.rights_pending,
        booked_base_fen: row.booked_base_fen,
        b_est: figure.b_est,
        has_clawback: figure.has_clawback,
        viewer_share_held: figure.viewer_share_held,
        credit_enabled: creditEnabled.get(row.platform) ?? false,
        credit_overdue: figure.credit_overdue,
      });
      if (status === null) return undefined;
      return {
        row,
        display_status: status,
        is_other_product: row.buy_type === 'share' && !sameProduct(row, products),
        figures: figure,
      };
    });
  }
}

/** One +08:00 calendar day of an agent search; a malformed or impossible date is invalid. */
function agentDayRange(date: string, field: string): { start: string; end: string } {
  try {
    return chinaDayRange(date);
  } catch {
    throw new OrderQueryError([field]);
  }
}

type SearchMode =
  | { readonly kind: 'none' }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'title'; readonly pattern: string };

/**
 * is_other_product = the order's product_key differs from the product registered for the shared
 * link_id. Anything unknown (no link, no product on either side, link not found) counts as another
 * product, so the title and image are trimmed (编排者待裁定 4, fail closed).
 */
function sameProduct(row: OrderRow, products: ReadonlyMap<string, string | null>): boolean {
  if (row.link_id === null || row.product_key === null) return false;
  const linked = products.get(row.link_id) ?? null;
  return linked !== null && linked === row.product_key;
}

export function createOrderQueries(deps: OrderQueryDeps): AgentCapableOrderQueries {
  return new DbOrderQueries(deps);
}
