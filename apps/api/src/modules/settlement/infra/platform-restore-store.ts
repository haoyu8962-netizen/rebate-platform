// B2-09gb: the rows the platform restore (BR-FUND-22 R12 / R13; contracts/openapi.yaml
// restoreAdminReconDiff, platform_restore) reads and writes itself, all on the caller's transaction.
// settlement owns the rebate columns of orders and the rebate rows of order_status_history
// (BR-FUND-01); orders' own rows are only read here (the sub-order an order key names).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface PlatformRestoreOrderLocator {
  readonly order_id: string;
  readonly attr_at: Date;
}

/** The app's sub-order of (platform, sub_order_id); undefined when the app has none. No lock. */
export async function findOrderOfKey(
  trx: Transaction<DB>,
  appId: string,
  platform: string,
  subOrderId: string,
): Promise<PlatformRestoreOrderLocator | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .select(['order_id', 'attr_at'])
    .where('app_id', '=', appId)
    .where('platform', '=', platform)
    .where('sub_order_id', '=', subOrderId)
    .executeTakeFirst();
}

/**
 * The id of the rebate-history row by which the order entered `rebateStatus` (the latest row of
 * field rebate with that to_status); undefined when there is none. Read under the order key's lock.
 */
export async function readRebateEntryId(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  rebateStatus: string,
): Promise<bigint | undefined> {
  const row = await trx
    .withSchema('app')
    .selectFrom('order_status_history')
    .select('id')
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('field', '=', 'rebate')
    .where('to_status', '=', rebateStatus)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.id;
}

export interface AdminRebateStep {
  readonly from: string;
  readonly event: string;
  readonly to: string;
}

/** One rebate-history row of a transition made by an admin (source admin), at `at`. */
export async function insertAdminRebateHistory(
  trx: Transaction<DB>,
  order: { readonly app_id: string; readonly order_id: string },
  step: AdminRebateStep,
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_status_history')
    .values({
      app_id: order.app_id,
      order_id: order.order_id,
      field: 'rebate',
      from_status: step.from,
      event: step.event,
      to_status: step.to,
      source: 'admin',
      at,
    })
    .execute();
}
