// B1-10i: the SQL of the console's order reads (tables orders, order_status_history and
// order_sync_pending, all owned by orders). Read only, on the pool handle, always scoped by app_id
// and naming schema app. The list orders by paid_at descending, rows without paid_at last, then
// order_id descending (the server's internal order for the same time). paid_from / paid_to are
// ISO 8601 texts compared as timestamptz in PostgreSQL (no Date is built here).
import type { DB } from '@couli/db';
import { sql, type ExpressionBuilder, type Kysely, type QueryCreator } from 'kysely';
import { orderKeyMatch } from './pipeline-store.ts';

/** The list filters (q already normalised, user_id a UUID, enums checked by the route schema). */
export interface AdminOrderFilter {
  readonly appId: string;
  readonly platform?: string;
  readonly platformStatus?: string;
  readonly rebateStatus?: string;
  readonly flag?: string;
  readonly userId?: string;
  readonly q?: string;
  readonly paidFrom?: string;
  readonly paidTo?: string;
}

/** An orders row as the list reads it. */
export interface AdminOrderRow {
  readonly order_id: string;
  readonly sub_order_id: string;
  readonly parent_order_id: string | null;
  readonly platform: string;
  readonly title: string | null;
  readonly image_url: string | null;
  readonly user_id: string | null;
  readonly paid_at: Date | null;
  readonly pay_amount_fen: bigint | null;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly platform_status: string;
  readonly rebate_status: string;
  readonly hold: boolean;
  readonly hold_reason: string | null;
  readonly locked: boolean;
  readonly rights_pending: boolean;
}

/** An orders row as the detail reads it. */
export interface AdminOrderDetailRow extends AdminOrderRow {
  readonly raw_item_id: string;
  readonly product_key: string | null;
  readonly quantity: number | null;
  readonly refunded_quantity: number | null;
  readonly reason: string | null;
  /** B1-09v: orders.reason_sub and whether it was chosen by hand (08 BR-TEXT-05); always read. */
  readonly reason_sub?: string | null;
  readonly reason_sub_manual?: boolean;
  readonly buy_type: string | null;
  readonly scene_basis: string | null;
  readonly user_basis: string | null;
  readonly is_presale: boolean;
  readonly deposit_paid_at: Date | null;
  readonly received_at: Date | null;
  readonly settled_at: Date | null;
  readonly credited_at: Date | null;
  readonly settle_period: string | null;
  readonly commission_rate_bp: number | null;
  readonly row_version: number;
  readonly link_id: string | null;
  readonly booked_base_fen: bigint | null;
}

export interface AdminOrderHistoryRow {
  readonly field: string;
  readonly from_status: string | null;
  readonly to_status: string;
  readonly event: string;
  readonly source: string;
  readonly at: Date;
}

export interface AdminOrderPendingRow {
  readonly reason: string;
  readonly status: string;
}

export interface AdminOrderReads {
  count(filter: AdminOrderFilter): Promise<number>;
  page(filter: AdminOrderFilter, offset: number, limit: number): Promise<AdminOrderRow[]>;
  /** One order of the app, or undefined. `orderId` must be a UUID. */
  order(appId: string, orderId: string): Promise<AdminOrderDetailRow | undefined>;
  /** The order's history, oldest first (at, then id). */
  history(appId: string, orderId: string): Promise<AdminOrderHistoryRow[]>;
  /** Every pending record of the sub-order (app, platform, sub_order_id), whatever its order_id. */
  pending(appId: string, platform: string, subOrderId: string): Promise<AdminOrderPendingRow[]>;
}

const STATUS_LOCKED = ['VOID', 'CREDITED', 'CLAWED_BACK'] as const;

const LIST_COLUMNS = [
  'order_id',
  'sub_order_id',
  'parent_order_id',
  'platform',
  'title',
  'image_url',
  'user_id',
  'paid_at',
  'pay_amount_fen',
  'est_commission_fen',
  'settle_commission_fen',
  'platform_status',
  'rebate_status',
  'hold',
  'hold_reason',
  'locked',
  'rights_pending',
] as const;

const DETAIL_COLUMNS = [
  ...LIST_COLUMNS,
  'raw_item_id',
  'product_key',
  'quantity',
  'refunded_quantity',
  'reason',
  'reason_sub',
  'reason_sub_manual',
  'buy_type',
  'scene_basis',
  'user_basis',
  'is_presale',
  'deposit_paid_at',
  'received_at',
  'settled_at',
  'credited_at',
  'settle_period',
  'commission_rate_bp',
  'row_version',
  'link_id',
  'booked_base_fen',
] as const;

type OrdersScope = ExpressionBuilder<DB, 'orders'>;

/** Every filter but q (q splits the list in two branches, see `matching`). */
function where(eb: OrdersScope, filter: AdminOrderFilter) {
  const conditions = [eb('app_id', '=', filter.appId)];
  if (filter.platform !== undefined) conditions.push(eb('platform', '=', filter.platform));
  if (filter.platformStatus !== undefined) {
    conditions.push(eb('platform_status', '=', filter.platformStatus));
  }
  if (filter.rebateStatus !== undefined) {
    conditions.push(eb('rebate_status', '=', filter.rebateStatus));
  }
  if (filter.flag === 'locked') conditions.push(eb('locked', '=', true));
  else if (filter.flag === 'rights_pending') conditions.push(eb('rights_pending', '=', true));
  else if (filter.flag === 'hold') conditions.push(eb('hold', '=', true));
  else if (filter.flag === 'status_locked') {
    conditions.push(eb('rebate_status', 'in', STATUS_LOCKED));
  }
  if (filter.userId !== undefined) conditions.push(eb('user_id', '=', filter.userId));
  // A row without paid_at compares as null and so never matches either bound.
  if (filter.paidFrom !== undefined) {
    conditions.push(eb('paid_at', '>=', sql<Date>`${filter.paidFrom}::timestamptz`));
  }
  if (filter.paidTo !== undefined) {
    conditions.push(eb('paid_at', '<', sql<Date>`${filter.paidTo}::timestamptz`));
  }
  return eb.and(conditions);
}

/**
 * B1-09x (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853): the rows of the filter with q, as the UNION ALL of
 * two disjoint branches instead of `sub_order_id = q OR parent_order_id = q` (which no index
 * serves): the sub number through order_keys (orders read by PK; orderKeyMatch), the parent number
 * through orders_parent_order_idx minus the rows whose sub number is q (already in the first
 * branch; sub_order_id is never null), so an order hit both ways is listed once. Same rows as
 * before; count and page read the same source, the order is applied outside.
 */
function matching(db: QueryCreator<DB>, filter: AdminOrderFilter, q: string) {
  const scoped = () =>
    db
      .selectFrom('orders')
      .select([...LIST_COLUMNS])
      .where((eb) => where(eb, filter));
  const bySub = scoped().where((eb) =>
    orderKeyMatch(eb, {
      app_id: filter.appId,
      ...(filter.platform === undefined ? {} : { platform: filter.platform }),
      sub_order_ids: q,
    }),
  );
  const byParent = scoped()
    .where('parent_order_id', 'is not', null)
    .where('parent_order_id', '=', q)
    .where('sub_order_id', '<>', q);
  return bySub.unionAll(byParent).as('o');
}

export function createAdminOrderReads(database: Kysely<DB>): AdminOrderReads {
  const db = database.withSchema('app');
  return {
    async count(filter) {
      const n = sql<number>`count(*)::int`.as('n');
      const row =
        filter.q === undefined
          ? await db
              .selectFrom('orders')
              .select(n)
              .where((eb) => where(eb, filter))
              .executeTakeFirstOrThrow()
          : await db
              .selectFrom(matching(db, filter, filter.q))
              .select(n)
              .executeTakeFirstOrThrow();
      return row.n;
    },

    async page(filter, offset, limit) {
      if (filter.q === undefined) {
        return db
          .selectFrom('orders')
          .select([...LIST_COLUMNS])
          .where((eb) => where(eb, filter))
          .orderBy(sql`${sql.ref('paid_at')} desc nulls last`)
          .orderBy('order_id', 'desc')
          .offset(offset)
          .limit(limit)
          .execute();
      }
      return db
        .selectFrom(matching(db, filter, filter.q))
        .select([...LIST_COLUMNS])
        .orderBy(sql`${sql.ref('paid_at')} desc nulls last`)
        .orderBy('order_id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
    },

    async order(appId, orderId) {
      return db
        .selectFrom('orders')
        .select([...DETAIL_COLUMNS])
        .where('app_id', '=', appId)
        .where('order_id', '=', orderId)
        .executeTakeFirst();
    },

    async history(appId, orderId) {
      return db
        .selectFrom('order_status_history')
        .select(['field', 'from_status', 'to_status', 'event', 'source', 'at'])
        .where('app_id', '=', appId)
        .where('order_id', '=', orderId)
        .orderBy('at', 'asc')
        .orderBy('id', 'asc')
        .execute();
    },

    async pending(appId, platform, subOrderId) {
      return db
        .selectFrom('order_sync_pending')
        .select(['reason', 'status'])
        .where('app_id', '=', appId)
        .where('platform', '=', platform)
        .where('sub_order_id', '=', subOrderId)
        .execute();
    },
  };
}
