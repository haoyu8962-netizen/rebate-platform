import type { OrderHoldReason, OrderRightsStatus, OrderRightsType } from '@couli/contracts-ts';
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

export interface OrderRightsPorts {
  readonly rights?: RightsCommandPort;
  readonly rebate?: Partial<RebateAdminCommandPort>;
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
