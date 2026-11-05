// B1-05q: product_pools and pool_items on the primary handle; catalog is their single writer.
// Every statement is scoped by app_id. Admin's audit port and catalog's product_refs write share
// each write transaction. Times are written explicitly from the injected Clock.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type { Catalog } from '../domain/types.ts';
import type {
  PoolAdminReads,
  PoolAdminStore,
  PoolAdminTx,
  PoolItemRow,
  PoolItemWrite,
  PoolRow,
} from '../application/pool-admin.ts';

function reads(db: Kysely<DB>): PoolAdminReads {
  return {
    async pools(appId, status, page, pageSize) {
      let scope = db.selectFrom('product_pools').where('app_id', '=', appId);
      if (status !== undefined) scope = scope.where('status', '=', status);
      const [rows, count] = await Promise.all([
        scope
          .selectAll()
          .orderBy('created_at', 'desc')
          .orderBy('pool_id', 'desc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .execute(),
        scope.select(sql<string>`count(*)`.as('total')).executeTakeFirstOrThrow(),
      ]);
      return { rows, total: Number(count.total) };
    },

    async pool(appId, poolId) {
      const row = await db
        .selectFrom('product_pools')
        .selectAll()
        .where('app_id', '=', appId)
        .where('pool_id', '=', poolId)
        .executeTakeFirst();
      return row ?? null;
    },

    async items(appId, poolId, status, page, pageSize) {
      let scope = db
        .selectFrom('pool_items')
        .where('app_id', '=', appId)
        .where('pool_id', '=', poolId);
      if (status !== undefined) scope = scope.where('status', '=', status);
      const [rows, count] = await Promise.all([
        scope
          .selectAll()
          .orderBy('sort', 'asc')
          .orderBy('product_key', 'asc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .execute(),
        scope.select(sql<string>`count(*)`.as('total')).executeTakeFirstOrThrow(),
      ]);
      return { rows, total: Number(count.total) };
    },

    async item(appId, poolId, productKey) {
      const row = await db
        .selectFrom('pool_items')
        .selectAll()
        .where('app_id', '=', appId)
        .where('pool_id', '=', poolId)
        .where('product_key', '=', productKey)
        .executeTakeFirst();
      return row ?? null;
    },
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort, products: Catalog): PoolAdminTx {
  return {
    async insertPool(row: PoolRow) {
      const inserted = await trx
        .insertInto('product_pools')
        .values(row)
        .onConflict((conflict) => conflict.columns(['app_id', 'pool_id']).doNothing())
        .executeTakeFirst();
      return inserted.numInsertedOrUpdatedRows === 1n;
    },

    async lockPool(appId, poolId) {
      const row = await trx
        .selectFrom('product_pools')
        .selectAll()
        .where('app_id', '=', appId)
        .where('pool_id', '=', poolId)
        .forUpdate()
        .executeTakeFirst();
      return row ?? null;
    },

    updatePool(row: PoolRow) {
      return trx
        .updateTable('product_pools')
        .set({
          name: row.name,
          status: row.status,
          revision: row.revision,
          updated_at: row.updated_at,
        })
        .where('app_id', '=', row.app_id)
        .where('pool_id', '=', row.pool_id)
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async lockItem(appId, poolId, productKey) {
      const rows = await trx
        .selectFrom('pool_items')
        .selectAll()
        .where('app_id', '=', appId)
        .where('product_key', '=', productKey)
        .orderBy('pool_id', 'asc')
        .forUpdate()
        .execute();
      return rows.find((row) => row.pool_id === poolId) ?? null;
    },

    async insertItem(row: PoolItemWrite): Promise<PoolItemRow | null> {
      const inserted = await trx
        .insertInto('pool_items')
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(['app_id', 'pool_id', 'product_key']).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      return inserted ?? null;
    },

    updateItem(row: PoolItemWrite) {
      return trx
        .updateTable('pool_items')
        .set({
          raw_item_id: row.raw_item_id,
          title: row.title,
          image: row.image,
          price_fen: row.price_fen,
          coupon_fen: row.coupon_fen,
          final_price_fen: row.final_price_fen,
          commission_rate_bp: row.commission_rate_bp,
          shop_name: row.shop_name,
          quoted_at: row.quoted_at,
          status: row.status,
          sort: row.sort,
          start_at: row.start_at,
          end_at: row.end_at,
          invalid_reason: row.invalid_reason,
          updated_at: row.updated_at,
        })
        .where('app_id', '=', row.app_id)
        .where('pool_id', '=', row.pool_id)
        .where('product_key', '=', row.product_key)
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async deleteItem(appId, poolId, productKey) {
      const row = await trx
        .deleteFrom('pool_items')
        .where('app_id', '=', appId)
        .where('pool_id', '=', poolId)
        .where('product_key', '=', productKey)
        .returningAll()
        .executeTakeFirst();
      return row ?? null;
    },

    async takeOffline(appId, productKey, reason, now) {
      await trx
        .updateTable('pool_items')
        .set({ status: 'offline', invalid_reason: reason, updated_at: now })
        .where('app_id', '=', appId)
        .where('product_key', '=', productKey)
        .execute();
    },

    registerProductRef: (ref, capabilities) => products.registerProductRef(ref, capabilities),

    audit: (input) => audit.append(input),
  };
}

/** Primary connection only; the pool rows, product_refs and the audit row share one transaction. */
export function createKyselyPoolAdminStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
  catalogOn: (trx: Kysely<DB>) => Catalog,
): PoolAdminStore {
  return {
    ...reads(db),
    transaction: (work) =>
      db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx), catalogOn(trx)))),
  };
}
