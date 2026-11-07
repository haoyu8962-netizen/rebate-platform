// B2-04m: the rows the single-order credit reads and writes itself, all on the caller's
// transaction. settlement owns the rebate columns of orders (rebate_status, booked_base_fen,
// booked_n_fen, row_version / updated_at; BR-FUND-01, BR-FUND-05), order_settlements' seq check
// (BR-FUND-04 ⑦) and beneficiary_credits (BR-FUND-04 ⑫). The order_key advisory lock is orders'
// lockOrderKey; the rebate history rows go through rebate-store.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface OrderLocator {
  readonly platform: string;
  readonly sub_order_id: string;
  readonly attr_at: Date;
}

/**
 * The immutable key columns of one sub-order, read before the advisory lock only to name the lock;
 * everything that decides the credit is re-read after it.
 */
export async function readOrderLocator(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<OrderLocator | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .select(['platform', 'sub_order_id', 'attr_at'])
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
}

/** Greatest order_settlements seq of the sub-order, or null when it has none. */
export async function readLatestSettleSeq(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<number | null> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_settlements')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  const seq: unknown = row?.seq ?? null;
  if (seq === null) return null;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
    throw new Error('settlement credit: order_settlements seq is not an integer');
  }
  return seq;
}

export interface CreditCas {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly from: string;
  readonly to: string;
  readonly row_version: number;
  readonly booked_base_fen: bigint;
  readonly booked_n_fen: bigint;
  readonly at: Date;
}

/**
 * R5 in one statement: rebate_status, the booked pair (BR-FUND-05) and credited_at (the
 * credit time read by the admin detail and the user timeline) together, CAS on
 * (rebate_status, row_version). credited_at and updated_at are the same injected-Clock
 * instant. Returns whether exactly one row matched.
 */
export async function casCreditOrder(trx: Transaction<DB>, cas: CreditCas): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('orders')
    .set({
      rebate_status: cas.to,
      booked_base_fen: cas.booked_base_fen,
      booked_n_fen: cas.booked_n_fen,
      credited_at: cas.at,
      // B1-08zi（D10-814 ④）：入账时已退件数的定格，取同一行当时的 refunded_quantity 列本身；之后不推进。
      refunded_quantity_at_credit: (eb) => eb.ref('refunded_quantity'),
      row_version: cas.row_version + 1,
      updated_at: cas.at,
    })
    .where('app_id', '=', cas.app_id)
    .where('order_id', '=', cas.order_id)
    .where('attr_at', '=', cas.attr_at)
    .where('rebate_status', '=', cas.from)
    .where('row_version', '=', cas.row_version)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export interface FirstCreditObligation {
  readonly beneficiary_credit_id: string;
  readonly app_id: string;
  readonly order_id: string;
  readonly user_id: string;
  readonly role: 'self' | 'share' | 'direct' | 'indirect';
  readonly opened_ref: string;
  readonly split_ref: string;
  readonly opened_at: Date;
}

/** BR-FUND-04 ⑫: one open first_credit obligation, opened by R5 (partial unique index on open). */
export async function insertFirstCreditObligation(
  trx: Transaction<DB>,
  row: FirstCreditObligation,
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
      kind: 'first_credit',
      opened_by: 'R5',
      opened_ref: row.opened_ref,
      origin_ledger_type: null,
      origin_sub_type: null,
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
