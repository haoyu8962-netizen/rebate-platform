// B1-08l: linking's read port for the shared order projection (orders' OrderLinkReader, used by
// GET /v1/orders, GET /v1/orders/{order_id} and later B3-08). It answers the product registered
// for each link of one app (links.product_key); a link of another app, an unknown link and a
// link without a product all read as null. Read only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { LINK_CODE } from '../infra/link-code.ts';

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

const ATTRIBUTION_LINK_COLUMNS = [
  'link_id',
  'user_id',
  'platform',
  'raw_item_id',
  'product_key',
  'created_at',
  'pid_scene',
  'scene',
  'agent_session_id',
] as const;

/**
 * B1-08zza (BR-ATTR-08 pdd single slot): the link one App registered under an lk, as stored, for
 * orders' buy_type decision and its exact source match. Looked up by (app_id, lk) only (unique
 * links_app_id_lk_key): platform, owner, item and time are returned for orders to judge. An lk
 * outside [0-9a-z]{1,16} names no link and reads as null without a query; otherwise one SELECT on
 * the handle given (orders passes its pipeline transaction), no cache, no write.
 */
export async function readOrderAttributionLink(
  db: Kysely<DB>,
  scope: OrderAttributionLinkScope,
): Promise<OrderAttributionLink | null> {
  if (typeof scope.lk !== 'string' || !LINK_CODE.test(scope.lk)) return null;
  const row = await db
    .withSchema('app')
    .selectFrom('links')
    .select(ATTRIBUTION_LINK_COLUMNS)
    .where('app_id', '=', scope.appId)
    .where('lk', '=', scope.lk)
    .executeTakeFirst();
  return row ?? null;
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
