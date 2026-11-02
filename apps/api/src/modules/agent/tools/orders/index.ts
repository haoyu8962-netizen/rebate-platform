// B3-08a · BR-AI-01 / BR-AI-03 / BR-AI-05 / BR-AI-07: list_my_orders and explain_order. Both only
// for a phone-bound user; identity comes from ToolCallContext only. Search scope, own-number match
// and the shared-order projection are done by the orders module (B3-08f) and never redone here.
import type {
  AgentCapableOrderQueries,
  AgentOrderItem,
  AgentOrderSearch,
  OrderSubject,
  OwnOrderNumberQuery,
} from '../../../orders/index.ts';
import type { Clock } from '../../../platform/index.ts';
import { wrapUntrusted } from '../../guard/index.ts';
import type { ToolOutcome, ToolTraceFragment } from '../../orchestrator/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import { claimDraftCard, type ClaimDraftDeps } from '../claim/index.ts';
import { handoffCard, type HandoffDeps } from '../handoff/index.ts';
import type { ToolCallContext, ToolDefinition, ToolHandler } from '../registry/index.ts';
import { parseCalendarDay, plusEightDay } from './dates.ts';

/** Resolves a card_id the model quotes to the order behind an order_status card of this session. */
export interface OrderCardRefs {
  resolve(
    cardId: string,
    ctx: ToolCallContext,
  ): Promise<{ readonly kind: 'order'; readonly orderId: string } | { readonly kind: 'invalid' }>;
}

/** Daily explain_order-by-order_no budget (BR-AI-07 判定 4); false means over the limit. */
export interface OrderNoQuota {
  take(appId: string, userId: string): Promise<boolean>;
}

export interface OrderToolsDeps {
  readonly orders: Pick<AgentCapableOrderQueries, 'searchForAgent' | 'findOwnByNumber' | 'get'>;
  readonly refs: OrderCardRefs;
  readonly quota: OrderNoQuota;
  readonly clock: Clock;
  config(appId: string, key: string): Promise<unknown>;
  readonly claim: ClaimDraftDeps;
  readonly handoff: HandoffDeps;
  cardReference?(ctx: ToolCallContext, index: number): string;
  texts?(appId: string, key: string): Promise<string>;
}

type Platform = NonNullable<AgentOrderSearch['platform']>;

/** Model-facing order entry (BR-AI-05): no status, reason, amount, date, order_id or number. */
interface OrderView {
  readonly card_id?: string;
  readonly platform: string;
  readonly title: string | null;
}

/** Extra trace member (BR-AI-07 T5 template input); never part of modelView. */
interface OrderTraceEntry {
  readonly reason_code: string | null;
  readonly display_status: string;
}

function listToolName(): 'list_my_orders' {
  return 'list_my_orders';
}

function explainToolName(): 'explain_order' {
  return 'explain_order';
}

/** BR-AI-07 订单类工具契约: at most 8 order_status cards, default 8. */
function maxOrders(): number {
  return 8;
}

function maxSpanKey(): string {
  return 'agent.orders.max_span_days';
}

/** BR-AI-07 默认 agent.orders.max_span_days. */
function defaultMaxSpanDays(): number {
  return 90;
}

function maxKeywordLength(): number {
  return 20;
}

/** Same bound as prefill_claim's order_no (its card builder refuses longer numbers). */
function maxOrderNoLength(): number {
  return 64;
}

function maxCardIdLength(): number {
  return 64;
}

function moreOrdersKey(): string {
  return 'agent.notice.more_orders';
}

/** Card frame fallback for clients that cannot render order_status: no amount, date or number. */
function orderStatusFallback(): string {
  return '订单状态请在卡片或订单页查看。';
}

/** Strict pattern; the handler still checks the calendar day (no 02-30). */
function datePattern(): string {
  return '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejected(): ToolOutcome {
  return { kind: 'rejected', modelView: { error: 'invalid_args' } };
}

/** Generic failure view: no message or stack reaches the model. */
function failed(): ToolOutcome {
  return { kind: 'failed', modelView: { error: 'tool_failed' } };
}

/** BR-AI-03: closed schema, no identity field; dates use AgentOrderSearch's own names. */
function listDefinition(platforms: readonly string[]): ToolDefinition {
  return {
    name: listToolName(),
    description:
      '查询当前用户名下按付款日（+08:00）筛选的订单，结果以订单卡片展示。' +
      'date_from、date_to 为闭区间的付款日（YYYY-MM-DD），“昨天”等相对日期按系统提示里的当天日期换算；' +
      'keyword 为商品标题关键词；platform 为平台；limit 为最多返回的笔数。' +
      '不要对订单状态或返利下结论，结论只在卡片上。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['date_from', 'date_to'],
      properties: {
        date_from: { type: 'string', pattern: datePattern() },
        date_to: { type: 'string', pattern: datePattern() },
        keyword: { type: 'string', minLength: 1, maxLength: maxKeywordLength() },
        platform: { type: 'string', enum: [...platforms] },
        limit: { type: 'integer', minimum: 1, maximum: maxOrders() },
      },
    },
  };
}

/**
 * card_id and order_no exactly one; platform only with order_no. Expressed without `required` in
 * sub-schemas (the registry compiles with strictRequired): at least one property; card_id forces a
 * single property; platform forces a second one, which can then only be order_no.
 */
function explainDefinition(platforms: readonly string[]): ToolDefinition {
  return {
    name: explainToolName(),
    description:
      '解释当前用户名下某笔订单的返利状态，结果以卡片展示。二选一：card_id 为本会话已出的订单卡片编号，' +
      '或 order_no 为用户提供的订单号（可原样使用对话中的 <num_k> 占位符），platform 只能与 order_no 一起给。' +
      '不要对订单状态或返利下结论，结论只在卡片上。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        card_id: { type: 'string', minLength: 1, maxLength: maxCardIdLength() },
        order_no: { type: 'string', minLength: 1, maxLength: maxOrderNoLength() },
        platform: { type: 'string', enum: [...platforms] },
      },
      dependentSchemas: {
        card_id: { maxProperties: 1 },
        platform: { minProperties: 2 },
      },
    },
  };
}

function subjectOf(ctx: ToolCallContext, userId: string): OrderSubject {
  return { app_id: ctx.appId, user_id: userId };
}

function platformArg(value: unknown, platforms: readonly string[]): Platform | null {
  return typeof value === 'string' && platforms.includes(value) ? (value as Platform) : null;
}

/** Counted in code points, as the registry's JSON Schema maxLength does. */
function keywordArg(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && [...value].length <= maxKeywordLength()
    ? value
    : null;
}

/** The eight card_order_status fields, copied as given (no value is changed or trimmed). */
function cardFields(source: AgentOrderItem): AgentOrderItem {
  return {
    order_id: source.order_id,
    platform: source.platform,
    title: source.title,
    is_other_product: source.is_other_product,
    display_status: source.display_status,
    reason: source.reason,
    est_rebate_fen: source.est_rebate_fen,
    expected_credit_period: source.expected_credit_period,
  };
}

/**
 * The card cut from the order detail. The detail keeps the month of an overdue order; the card shows
 * no expired month (BR-FUND-17 row 12), as the orders module's own card projection already does.
 */
function detailCardFields(
  detail: AgentOrderItem & { readonly credit_overdue: boolean },
): AgentOrderItem {
  return cardFields({
    ...detail,
    expected_credit_period: detail.credit_overdue ? null : detail.expected_credit_period,
  });
}

function orderStatusCard(entry: AgentOrderItem): UnnumberedCard {
  return {
    type: 'order_status',
    schema_version: 1,
    data: { ...cardFields(entry) },
    fallback_text: orderStatusFallback(),
  };
}

async function dictionaryText(deps: OrderToolsDeps, appId: string, key: string): Promise<string> {
  if (deps.texts === undefined) return key;
  try {
    const text = await deps.texts(appId, key);
    return typeof text === 'string' && text !== '' ? text : key;
  } catch {
    return key;
  }
}

async function moreOrdersNotice(deps: OrderToolsDeps, appId: string): Promise<UnnumberedCard> {
  const key = moreOrdersKey();
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: key, actions: [] },
    fallback_text: await dictionaryText(deps, appId, key),
  };
}

function trace(entries: readonly AgentOrderItem[]): ToolTraceFragment {
  const fragment: ToolTraceFragment & { readonly orders: readonly OrderTraceEntry[] } = {
    orders: entries.map((entry) => ({
      reason_code: entry.reason,
      display_status: entry.display_status,
    })),
  };
  return fragment;
}

/** Title for the model: untrusted text wrapped; a shared other-product order keeps null. */
function modelTitle(entry: AgentOrderItem): string | null {
  return entry.is_other_product || entry.title === null ? null : wrapUntrusted(entry.title);
}

function orderView(
  deps: OrderToolsDeps,
  ctx: ToolCallContext,
  entry: AgentOrderItem,
  index: number,
): OrderView {
  const reference = deps.cardReference;
  return {
    ...(reference === undefined ? {} : { card_id: reference(ctx, index) }),
    platform: entry.platform,
    title: modelTitle(entry),
  };
}

/** Order cards first (index i is order i), then the "more orders" notice when truncated. */
async function orderListOutcome(
  deps: OrderToolsDeps,
  ctx: ToolCallContext,
  entries: readonly AgentOrderItem[],
  total: number,
  limit: number,
): Promise<ToolOutcome> {
  const shown = entries.slice(0, limit);
  const truncated = total > limit || entries.length > limit;
  const cards = shown.map(orderStatusCard);
  if (truncated) cards.push(await moreOrdersNotice(deps, ctx.appId));
  return {
    kind: 'ok',
    modelView: {
      orders: shown.map((entry, index) => orderView(deps, ctx, entry, index)),
      total,
      truncated,
    },
    cards,
    trace: trace(shown),
  };
}

function emptyOutcome(modelView: { readonly error: string }): ToolOutcome {
  return { kind: 'ok', modelView, cards: [], trace: trace([]) };
}

async function readMaxSpanDays(deps: OrderToolsDeps, appId: string): Promise<number> {
  try {
    const value = await deps.config(appId, maxSpanKey());
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : defaultMaxSpanDays();
  } catch {
    // Unreadable setting: the default span.
    return defaultMaxSpanDays();
  }
}

export function createListMyOrdersHandler(deps: OrderToolsDeps): ToolHandler {
  const platforms = deps.claim.platforms;

  async function run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    const userId = ctx.userId;
    if (userId === null || !ctx.phoneBound || !isRecord(args)) return rejected();
    const dateFrom = args['date_from'];
    const dateTo = args['date_to'];
    if (typeof dateFrom !== 'string' || typeof dateTo !== 'string') return rejected();
    const from = parseCalendarDay(dateFrom);
    const to = parseCalendarDay(dateTo);
    if (from === null || to === null || to < from) return rejected();
    if (to > plusEightDay(deps.clock.now())) return rejected();

    const rawKeyword = args['keyword'];
    const keyword = rawKeyword === undefined ? undefined : keywordArg(rawKeyword);
    if (keyword === null) return rejected();
    const rawPlatform = args['platform'];
    const platform = rawPlatform === undefined ? undefined : platformArg(rawPlatform, platforms);
    if (platform === null) return rejected();
    const rawLimit = args['limit'];
    const limit = rawLimit === undefined ? maxOrders() : rawLimit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return rejected();
    if (limit > maxOrders()) return rejected();

    if (to - from > (await readMaxSpanDays(deps, ctx.appId))) return rejected();

    const filter: AgentOrderSearch = {
      date_from: dateFrom,
      date_to: dateTo,
      ...(keyword === undefined ? {} : { keyword }),
      ...(platform === undefined ? {} : { platform }),
      limit,
    };
    let result: Awaited<ReturnType<OrderToolsDeps['orders']['searchForAgent']>>;
    try {
      // Scope, keyword matching and the shared-order projection belong to orders (B3-08f).
      result = await deps.orders.searchForAgent(subjectOf(ctx, userId), filter);
    } catch {
      return failed();
    }
    if (result.orders.length === 0) {
      let card: UnnumberedCard;
      try {
        card = await handoffCard(deps.handoff, ctx.appId);
      } catch {
        return failed();
      }
      return {
        kind: 'ok',
        modelView: { orders: [], total: result.total, truncated: false },
        cards: [card],
        trace: trace([]),
      };
    }
    try {
      return await orderListOutcome(deps, ctx, result.orders, result.total, limit);
    } catch {
      return failed();
    }
  }

  return {
    name: listToolName(),
    definition: listDefinition(platforms),
    audience: 'phone_bound',
    run,
  };
}

/**
 * BR-AI-14: restores every <num_k> token, whole or embedded, from this run's table only (the same
 * rule as prefill_claim). preprocess/redact's restorePlaceholders only restores whole values, so an
 * embedded unknown token would slip through as text; any token missing from the table refuses.
 */
function restoreOrderNo(value: string, table: Readonly<Record<string, string>>): string | null {
  let restored = '';
  let last = 0;
  for (const match of value.matchAll(/<num_[1-9]\d*>/gu)) {
    const token = match[0];
    const raw = Object.hasOwn(table, token) ? table[token] : undefined;
    if (typeof raw !== 'string') return null;
    restored += value.slice(last, match.index) + raw;
    last = match.index + token.length;
  }
  return restored + value.slice(last);
}

/** Format check only: whitespace dropped, non-empty and within the claim card's bound. */
function normalizeOrderNo(value: string): string | null {
  const orderNo = value.replace(/\s+/gu, '');
  return orderNo.length > 0 && orderNo.length <= maxOrderNoLength() ? orderNo : null;
}

export function createExplainOrderHandler(deps: OrderToolsDeps): ToolHandler {
  const platforms = deps.claim.platforms;

  async function byCard(
    cardId: string,
    ctx: ToolCallContext,
    userId: string,
  ): Promise<ToolOutcome> {
    let entry: AgentOrderItem | null;
    try {
      const ref = await deps.refs.resolve(cardId, ctx);
      if (ref.kind !== 'order') return rejected();
      const detail = await deps.orders.get(subjectOf(ctx, userId), ref.orderId);
      entry = detail === null ? null : detailCardFields(detail);
    } catch {
      return failed();
    }
    // Not visible to this user reads the same as missing (BR-AI-03); never a claim draft.
    if (entry === null) return emptyOutcome({ error: 'not_found' });
    return {
      kind: 'ok',
      modelView: orderView(deps, ctx, entry, 0),
      cards: [orderStatusCard(entry)],
      trace: trace([entry]),
    };
  }

  async function byNumber(
    orderNo: string,
    platform: Platform | undefined,
    ctx: ToolCallContext,
    userId: string,
  ): Promise<ToolOutcome> {
    let hits: readonly AgentOrderItem[];
    try {
      // BR-AI-07 判定 4: counted before the lookup; over the limit the lookup does not run.
      if (!(await deps.quota.take(ctx.appId, userId))) {
        return emptyOutcome({ error: 'rate_limited' });
      }
      const query: OwnOrderNumberQuery = {
        order_no: orderNo,
        ...(platform === undefined ? {} : { platform }),
      };
      hits = await deps.orders.findOwnByNumber(subjectOf(ctx, userId), query);
    } catch {
      return failed();
    }
    if (hits.length === 1) {
      const entry = cardFields(hits[0]!);
      return {
        kind: 'ok',
        modelView: orderView(deps, ctx, entry, 0),
        cards: [orderStatusCard(entry)],
        trace: trace([entry]),
      };
    }
    if (hits.length > 1) {
      try {
        return await orderListOutcome(deps, ctx, hits, hits.length, maxOrders());
      } catch {
        return failed();
      }
    }
    // BR-AI-07 判定 3: every miss (missing, unattributed, someone else's, own shared order) reads
    // the same: one claim draft. The card needs a platform; without one nothing is drafted.
    if (platform === undefined) return emptyOutcome({ error: 'platform_required' });
    let card: UnnumberedCard;
    try {
      card = await claimDraftCard(deps.claim, ctx, { platform, orderNo });
    } catch {
      return failed();
    }
    const cards = [card];
    const reference = deps.cardReference;
    return {
      kind: 'ok',
      modelView: reference === undefined ? {} : { card_id: reference(ctx, 0) },
      cards,
      trace: trace([]),
    };
  }

  async function run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    const userId = ctx.userId;
    if (userId === null || !ctx.phoneBound || !isRecord(args)) return rejected();
    const cardId = args['card_id'];
    const value = args['order_no'];
    const rawPlatform = args['platform'];
    if ((cardId === undefined) === (value === undefined)) return rejected();
    if (cardId !== undefined) {
      if (typeof cardId !== 'string' || cardId === '' || rawPlatform !== undefined) {
        return rejected();
      }
      return byCard(cardId, ctx, userId);
    }
    if (typeof value !== 'string') return rejected();
    const platform = rawPlatform === undefined ? undefined : platformArg(rawPlatform, platforms);
    if (platform === null) return rejected();
    // Format first (before any quota or lookup): unknown placeholder, empty or blank → invalid.
    const restored = restoreOrderNo(value, ctx.placeholders);
    if (restored === null) return rejected();
    const orderNo = normalizeOrderNo(restored);
    if (orderNo === null) return rejected();
    return byNumber(orderNo, platform, ctx, userId);
  }

  return {
    name: explainToolName(),
    definition: explainDefinition(platforms),
    audience: 'phone_bound',
    run,
  };
}
