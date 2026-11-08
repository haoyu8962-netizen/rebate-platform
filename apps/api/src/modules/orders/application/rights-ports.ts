import type {
  OrderHoldReason,
  OrderReasonSub,
  OrderRightsStatus,
  OrderRightsType,
} from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

/**
 * Settlement owns these outcomes, the guards, CAS, history and all fund writes. The admin hold /
 * unhold audit is written by orders (B1-09l) after the port answers applied; settlement does not
 * write it.
 */
export type RightsRecordResult = { readonly kind: 'applied' | 'duplicate' | 'not_applicable' };
export type AdminHoldResult = {
  readonly kind: 'applied' | 'not_applicable' | 'same_state' | 'cas_conflict';
};
/** B1-09v: the answer of settlement's 改子原因 (adminSetReasonSub). */
export type AdminReasonSubResult = { readonly kind: 'applied' | 'cas_conflict' };

export interface RightsRecordInput {
  /** Caller holds lockOrderKey and has reread this row FOR UPDATE in trx. */
  readonly before: Selectable<DB['orders']>;
  readonly order_id: string;
  readonly source: 'API' | 'IMPORT';
  readonly type: OrderRightsType;
  readonly status: OrderRightsStatus;
  readonly amount_fen: bigint | null;
  readonly deduction_commission_fen: bigint | null;
  readonly occurred_at: Date;
  readonly platform_rights_no: string | null;
  /** Injected Clock instant, distinct from the platform's occurred_at. */
  readonly now: Date;
  /**
   * B2-04zze: the union's violation text of a PUNISH record as delivered (Taobao / 大淘客
   * violation_type), only for settlement's reason_sub mapping; never stored
   * (FU-REASON-SUB-RAW-BACKFILL). Absent or null: no text.
   */
  readonly violation_type?: string | null | undefined;
  /**
   * B1-09v (08 BR-TEXT-05 子原因 写入来源 ②, D10-819 ①): the sub-reason a punish import was created
   * with, chosen by hand; value null is 「无」 (no sub-reason, still chosen by hand). Stored on the
   * order_rights row (reason_sub_manual true) and, when this record marks the order PUNISH, written
   * to orders.reason_sub with orders.reason_sub_manual instead of the automatic mapping. Absent:
   * not chosen (the row's reason_sub_manual false), the automatic mapping decides.
   * D10-957: `origin` is the import that carries the choice and the admin who created it; when the
   * choice replaces the sub-reason of an order already ended for PUNISH, settlement writes the
   * audit order_reason_sub_set with them (source rights_import).
   */
  readonly manual_reason_sub?: ManualReasonSubInput | undefined;
}

/** B1-09v: a sub-reason chosen by hand (value null is 「无」) and where it came from. */
export interface ManualReasonSubInput {
  readonly value: OrderReasonSub | null;
  /** D10-957: the punish import of the choice; absent only outside an import. */
  readonly origin?: { readonly import_id: string; readonly admin_id: string } | undefined;
}

/** B1-09v: adminSetOrderReasonSub's write (only orders.reason_sub and reason_sub_manual change). */
export interface AdminReasonSubInput {
  /** Caller holds lockOrderKey and has reread this row FOR UPDATE in trx. */
  readonly before: Selectable<DB['orders']>;
  readonly expected_row_version: number;
  /** null: 「无」 (no sub-reason). Belongs to before.reason (checked by the caller). */
  readonly reason_sub: OrderReasonSub | null;
  readonly now: Date;
}

export interface AdminHoldInput {
  /** Caller holds lockOrderKey and has reread this row FOR UPDATE in trx. */
  readonly before: Selectable<DB['orders']>;
  readonly expected_row_version: number;
  readonly reason_code: Exclude<OrderHoldReason, 'UNMAPPED_STATUS'>;
  /** Required operator explanation (orders writes it into its order_hold / order_unhold audit). */
  readonly reason: string;
  /** Authenticated admin id, injected by the caller; never a system unhold. */
  readonly actor: string;
  readonly ip: string | null;
  readonly now: Date;
}

export interface RightsCommandPort {
  /** K-2: dedupe by (app_id, order_id, type, platform_rights_no), NULLS NOT DISTINCT. */
  record(trx: Transaction<DB>, input: RightsRecordInput): Promise<RightsRecordResult>;
}

export interface RebateAdminCommandPort {
  adminHold(trx: Transaction<DB>, input: AdminHoldInput): Promise<AdminHoldResult>;
  adminUnhold(trx: Transaction<DB>, input: AdminHoldInput): Promise<AdminHoldResult>;
}

/** B1-09v: settlement, the writer of orders.reason / reason_sub, implements 改子原因. */
export interface ReasonSubAdminCommandPort {
  adminSetReasonSub(
    trx: Transaction<DB>,
    input: AdminReasonSubInput,
  ): Promise<AdminReasonSubResult>;
}

export interface OrderRightsPorts {
  readonly rights?: RightsCommandPort;
  readonly rebate?: Partial<RebateAdminCommandPort>;
  /** B1-09v: settlement's 改子原因; absent → ORDERS_RIGHTS_PORT_UNAVAILABLE. */
  readonly reasonSub?: Partial<ReasonSubAdminCommandPort>;
}

function unavailable(port: string): Error {
  return new Error(`ORDERS_RIGHTS_PORT_UNAVAILABLE: ${port}`);
}

/**
 * Thin injection points, not transaction owners: no queries, writes, retries or fund guards.
 * Missing method throws ORDERS_RIGHTS_PORT_UNAVAILABLE: <port name> before any side effect.
 * Port failures propagate to the caller for rollback; successful outcomes pass through intact.
 */
export async function recordOrderRights(
  trx: Transaction<DB>,
  ports: OrderRightsPorts | undefined,
  input: RightsRecordInput,
): Promise<RightsRecordResult> {
  const rights = ports?.rights;
  if (rights === undefined || typeof rights.record !== 'function') {
    throw unavailable('rights.record');
  }
  // Called as a method so the settlement instance keeps its `this`; result passes through intact.
  return await rights.record(trx, input);
}

export async function adminHoldOrder(
  trx: Transaction<DB>,
  ports: OrderRightsPorts | undefined,
  input: AdminHoldInput,
): Promise<AdminHoldResult> {
  const rebate = ports?.rebate;
  if (rebate === undefined || typeof rebate.adminHold !== 'function') {
    throw unavailable('rebate.adminHold');
  }
  return await rebate.adminHold(trx, input);
}

export async function adminUnholdOrder(
  trx: Transaction<DB>,
  ports: OrderRightsPorts | undefined,
  input: AdminHoldInput,
): Promise<AdminHoldResult> {
  const rebate = ports?.rebate;
  if (rebate === undefined || typeof rebate.adminUnhold !== 'function') {
    throw unavailable('rebate.adminUnhold');
  }
  return await rebate.adminUnhold(trx, input);
}

/** B1-09v: settlement's 改子原因 (orders never writes orders.reason_sub itself). */
export async function adminSetOrderReasonSub(
  trx: Transaction<DB>,
  ports: OrderRightsPorts | undefined,
  input: AdminReasonSubInput,
): Promise<AdminReasonSubResult> {
  const port = ports?.reasonSub;
  if (port === undefined || typeof port.adminSetReasonSub !== 'function') {
    throw unavailable('reasonSub.adminSetReasonSub');
  }
  return await port.adminSetReasonSub(trx, input);
}
