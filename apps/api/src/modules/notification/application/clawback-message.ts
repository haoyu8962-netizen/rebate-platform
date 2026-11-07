// B1-12zc (BR-TEXT-09, BR-TEXT-05, BR-TEXT-10, BR-FUND-09 细则; D10-773 方案 C): the CLAWBACK and
// SETTLE_ADJUSTED messages to an order's beneficiaries. One notification consumer,
// `notification-clawback` (queue `evt.notification-clawback`, worker only, concurrency 5), subscribes
// to both order.clawed_back and order.settle_adjusted. Rule-test skeleton: the contract below is
// what test/spec/notification/clawback-message/** and settle-adjusted-message/** pin.
//
// order.clawed_back (settlement clawback-order.ts, R8 / R9): order_id, order_key, rights_event_id,
// transition, reason (R8 only, an order_reason code), beneficiaries [{ user_id, role, clawback_fen
// (positive integer fen as a decimal string) }] — only those clawed back from their available
// balance are listed. One CLAWBACK message per listed beneficiary.
//
// order.settle_adjusted (D10-773 ④, producer booked separately): order_id, order_key, settle_seq
// (integer), sub_type (SETTLE_DIFF / PRICE_PROTECT / PRICE_COMPARE), beneficiaries [{ user_id, role,
// adjust_fen (signed integer fen as a decimal string), bucket }]. Only rows with adjust_fen < 0 and
// bucket user_available send a SETTLE_ADJUSTED message; every other row is ignored.
//
// Variants by role: self → self, share → share, direct / indirect → invite. Titles:
// CLAWBACK self「返利扣回」, share and invite「推广收益扣回」(inbox.title.CLAWBACK.self / .promo);
// SETTLE_ADJUSTED self「返利已调整」, share「推广收益已调整」, invite「推广收益已调整」.
// Bodies (BR-TEXT-09 table; D10-773 ④):
//   CLAWBACK self   「订单返利已扣回 {amount}：{reason.title}」
//   CLAWBACK share  「一笔分享订单的推广收益已扣回 {amount}：{reason.title}」
//   CLAWBACK invite 「一笔邀请订单的推广收益已扣回 {amount}」(no reason, J7)
//   SETTLE_ADJUSTED self   「订单返利已按结算金额调整，减少 {amount}：{reason.title}」
//   SETTLE_ADJUSTED share  「一笔分享订单的推广收益已按结算金额调整，减少 {amount}：{reason.title}」
//   SETTLE_ADJUSTED invite 「一笔推广收益已按结算金额调整，减少 {amount}」(no reason, J7)
// {amount}: CLAWBACK negative (-¥3.2); SETTLE_ADJUSTED the decrease's absolute value (¥3.2), both
// per BR-TEXT-10. {reason.title}: BR-TEXT-05 order_reason.<CODE>.title (CLAWBACK the event's
// reason, SETTLE_ADJUSTED the sub_type). Route: self and share → OrderDetail { order_id }; invite →
// Ledger without parameters (上级隐私: never the order). notify_templates title_override /
// body_override of (app, code, variant) apply independently.
//
// Service category: the inbox message is always written, the push follows the recipient's service
// switch (B1-12o createPushSendCore: record() in the event transaction, dispatch() after the
// commit). notify_logs dedupe keys: CLAWBACK `{order_key}:{user_id}:{role}:CLAWBACK:{rights_event_id}`,
// SETTLE_ADJUSTED `{order_key}:{user_id}:{role}:SETTLE_ADJ:{settle_seq}`.
import type { DB } from '@couli/db';
import { formatYuan, parseFen, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type {
  Clock,
  EventHandler,
  JobPayload,
  ReceivedEvent,
  RootLogger,
} from '../../platform/index.ts';
import type { PushEvent, PushSendCore } from './push-send.ts';

export type DeductionCode = 'CLAWBACK' | 'SETTLE_ADJUSTED';

/** notify_templates variant: self, share, or invite (direct and indirect uplines). */
export type DeductionVariant = 'self' | 'share' | 'invite';

/** In-app jump target {route, params} (contracts/routes.json). */
export interface DeductionRoute {
  readonly route: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** notify_templates title_override / body_override of the app, code and variant. */
export interface DeductionOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

/** One beneficiary row of order.clawed_back, amounts parsed to bigint fen. */
export interface ClawbackFacts {
  readonly order_id: string;
  /** beneficiary_role: self, share, direct or indirect. */
  readonly role: string;
  /** The amount clawed back, integer fen above 0. */
  readonly clawback_fen: bigint;
  /** The event's order_reason code (R8), or null (R9 carries none). */
  readonly reason: string | null;
}

/** One beneficiary row of order.settle_adjusted, amounts parsed to bigint fen. */
export interface SettleAdjustedFacts {
  readonly order_id: string;
  /** beneficiary_role: self, share, direct or indirect. */
  readonly role: string;
  /** Signed integer fen; only a negative amount (a decrease) sends a message. */
  readonly adjust_fen: bigint;
  /** Where the adjustment was booked; only user_available sends a message. */
  readonly bucket: string;
  /** SETTLE_DIFF, PRICE_PROTECT or PRICE_COMPARE. */
  readonly sub_type: string;
}

export interface DeductionMessage {
  readonly code: DeductionCode;
  readonly variant: DeductionVariant;
  readonly category: 'service';
  readonly title: string;
  readonly body: string;
  readonly route: DeductionRoute;
}

export interface OrderDeductionMessageOptions {
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** B1-12o: record() inside the event transaction, dispatch() on the root handle after commit. */
  readonly push: PushSendCore;
}

export interface OrderDeductionMessageConsumer {
  /** The event transaction: render and record inbox + notify_logs (+ push log) per recipient. */
  readonly handle: EventHandler;
  /** After the event transaction committed (root handle): dispatch the event's pushes, if any. */
  dispatch(db: Kysely<DB>, event: ReceivedEvent): Promise<void>;
}

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.notification-clawback`. */
export const ORDER_DEDUCTION_MESSAGE_CONSUMER = 'notification-clawback';

const CLAWED_BACK = 'order.clawed_back';
const SETTLE_ADJUSTED = 'order.settle_adjusted';
/** The only bucket of order.settle_adjusted that sends a message (D10-773 ②④). */
const USER_AVAILABLE = 'user_available';

/** beneficiary_role → variant: the direct and indirect uplines share the invite row. */
const VARIANT_OF_ROLE: Readonly<Record<string, DeductionVariant>> = Object.freeze({
  self: 'self',
  share: 'share',
  direct: 'invite',
  indirect: 'invite',
});

/** inbox.title.<code>.<key> (contracts/texts.default.json); CLAWBACK share and invite read .promo. */
const DEFAULT_TITLES: Readonly<Record<DeductionCode, Readonly<Record<DeductionVariant, string>>>> =
  Object.freeze({
    CLAWBACK: Object.freeze({ self: '返利扣回', share: '推广收益扣回', invite: '推广收益扣回' }),
    SETTLE_ADJUSTED: Object.freeze({
      self: '返利已调整',
      share: '推广收益已调整',
      invite: '推广收益已调整',
    }),
  });

/** BR-TEXT-09 CLAWBACK rows and D10-773 ④ SETTLE_ADJUSTED rows, verbatim; invite has no reason (J7). */
const DEFAULT_BODIES: Readonly<Record<DeductionCode, Readonly<Record<DeductionVariant, string>>>> =
  Object.freeze({
    CLAWBACK: Object.freeze({
      self: '订单返利已扣回 {amount}：{reason.title}',
      share: '一笔分享订单的推广收益已扣回 {amount}：{reason.title}',
      invite: '一笔邀请订单的推广收益已扣回 {amount}',
    }),
    SETTLE_ADJUSTED: Object.freeze({
      self: '订单返利已按结算金额调整，减少 {amount}：{reason.title}',
      share: '一笔分享订单的推广收益已按结算金额调整，减少 {amount}：{reason.title}',
      invite: '一笔推广收益已按结算金额调整，减少 {amount}',
    }),
  });

/** BR-TEXT-05 原因码字典 order_reason.<CODE>.title, verbatim. */
const REASON_TITLES: Readonly<Record<string, string>> = Object.freeze({
  REFUND: '订单已退款或取消',
  PART_REFUND: '部分退款',
  RIGHTS: '发起售后维权，返利取消',
  PUNISH: '订单被联盟判定违规',
  PRICE_COMPARE: '比价订单',
  PRICE_PROTECT: '商家价保退差',
  SETTLE_DIFF: '结算金额调整',
  NOT_TRACKED: '未找到这笔订单的返利记录',
  EXPIRED_CLICK: '下单时链接已过期',
  RELATION_INVALID: '淘宝授权未完成或已失效',
  OTHER_TLJ: '订单归其他推广者',
  BLACKLIST: '订单未通过安全校验',
  PRESALE_UNPAID: '预售尾款未付',
  COMMISSION_ZERO: '返利已取消',
  OTHER: '其他原因',
});

/** A code outside the dictionary reads as OTHER (BR-TEXT-05). */
function reasonTitleOf(code: string | null): string | null {
  if (code === null) return null;
  return Object.hasOwn(REASON_TITLES, code)
    ? (REASON_TITLES[code] as string)
    : (REASON_TITLES['OTHER'] as string);
}

function variantOf(role: string): DeductionVariant | null {
  return Object.hasOwn(VARIANT_OF_ROLE, role) ? (VARIANT_OF_ROLE[role] as DeductionVariant) : null;
}

/** self and share → this order's detail; the uplines → the wallet ledger only (上级隐私). */
function routeOf(variant: DeductionVariant, orderId: string): DeductionRoute {
  return variant === 'invite'
    ? { route: 'Ledger' }
    : { route: 'OrderDetail', params: { order_id: orderId } };
}

/**
 * The template (override or default) with {amount} and {reason.title} filled; the uplines' row never
 * carries a reason, not even through an override. Without a reason the default sentence ends after
 * the amount. Function replacers: the substituted text is taken literally (no `$` patterns).
 */
function compose(
  code: DeductionCode,
  variant: DeductionVariant,
  amount: string,
  reasonCode: string | null,
  orderId: string,
  override: DeductionOverride | null,
): DeductionMessage {
  const reason = variant === 'invite' ? null : reasonTitleOf(reasonCode);
  const title = override?.title_override ?? DEFAULT_TITLES[code][variant];
  let template = override?.body_override ?? DEFAULT_BODIES[code][variant];
  if (reason === null && (override?.body_override ?? null) === null) {
    template = template.replace('：{reason.title}', '');
  }
  const body = template
    .replaceAll('{amount}', () => amount)
    .replaceAll('{reason.title}', () => reason ?? '')
    .replaceAll('{reason}', () => reason ?? '');
  return { code, variant, category: 'service', title, body, route: routeOf(variant, orderId) };
}

/** The CLAWBACK message of one beneficiary; null when the row sends nothing. */
export function renderClawbackMessage(
  facts: ClawbackFacts,
  override: DeductionOverride | null,
): DeductionMessage | null {
  const variant = variantOf(facts.role);
  if (variant === null || facts.clawback_fen <= 0n) return null;
  // BR-TEXT-09 l.611: {amount} in CLAWBACK is the negative format (-¥3.2, BR-TEXT-10).
  const amount = formatYuan(subFen(0n, facts.clawback_fen));
  return compose('CLAWBACK', variant, amount, facts.reason, facts.order_id, override);
}

/** The SETTLE_ADJUSTED message of one beneficiary; null for an increase, zero or not user_available. */
export function renderSettleAdjustedMessage(
  facts: SettleAdjustedFacts,
  override: DeductionOverride | null,
): DeductionMessage | null {
  if (facts.bucket !== USER_AVAILABLE || facts.adjust_fen >= 0n) return null;
  const variant = variantOf(facts.role);
  if (variant === null) return null;
  // D10-773 ④: 「减少 {amount}」 with the decrease's absolute value (BR-TEXT-10).
  const amount = formatYuan(subFen(0n, facts.adjust_fen));
  return compose('SETTLE_ADJUSTED', variant, amount, facts.sub_type, facts.order_id, override);
}

/** One recipient of an event: the push core's lookup fields and the renderer of its message. */
interface Planned {
  readonly user_id: string;
  readonly code: DeductionCode;
  readonly variant: DeductionVariant;
  readonly eventKey: string;
  render(override: DeductionOverride | null): DeductionMessage | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function malformed(name: string): Error {
  return new Error(`notification: invalid ${name} payload`);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function rowsOf(data: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const rows = data['beneficiaries'];
  if (!Array.isArray(rows)) throw malformed(name);
  return rows.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw malformed(name);
    const value = row as Record<string, unknown>;
    if (!isText(value['user_id']) || !isText(value['role'])) throw malformed(name);
    return value;
  });
}

/** A row that would send but names a role outside beneficiary_role is a producer fault. */
function checkedVariant(role: string, name: string): DeductionVariant {
  const variant = variantOf(role);
  if (variant === null) throw malformed(name);
  return variant;
}

/**
 * order.clawed_back (clawback-order.ts): one CLAWBACK per listed beneficiary (only those clawed back
 * from their available balance are listed). R9 carries no reason: it is the partial refund
 * (diff_reason_code PART_REFUND), so its sentence names that reason.
 */
function planClawback(payload: JobPayload): Planned[] {
  const data = payload as Record<string, unknown>;
  const orderId = data['order_id'];
  const orderKey = data['order_key'];
  const rightsEventId = data['rights_event_id'];
  const transition = data['transition'];
  const reason = data['reason'];
  if (
    typeof orderId !== 'string' ||
    !UUID.test(orderId) ||
    !isText(orderKey) ||
    !isText(rightsEventId) ||
    !isText(transition) ||
    (reason !== undefined && !isText(reason))
  ) {
    throw malformed(CLAWED_BACK);
  }
  const reasonCode =
    typeof reason === 'string' ? reason : transition === 'R9' ? 'PART_REFUND' : null;
  return rowsOf(data, CLAWED_BACK).map((row) => {
    const user_id = row['user_id'] as string;
    const role = row['role'] as string;
    if (typeof row['clawback_fen'] !== 'string') throw malformed(CLAWED_BACK);
    const facts: ClawbackFacts = {
      order_id: orderId,
      role,
      clawback_fen: parseFen(row['clawback_fen']),
      reason: reasonCode,
    };
    return {
      user_id,
      code: 'CLAWBACK',
      variant: checkedVariant(role, CLAWED_BACK),
      eventKey: `${orderKey}:${user_id}:${role}:CLAWBACK:${rightsEventId}`,
      render: (override) => renderClawbackMessage(facts, override),
    };
  });
}

/**
 * order.settle_adjusted (D10-773 ④): only rows with adjust_fen < 0 booked to user_available send a
 * SETTLE_ADJUSTED message; every other row is ignored here.
 */
function planSettleAdjusted(payload: JobPayload): Planned[] {
  const data = payload as Record<string, unknown>;
  const orderId = data['order_id'];
  const orderKey = data['order_key'];
  const settleSeq = data['settle_seq'];
  const subType = data['sub_type'];
  if (
    typeof orderId !== 'string' ||
    !UUID.test(orderId) ||
    !isText(orderKey) ||
    typeof settleSeq !== 'number' ||
    !Number.isSafeInteger(settleSeq) ||
    !isText(subType)
  ) {
    throw malformed(SETTLE_ADJUSTED);
  }
  const planned: Planned[] = [];
  for (const row of rowsOf(data, SETTLE_ADJUSTED)) {
    const user_id = row['user_id'] as string;
    const role = row['role'] as string;
    const bucket = row['bucket'];
    if (typeof row['adjust_fen'] !== 'string' || typeof bucket !== 'string') {
      throw malformed(SETTLE_ADJUSTED);
    }
    const facts: SettleAdjustedFacts = {
      order_id: orderId,
      role,
      adjust_fen: parseFen(row['adjust_fen']),
      bucket,
      sub_type: subType,
    };
    if (facts.bucket !== USER_AVAILABLE || facts.adjust_fen >= 0n) continue;
    planned.push({
      user_id,
      code: 'SETTLE_ADJUSTED',
      variant: checkedVariant(role, SETTLE_ADJUSTED),
      eventKey: `${orderKey}:${user_id}:${role}:SETTLE_ADJ:${String(settleSeq)}`,
      render: (override) => renderSettleAdjustedMessage(facts, override),
    });
  }
  return planned;
}

function planOf(event: ReceivedEvent): Planned[] {
  if (event.name === CLAWED_BACK) return planClawback(event.payload);
  if (event.name === SETTLE_ADJUSTED) return planSettleAdjusted(event.payload);
  throw new Error('notification: unexpected event for the clawback / settle adjusted message');
}

async function overrideOf(
  trx: Transaction<DB>,
  appId: string,
  code: DeductionCode,
  variant: DeductionVariant,
): Promise<DeductionOverride | null> {
  const row = await trx
    .withSchema('app')
    .selectFrom('notify_templates')
    .select(['title_override', 'body_override'])
    .where('app_id', '=', appId)
    .where('code', '=', code)
    .where('variant', '=', variant)
    .executeTakeFirst();
  return row ?? null;
}

/** The consumer of order.clawed_back and order.settle_adjusted. */
export function createOrderDeductionMessageConsumer(
  options: OrderDeductionMessageOptions,
): OrderDeductionMessageConsumer {
  // options.clock: the push core stamps its rows with its own Clock; nothing here reads time.
  const { logger, push } = options;
  const log = logger.child({ module: 'notification' });

  async function handle(event: ReceivedEvent, trx: Transaction<DB>): Promise<void> {
    const planned = planOf(event);
    const overrides = new Map<string, DeductionOverride | null>();
    let recorded = 0;
    for (const item of planned) {
      const templateKey = `${item.code}:${item.variant}`;
      let override = overrides.get(templateKey);
      if (override === undefined) {
        override = await overrideOf(trx, event.appId, item.code, item.variant);
        overrides.set(templateKey, override);
      }
      const message = item.render(override);
      if (message === null) continue;
      // inbox + inbox log (dedupe boundary) + push log, all in this transaction (B1-12o).
      await push.record(trx, {
        app_id: event.appId,
        user_id: item.user_id,
        code: message.code,
        variant: message.variant,
        eventKey: item.eventKey,
        title: message.title,
        body: message.body,
        route: { ...message.route },
        category: message.category,
      });
      recorded += 1;
    }
    log.debug(
      {
        consumer: ORDER_DEDUCTION_MESSAGE_CONSUMER,
        eventId: event.eventId,
        event: event.name,
        recipients: recorded,
      },
      'order_deduction_message_recorded',
    );
  }

  async function dispatch(db: Kysely<DB>, event: ReceivedEvent): Promise<void> {
    for (const item of planOf(event)) {
      if (item.render(null) === null) continue;
      const target: PushEvent = {
        app_id: event.appId,
        user_id: item.user_id,
        code: item.code,
        variant: item.variant,
        eventKey: item.eventKey,
        category: 'service',
      };
      await push.dispatch(db, target);
    }
  }

  return { handle, dispatch };
}
