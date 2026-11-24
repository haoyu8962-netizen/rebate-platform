// Write entries of the full order detail page (F1-07ee; contracts adminHoldOrder,
// adminUnholdOrder, adminSetOrderReasonSub, adminReassignOrder): which entries an order and an
// account get, the sub-reason groups, the request bodies and how a failed write is read.
// Rules: BR-FUND-06 (hold / unhold only while rebate_status is ESTIMATED or WAITING; an
// UNMAPPED_STATUS hold with its pending record open cannot be released), BR-ATTR-20 / BR-ATTR-31
// (only an unattributed order can be assigned; an attributed one is never moved to another user),
// BR-TEXT-05 (an order with a status this console does not know gets no write entry at all,
// 【同步此单】 included).
import {
  admin_permission,
  display_status,
  order_reason_sub,
  type Schema,
} from '@couli/contracts-ts';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { AdminApiError } from '../../../providers/data/index.ts';
import { codePointLength } from '../../../text-length.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import { PLATFORM_STATUSES, REBATE_STATUSES, orderUrl, type OrderDetail } from '../model.ts';

const r = ordersTexts.writes.result;

export type WriteAction = 'hold' | 'unhold' | 'reason-sub' | 'reassign';
export type StaffHoldReason = Schema<'AdminOrderStaffHoldReason'>;
export type HoldBody = Schema<'AdminOrderHoldRequest'>;
export type UnholdBody = Schema<'AdminOrderUnholdRequest'>;
export type ReasonSubBody = Schema<'AdminOrderReasonSubSetRequest'>;
export type ReasonSubChoice = Schema<'AdminOrderReasonSubChoice'>;
export type AssignBody = Schema<'AdminOrderReassignRequest'>;
type OrderReasonSub = Schema<'OrderReasonSub'>;
type OrderReasonCode = Schema<'OrderReasonCode'>;

export const STEP_UP_URL = '/admin/v1/auth/step-up';
export const STAFF_HOLD_REASONS: readonly StaffHoldReason[] = ['RISK', 'CS'];
export const NONE: Schema<'AdminOrderReasonSubNone'> = 'none';
/** adminHoldOrder / adminUnholdOrder `note`: 1–200 characters. */
export const NOTE_MIN = 1;
export const NOTE_LIMIT = 200;
/** adminReassignOrder `reason`: 5–200 characters (BR-ATTR-20 ③). */
export const ASSIGN_REASON_MIN = 5;
export const ASSIGN_REASON_LIMIT = 200;
/** A write without an answer after this long is aborted; its result is unknown. */
export const WRITE_TIMEOUT_MS = 15_000;
/** A UUID-shaped user id (contract Id). */
export const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function writeUrl(order: Pick<OrderDetail, 'order_id'>, action: WriteAction): string {
  return `${orderUrl(order.order_id)}/${action}`;
}

/**
 * The parent reason of every value of enum order_reason_sub (contracts/enums/order.yaml: PUNISH
 * 12, REFUND 2, RIGHTS 1). Typed as a complete record, so a new contract value cannot be missed;
 * the options of 【原因细分】 come only from this table, never from the shape of a code.
 */
const PARENT_OF = {
  VIOLATION_PROMO: 'PUNISH',
  SHOP_TK: 'PUNISH',
  INSITE_PROMO: 'PUNISH',
  PROXY_BUY: 'PUNISH',
  FAKE_TRADE: 'PUNISH',
  INSITE_RESALE: 'PUNISH',
  OVER_LIMIT: 'PUNISH',
  MARKET_DISRUPT: 'PUNISH',
  MULTI_TRADE_ABNORMAL: 'PUNISH',
  SINGLE_TRADE_ABNORMAL: 'PUNISH',
  RISK_ORDER: 'PUNISH',
  PUNISH_ORDER: 'PUNISH',
  IN_SALE: 'REFUND',
  AFTER_SETTLE: 'REFUND',
  AFTER_SALE: 'RIGHTS',
} as const satisfies Record<OrderReasonSub, OrderReasonCode>;

/** The sub-reasons of a parent reason in contract order; empty when it has none. */
export function subReasonsOf(reason: string | null): OrderReasonSub[] {
  if (reason === null) return [];
  return order_reason_sub.filter((sub) => PARENT_OF[sub] === reason);
}

/** Display of a sub-reason: 「中文 CODE」, the code alone for a value this table lacks. */
export function subReasonLabel(code: string): string {
  const s = ordersTexts.writes.reasonSub;
  return s.label(s.names[code], code);
}

const KNOWN_PLATFORM: ReadonlySet<string> = new Set(PLATFORM_STATUSES);
const KNOWN_REBATE: ReadonlySet<string> = new Set(REBATE_STATUSES);
const KNOWN_DISPLAY: ReadonlySet<string> = new Set(display_status);
/** Statuses from which a manual hold / unhold is accepted (BR-FUND-01 R11, BR-FUND-06). */
const HOLDABLE: ReadonlySet<string> = new Set(['ESTIMATED', 'WAITING']);
/** The risk.* permission points (config.risk is not one of them). */
const RISK_POINTS: readonly string[] = admin_permission.filter((key) => key.startsWith('risk.'));

/**
 * True when every status is a value of this console's enums (BR-TEXT-05): platform_status,
 * rebate_status and display_status (null, an unattributed order's, is known).
 */
export function knownStatuses(
  order: Pick<OrderDetail, 'platform_status' | 'rebate_status' | 'display_status'>,
): boolean {
  return (
    KNOWN_PLATFORM.has(order.platform_status) &&
    KNOWN_REBATE.has(order.rebate_status) &&
    (order.display_status === null || KNOWN_DISPLAY.has(order.display_status))
  );
}

/**
 * A note / reason as it is sent: surrounding whitespace removed. Its length is checked on this
 * very value (whitespace counts for nothing), so what passes the check is what is sent.
 */
export function sentText(value: string): string {
  return value.trim();
}

function lengthWithin(value: string, min: number, max: number): boolean {
  const length = codePointLength(sentText(value));
  return length >= min && length <= max;
}

/** adminHoldOrder / adminUnholdOrder `note` after trimming: 1–200 characters. */
export function noteValid(note: string): boolean {
  return lengthWithin(note, NOTE_MIN, NOTE_LIMIT);
}

/** adminReassignOrder `reason` after trimming: 5–200 characters. */
export function assignReasonValid(reason: string): boolean {
  return lengthWithin(reason, ASSIGN_REASON_MIN, ASSIGN_REASON_LIMIT);
}

/** Phase of a write dialog: editing, request in flight, step-up verifying, or result unknown. */
export type WritePhase = 'editing' | 'sending' | 'verifying' | 'unknown';

/**
 * Whether a write dialog may be closed (【取消】, its close button, Esc): only while editing. Not
 * while sending or verifying, and not while a result is unknown: then only 【重试】 is offered.
 */
export function dialogClosable(phase: WritePhase): boolean {
  return phase === 'editing';
}

/** A write sent once: its body and, after a 动态码, the step-up token it carried. */
export interface SentWrite<B> {
  readonly body: B;
  readonly token?: string;
}

/** A write of an order whose result is unknown, kept until a retry gets a definite answer. */
export type PendingWrite =
  | { readonly action: 'hold' | 'unhold'; readonly sent: SentWrite<HoldBody | UnholdBody> }
  | { readonly action: 'reason-sub'; readonly sent: SentWrite<ReasonSubBody> }
  | { readonly action: 'reassign'; readonly sent: SentWrite<AssignBody> };

// Kept outside the page: a reload (or leaving and coming back) remounts the writes, and the
// order's dialog must come back locked with the same body, not as a new editable one.
const pendingWrites = new Map<string, PendingWrite>();

/** The write of this order whose result is still unknown, if any. */
export function pendingWriteOf(orderId: string): PendingWrite | undefined {
  return pendingWrites.get(orderId);
}

/** The result of this write is unknown: only 【重试】 of the same body may follow. */
export function keepPendingWrite(orderId: string, write: PendingWrite): void {
  pendingWrites.set(orderId, write);
}

/** A definite answer came (success, refusal, 20902, 10003): the order may be written again. */
export function clearPendingWrite(orderId: string): void {
  pendingWrites.delete(orderId);
}

/**
 * Runs `start` with a signal aborted after `ms`; rejects with a TimeoutError once `ms` passed,
 * whether or not the request honoured the signal (a late answer is then ignored).
 */
export function withDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeout = new DOMException('Write timed out', 'TimeoutError');
      controller.abort(timeout);
      reject(timeout);
    }, ms);
  });
  return Promise.race([start(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

export interface WriteEntries {
  readonly hold: boolean;
  readonly unhold: boolean;
  /** 【恢复结算】 shown but greyed out: UNMAPPED_STATUS hold with its pending record open. */
  readonly unholdBlocked: boolean;
  readonly reasonSub: boolean;
  readonly assign: boolean;
}

const NO_ENTRIES: WriteEntries = {
  hold: false,
  unhold: false,
  unholdBlocked: false,
  reasonSub: false,
  assign: false,
};

/** Which write entries this account gets on this order; each one needs its own point. */
export function writeEntriesOf(order: OrderDetail, access: AccessControl): WriteEntries {
  if (!knownStatuses(order)) return NO_ENTRIES;
  const holdable = access.can('order.hold') && HOLDABLE.has(order.rebate_status);
  return {
    hold: holdable && !order.flags.hold,
    unhold: holdable && order.flags.hold,
    unholdBlocked: order.hold_reason === 'UNMAPPED_STATUS' && order.unmapped_pending_open,
    reasonSub: access.can('order.claim') && subReasonsOf(order.reason).length > 0,
    assign: access.can('order.assign') && order.user === null,
  };
}

/**
 * The hold reason the operator's points decide (BR-FUND-06 细则「后台 hold / unhold」): some
 * risk.* without order.claim → RISK; order.claim without risk.* → CS; both or neither (a super
 * admin has both) → undefined, the operator picks one.
 */
export function derivedHoldReason(access: AccessControl): StaffHoldReason | undefined {
  const risk = RISK_POINTS.some((key) => access.can(key));
  const claim = access.can('order.claim');
  if (risk && !claim) return 'RISK';
  if (claim && !risk) return 'CS';
  return undefined;
}

/** What a failed write came to. */
export type WriteFailure =
  /** 20902: the order changed (or the attribution did); read the detail again, never resend. */
  | { readonly kind: 'conflict' }
  /** 10003 with data.tier=totp: verify the 动态码, then resend the same body once. */
  | { readonly kind: 'stepUp' }
  /** Timeout, network failure, unreadable answer or 5xx: the result is unknown. */
  | { readonly kind: 'unknown' }
  /** An explicit refusal: nothing changed, the form may be edited again. */
  | { readonly kind: 'rejected'; readonly message: string };

function field(data: unknown, name: string): unknown {
  return typeof data === 'object' && data !== null && name in data
    ? (data as Record<string, unknown>)[name]
    : undefined;
}

function rejectedText(cause: AdminApiError): string {
  if (cause.code === 10403) return r.forbidden;
  if (cause.code === 42901 || cause.httpStatus === 429) return r.rateLimited;
  if (cause.code === 20001) {
    const reason = field(cause.data, 'reason');
    if (reason === 'target_banned') return r.targetBanned;
    if (reason === 'target_deleting') return r.targetDeleting;
    if (reason === 'target_deleted') return r.targetDeleted;
    const fields = field(cause.data, 'fields');
    if (Array.isArray(fields) && fields.includes('user_id')) return r.unknownUser;
    return r.invalid;
  }
  return r.failed;
}

export function writeFailureOf(cause: unknown): WriteFailure {
  if (!(cause instanceof AdminApiError)) return { kind: 'unknown' };
  if (cause.kind === 'network' || cause.kind === 'parse' || cause.httpStatus >= 500)
    return { kind: 'unknown' };
  if (cause.code === 20902) return { kind: 'conflict' };
  if (cause.code === 10003 && field(cause.data, 'tier') === 'totp') return { kind: 'stepUp' };
  return { kind: 'rejected', message: rejectedText(cause) };
}
