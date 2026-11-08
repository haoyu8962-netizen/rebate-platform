// B2-04s: the rows the clawback reads and writes itself, all on the caller's transaction (the
// order_key advisory lock is already held). settlement owns the rebate columns of orders
// (rebate_status, booked pair, reason, diff_reason_code, rights_pending,
// refunded_quantity_r9_baseline, row_version / updated_at; BR-FUND-01), order_rights (written only through settlement, BR-FUND-01), beneficiary_credits
// (BR-FUND-04 ⑫) and settle_adjustments (BR-FUND-09 ②).
import type { OrderReasonSub } from '@couli/contracts-ts';
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
  /**
   * B2-04zzb (BR-FUND-04 ⑫「都关联实际履约的凭证」): a forfeit references the platform voucher this
   * same transaction wrote (the share went to the platform); null when the platform difference was 0
   * and no platform voucher was written (closed_ref then names the event). A void never carries one
   * (beneficiary_credits_voucher_check).
   */
  readonly voucher_id: string | null;
  readonly closed_at: Date;
}

/**
 * open → voided / forfeited with a CAS on (status open, row_version), voucher_id in the same SET;
 * returns whether it matched (an obligation already closed by a replay is not rewritten).
 */
export async function closeObligation(
  trx: Transaction<DB>,
  close: ObligationClose,
): Promise<boolean> {
  if (close.status === 'voided' && close.voucher_id !== null) {
    throw new Error('settlement clawback: a voided obligation carries no voucher');
  }
  const result = await trx
    .withSchema('app')
    .updateTable('beneficiary_credits')
    .set({
      status: close.status,
      closed_by: close.closed_by,
      closed_ref: close.closed_ref,
      closed_at: close.closed_at,
      voucher_id: close.voucher_id,
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
  /** B2-04zze: R8's display sub-reason, written with the reason; undefined → unchanged. */
  readonly reason_sub?: { readonly value: OrderReasonSub | null };
  /**
   * B2-04zk (BR-CALC-15): the R9 whose N_new came from a rights deduction moves the version in
   * this same CAS, with the optimistic guard commission_version = the version read under the lock.
   */
  readonly commission_version?: { readonly from: number; readonly to: number };
  readonly at: Date;
}

/**
 * R8 / R9 / R10 in one statement: rebate_status and the booked pair together (BR-FUND-08), plus
 * B2-04zzf (D10-870): the R9 refund baseline moves to the locked row's own refunded_quantity.
 */
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
      ...(cas.reason_sub === undefined ? {} : { reason_sub: cas.reason_sub.value }),
      ...(cas.commission_version === undefined
        ? {}
        : { commission_version: cas.commission_version.to }),
      // B2-04zzf（D10-870）：本次资金处置所针对的已退件数，取同一行当时的 refunded_quantity 列本身。
      refunded_quantity_r9_baseline: (eb) => eb.ref('refunded_quantity'),
      row_version: key.row_version + 1,
      updated_at: cas.at,
    })
    .where('app_id', '=', key.app_id)
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('rebate_status', '=', key.rebate_status)
    .where('row_version', '=', key.row_version)
    .$if(cas.commission_version !== undefined, (qb) =>
      qb.where('commission_version', '=', cas.commission_version?.from ?? -1),
    )
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) === 1n;
}

/**
 * B2-04zzf (D10-870): the R9 refund baseline alone, for the exits that judged a refund increase but
 * wrote no voucher (R9 positive skip, no change; jd switch off). Same transaction as the sync, CAS on
 * (rebate_status CREDITED, row_version); the value is the locked row's own refunded_quantity.
 */
export async function casRefundBaseline(
  trx: Transaction<DB>,
  key: OrderCasKey,
  at: Date,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({
      refunded_quantity_r9_baseline: (eb) => eb.ref('refunded_quantity'),
      row_version: key.row_version + 1,
      updated_at: at,
    })
    .where('app_id', '=', key.app_id)
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('rebate_status', '=', key.rebate_status)
    .where('row_version', '=', key.row_version)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) === 1n;
}
