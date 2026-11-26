// B1-08l: linking's read port for the shared order projection (orders' OrderLinkReader, used by
// GET /v1/orders, GET /v1/orders/{order_id} and later B3-08). It answers the product registered
// for each link of one app (links.product_key); a link of another app, an unknown link and a
// link without a product all read as null. Read only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Linking-owned read port for the shared order projection (HTTP and B3-08). */
export interface OrderLinkProducts {
  productKeys(
    appId: string,
    linkIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

export interface OrderAttributionLinkScope {
  readonly appId: string;
  readonly lk: string;
}

export interface OrderAttributionLink {
  readonly link_id: string;
  readonly user_id: string | null;
  readonly platform: string;
  readonly raw_item_id: string | null;
  readonly product_key: string | null;
  readonly created_at: Date;
  readonly pid_scene: string | null;
  readonly scene: string;
  readonly agent_session_id: string | null;
}

export function readOrderAttributionLink(
  db: Kysely<DB>,
  scope: OrderAttributionLinkScope,
): Promise<OrderAttributionLink | null> {
  void db;
  void scope;
  throw new Error('NotImplemented: readOrderAttributionLink');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createOrderLinkReader(db: Kysely<DB>): OrderLinkProducts {
  return {
    async productKeys(appId, linkIds) {
      const result = new Map<string, string | null>();
      const wanted = [...new Set(linkIds)].filter((id) => UUID.test(id));
      if (wanted.length === 0) return result;
      const rows = await db
        .withSchema('app')
        .selectFrom('links')
        .select(['link_id', 'product_key'])
        .where('app_id', '=', appId)
        .where('link_id', 'in', wanted)
        .execute();
      for (const row of rows) result.set(row.link_id, row.product_key);
      return result;
    },
  };
}
