// B1-10i: pure rules of the console's order reads (GET /admin/v1/orders, GET
// /admin/v1/orders/{order_id}; contract adminListOrders / adminGetOrder, CT-24m, CT-24n): the
// flags of a row (status_locked derived from rebate_status), the q normalization, the derived
// unmapped_pending_open and the latest manual hold (方案 K-7). No Nest, no data access.
import type { Schema } from '@couli/contracts-ts';
import { holdsPoint, type AdminFieldAccess } from './admin-claim-view.ts';

/**
 * adminGetOrder (D10-1048 ②; BR-TEXT-08 internal note): last_hold_note, commission_rate_bp and
 * commission_split.reserve_bp are null for an account without order.view; the amounts, the enums
 * and the beneficiaries' shares are untouched.
 */
export function blankAdminOrderDetail(
  detail: Schema<'AdminOrderDetail'>,
  access: AdminFieldAccess,
): Schema<'AdminOrderDetail'> {
  if (holdsPoint(access, 'order.view')) return detail;
  return {
    ...detail,
    last_hold_note: null,
    commission_rate_bp: null,
    commission_split:
      detail.commission_split === null ? null : { ...detail.commission_split, reserve_bp: null },
  };
}

/** The orders columns a row's flags come from. */
export interface AdminOrderFlagSource {
  readonly locked: boolean;
  readonly rights_pending: boolean;
  readonly hold: boolean;
  readonly rebate_status: string;
}

/** One BR-FUND-02 pending record of the same sub-order (order_sync_pending reason and status). */
export interface AdminOrderPendingRecord {
  readonly reason: string;
  readonly status: string;
}

/** The latest manual hold audit record of the order (action order_hold): admin, note and time. */
export interface AdminOrderHoldAudit {
  readonly admin_id: string;
  readonly note: string | null;
  readonly at: Date;
}

export type AdminOrderLastHold = Pick<
  Schema<'AdminOrderDetail'>,
  'last_hold_by' | 'last_hold_by_name' | 'last_hold_note' | 'last_hold_at'
>;

const STATUS_LOCKED: ReadonlySet<string> = new Set(['VOID', 'CREDITED', 'CLAWED_BACK']);
/** Contract AdminOrderQuery: 1–64 characters after trimming and removing inner spaces. */
export const ADMIN_ORDER_QUERY_MAX = 64;
const UNMAPPED_STATUS = 'UNMAPPED_STATUS';

/** locked, rights_pending, hold as stored; status_locked: rebate_status VOID, CREDITED, CLAWED_BACK. */
export function adminOrderFlags(row: AdminOrderFlagSource): Schema<'AdminOrderFlags'> {
  return {
    locked: row.locked,
    status_locked: STATUS_LOCKED.has(row.rebate_status),
    rights_pending: row.rights_pending,
    hold: row.hold,
  };
}

/** q trimmed and with inner spaces removed; null unless 1–64 characters remain. */
export function normalizeOrderQuery(raw: string): string | null {
  const value = raw.trim().replaceAll(' ', '');
  const length = [...value].length;
  return length >= 1 && length <= ADMIN_ORDER_QUERY_MAX ? value : null;
}

/** hold_reason UNMAPPED_STATUS and an UNMAPPED_STATUS record of the sub-order still open. */
export function unmappedPendingOpen(
  holdReason: string | null,
  pending: readonly AdminOrderPendingRecord[],
): boolean {
  return (
    holdReason === UNMAPPED_STATUS &&
    pending.some((record) => record.reason === UNMAPPED_STATUS && record.status === 'open')
  );
}

/** The four last_hold_* fields; all null when never held by hand or held by the system now. */
export function lastManualHold(
  holdReason: string | null,
  audit: AdminOrderHoldAudit | null,
  name: string | null,
): AdminOrderLastHold {
  // 方案 K-7: a current system hold (UNMAPPED_STATUS) shows no manual hold, even an older one.
  if (audit === null || holdReason === UNMAPPED_STATUS) {
    return {
      last_hold_by: null,
      last_hold_by_name: null,
      last_hold_note: null,
      last_hold_at: null,
    };
  }
  return {
    last_hold_by: audit.admin_id,
    last_hold_by_name: name,
    last_hold_note: audit.note,
    last_hold_at: audit.at.toISOString(),
  };
}
