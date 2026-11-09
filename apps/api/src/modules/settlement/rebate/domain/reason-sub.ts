// B2-04zze: orders.reason_sub decided by settlement, the writer of orders.reason, in the same place
// and CAS as the reason (08 BR-TEXT-05「子原因 reason_sub」细则「写入来源 ①」; orchestrator D10-818 ②,
// D10-862, D10-867). Pure: no read, no write, no log. Only the display sub-reason: amounts, the
// parent code, transitions and history are decided elsewhere and never here.
// - reason_sub_manual = true: never written (人工选过的不被自动覆盖).
// - Taobao only; jd / pdd (and any other platform): null under every parent.
// - PUNISH: the violation text matched exactly through specs/reason-sub-map/taobao.csv; unmapped
//   (codes, empty, absent) → PUNISH_ORDER and the caller raises order_reason_sub_unmapped.
// - RIGHTS → AFTER_SALE.
// - REFUND: a sub-reason the caller decided (context.refundSub, null included; B2-04zzs) first;
//   a rights record INVALID_AFTER_SETTLE / REFUND_AFTER_SETTLE → AFTER_SETTLE; a sync that
//   voided the order: platform status before PAID / DEPOSIT_PAID → IN_SALE, SETTLED → AFTER_SETTLE,
//   RECEIVED (or unknown) → null.
// - Any other parent: null (no sub-reason of its own). A sub-reason always belongs to the parent
//   written with it, so a stale one of another parent is replaced.
// - Same parent kept (a terminal PUNISH order receiving a later punishment): only PUNISH_ORDER (or
//   none) is replaced by a more specific mapped PUNISH sub-reason.
import type { OrderReasonSub } from '@couli/contracts-ts';
import { mapViolationType, type ReasonSubMap } from '../../../orders/index.ts';

/** The alert of a violation text the table does not know (D10-862 ①). */
export const REASON_SUB_UNMAPPED_ALERT = 'order_reason_sub_unmapped';

/** The fallback of an unmapped punishment. */
const FALLBACK: OrderReasonSub = 'PUNISH_ORDER';

/** The platform's table; null: the platform has no automatic sub-reason. */
export type ReasonSubMaps = (platform: string) => ReasonSubMap | null;

/** What the event that writes the parent code knows about its cause. */
export interface ReasonSubContext {
  /** The union's violation text of a punishment (absent or null: no text). */
  readonly violationType?: string | null | undefined;
  /** The type of the order_rights record behind the event, when a record is. */
  readonly rightsType?: 'RIGHTS' | 'PUNISH' | 'INVALID_AFTER_SETTLE' | 'REFUND_AFTER_SETTLE';
  /** platform_status before the sync that voided the order (OrderUpdateChange.from_status). */
  readonly fromPlatformStatus?: string | null | undefined;
  /**
   * B2-04zzs (BR-TEXT-05 ①, D10-1169 ③): the REFUND sub-reason the caller decided (Taobao rights by
   * the union's timing → AFTER_SETTLE / IN_SALE / null; a whole-order refund → null). Absent: from
   * the record type and the platform status as before. Still only for Taobao, never over a manual pick.
   */
  readonly refundSub?: OrderReasonSub | null | undefined;
}

/** The order's current display columns. */
export interface ReasonSubRow {
  readonly platform: string;
  readonly reason: string | null;
  readonly reason_sub: string | null;
  readonly reason_sub_manual: boolean;
}

export type ReasonSubDecision =
  | { readonly write: false }
  | {
      readonly write: true;
      readonly value: OrderReasonSub | null;
      /** Set when the value is the PUNISH_ORDER fallback of an unmapped text: alert with it. */
      readonly unmapped: { readonly raw: string | null } | null;
    };

const NO_WRITE: ReasonSubDecision = Object.freeze({ write: false });

function refundSub(context: ReasonSubContext): OrderReasonSub | null {
  if (context.refundSub !== undefined) return context.refundSub;
  if (
    context.rightsType === 'INVALID_AFTER_SETTLE' ||
    context.rightsType === 'REFUND_AFTER_SETTLE'
  ) {
    return 'AFTER_SETTLE';
  }
  switch (context.fromPlatformStatus) {
    case 'PAID':
    case 'DEPOSIT_PAID':
      return 'IN_SALE';
    case 'SETTLED':
      return 'AFTER_SETTLE';
    default:
      return null;
  }
}

/** The sub-reason written with `reason` (the parent code this CAS writes). */
export function reasonSubWithReason(
  row: ReasonSubRow,
  reason: string,
  context: ReasonSubContext,
  maps: ReasonSubMaps,
): ReasonSubDecision {
  if (row.reason_sub_manual) return NO_WRITE;
  const map = maps(row.platform);
  let value: OrderReasonSub | null = null;
  let unmapped: { readonly raw: string | null } | null = null;
  if (map !== null) {
    if (reason === 'PUNISH') {
      const mapping = mapViolationType(map, context.violationType ?? null);
      if (mapping.kind === 'mapped') value = mapping.sub;
      else {
        value = FALLBACK;
        unmapped = { raw: mapping.raw };
      }
    } else if (reason === 'RIGHTS') value = 'AFTER_SALE';
    else if (reason === 'REFUND') value = refundSub(context);
  }
  if (value === row.reason_sub && unmapped === null) return NO_WRITE;
  return { write: true, value, unmapped };
}

/**
 * A later punishment on an order whose parent stays PUNISH (terminal VOID / CLAWED_BACK): a mapped
 * text replaces PUNISH_ORDER or no sub-reason; an unmapped one only fills an empty sub-reason with
 * PUNISH_ORDER. A specific sub-reason, a manual pick or another parent is never touched.
 * mappedOnly (a replayed punishment, same punishment_id, now with a text): only a mapped text
 * refines; an unmapped one writes and alerts nothing (the first delivery already did).
 */
export function reasonSubOnLaterPunish(
  row: ReasonSubRow,
  violationType: string | null | undefined,
  maps: ReasonSubMaps,
  options: { readonly mappedOnly?: boolean } = {},
): ReasonSubDecision {
  if (row.reason_sub_manual || row.reason !== 'PUNISH') return NO_WRITE;
  if (row.reason_sub !== null && row.reason_sub !== FALLBACK) return NO_WRITE;
  const map = maps(row.platform);
  if (map === null) return NO_WRITE;
  const mapping = mapViolationType(map, violationType ?? null);
  if (mapping.kind === 'mapped') return { write: true, value: mapping.sub, unmapped: null };
  if (row.reason_sub !== null || options.mappedOnly === true) return NO_WRITE;
  return { write: true, value: FALLBACK, unmapped: { raw: mapping.raw } };
}
