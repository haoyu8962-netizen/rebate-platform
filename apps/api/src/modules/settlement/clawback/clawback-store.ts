// B2-04s: the rows the clawback reads and writes itself, all on the caller's transaction (the
// order_key advisory lock is already held). settlement owns the rebate columns of orders
// (rebate_status, booked pair, reason, diff_reason_code, rights_pending, row_version / updated_at;
// BR-FUND-01), order_rights (written only through settlement, BR-FUND-01), beneficiary_credits
// (BR-FUND-04 ⑫) and settle_adjustments (BR-FUND-09 ②).
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

export type BeneficiaryCreditRow = Selectable<DB['beneficiary_credits']>;

/** Open obligations of one sub-order (BR-FUND-04 ⑫), in a stable order. */
export async function readOpenObligations(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<readonly BeneficiaryCreditRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('beneficiary_credits')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'open')
    .orderBy('beneficiary_credit_id')
    .execute();
}

export interface ObligationClose {
  readonly app_id: string;
  readonly beneficiary_credit_id: string;
  readonly row_version: number;
  readonly status: 'voided' | 'forfeited';
  /** R10 (B2-04zi) only forfeits: voided stays with R8 / R14 (beneficiary_credits_voided_check). */
  readonly closed_by: 'R8' | 'R9' | 'R10';
  readonly closed_ref: string;
  readonly closed_at: Date;
}

/** open → voided / forfeited with a CAS on (status open, row_version); returns whether it matched. */
export async function closeObligation(
  trx: Transaction<DB>,
  close: ObligationClose,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('beneficiary_credits')
    .set({
      status: close.status,
      closed_by: close.closed_by,
      closed_ref: close.closed_ref,
      closed_at: close.closed_at,
      row_version: close.row_version + 1,
    })
    .where('app_id', '=', close.app_id)
    .where('beneficiary_credit_id', '=', close.beneficiary_credit_id)
    .where('status', '=', 'open')
    .where('row_version', '=', close.row_version)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) === 1n;
}

export interface DeferredObligation {
  readonly beneficiary_credit_id: string;
  readonly app_id: string;
  readonly order_id: string;
  readonly user_id: string;
  readonly role: 'self' | 'share' | 'direct' | 'indirect';
  /** The event that deferred the difference: `S{seq}` of the settlement record. */
  readonly opened_ref: string;
  readonly split_ref: string;
  readonly opened_at: Date;
}

/**
 * BR-FUND-04 ⑫ (B2-04zi): one open deferred obligation for a positive difference the negative route
 * of BR-FUND-09 left pending, opened by R10 with its origin SETTLE_ADJUST / SETTLE_DIFF. The partial
 * unique index on open rows refuses a second one for the same (order, beneficiary, role).
 */
export async function insertDeferredObligation(
  trx: Transaction<DB>,
  row: DeferredObligation,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('beneficiary_credits')
    .values({
      beneficiary_credit_id: row.beneficiary_credit_id,
      app_id: row.app_id,
      order_id: row.order_id,
      user_id: row.user_id,
      role: row.role,
      kind: 'deferred',
      opened_by: 'R10',
      opened_ref: row.opened_ref,
      origin_ledger_type: 'SETTLE_ADJUST',
      origin_sub_type: 'SETTLE_DIFF',
      split_ref: row.split_ref,
      status: 'open',
      closed_by: null,
      closed_ref: null,
      voucher_id: null,
      opened_at: row.opened_at,
      closed_at: null,
    })
    .execute();
}

/** BR-FUND-09 ② / 决-10 A: every pending candidate of the order → voided_by_clawback. */
export async function voidPendingCandidates(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .updateTable('settle_adjustments')
    .set((eb) => ({
      status: 'voided_by_clawback',
      decided_at: at,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'pending')
    .execute();
}

/** Whether the order has any order_rights row (BR-FUND-01「R9 与 R9b 的判定」). */
export async function hasOrderRights(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_rights')
    .select('id')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * BR-FUND-08 ③: PROCESSING rights rows → WAIT_COMMISSION (only `rightsId` when given, else every
 * PROCESSING row of the order).
 */
export async function markRightsWaitCommission(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  rightsId: string | null,
  at: Date,
): Promise<void> {
  let query = trx
    .withSchema('app')
    .updateTable('order_rights')
    .set((eb) => ({
      status: 'WAIT_COMMISSION',
      row_version: eb('row_version', '+', 1),
      updated_at: at,
    }))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'PROCESSING');
  if (rightsId !== null) query = query.where('id', '=', rightsId);
  await query.execute();
}

/** rights_pending per BR-FUND-01: some order_rights row is PROCESSING or WAIT_COMMISSION. */
export async function computeRightsPending(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_rights')
    .select('id')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', 'in', ['PROCESSING', 'WAIT_COMMISSION'])
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export interface OrderCasKey {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly rebate_status: string;
  readonly row_version: number;
}

/** rights_pending only, CAS on (rebate_status, row_version); returns whether it matched. */
export async function casRightsPending(
  trx: Transaction<DB>,
  key: OrderCasKey,
  rightsPending: boolean,
  at: Date,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({ rights_pending: rightsPending, row_version: key.row_version + 1, updated_at: at })
    .where('app_id', '=', key.app_id)
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('rebate_status', '=', key.rebate_status)
    .where('row_version', '=', key.row_version)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) === 1n;
}

export interface ClawbackCas {
  readonly to: string;
  readonly booked_base_fen: bigint;
  readonly booked_n_fen: bigint;
  /** R8: the order reason code; R9: unchanged (undefined). */
  readonly reason?: string;
  /** R9: PART_REFUND; R8: unchanged (undefined). */
  readonly diff_reason_code?: string;
  readonly at: Date;
}

/** R8 / R9 in one statement: rebate_status and the booked pair together (BR-FUND-08). */
export async function casClawbackOrder(
  trx: Transaction<DB>,
  key: OrderCasKey,
  cas: ClawbackCas,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({
      rebate_status: cas.to,
      booked_base_fen: cas.booked_base_fen,
      booked_n_fen: cas.booked_n_fen,
      ...(cas.reason === undefined ? {} : { reason: cas.reason }),
      ...(cas.diff_reason_code === undefined ? {} : { diff_reason_code: cas.diff_reason_code }),
      row_version: key.row_version + 1,
      updated_at: cas.at,
    })
    .where('app_id', '=', key.app_id)
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('rebate_status', '=', key.rebate_status)
    .where('row_version', '=', key.row_version)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) === 1n;
}
