// Data access of catalog, the single writer of platforms, product_refs, product_key_aliases and
// category_blocklist (04 §3.2; 02 §4.1). Only this file issues SQL for the catalog module.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { CategoryRule, PlatformRecord, ProductRef } from '../domain/types.ts';

export interface CatalogStore {
  listPlatforms(): Promise<PlatformRecord[]>;
  findPlatform(code: string): Promise<PlatformRecord | null>;
  /** new_key of the alias whose old_key is `key`, or null (old_key is the primary key). */
  nextAlias(key: string): Promise<string | null>;
  /**
   * One conditional upsert: inserts the row, or overwrites every mutable column only when the
   * stored refreshed_at is strictly older (BR-PROD-05). An equal or newer row is kept as is.
   * A write without canonical_url keeps the stored one: only parse knows it (BR-PROD-05).
   * A write without shop_id keeps the stored one too (B1-05zm): not every answer carries it.
   * The statement takes the row lock itself, so concurrent writers serialise on the row and the
   * newest response wins whatever the commit order.
   */
  upsertProductRef(ref: ProductRef, now: Date): Promise<void>;
  readProductRef(appId: string, platform: string, productKey: string): Promise<ProductRef | null>;
  /** Active category_blocklist rows of one app (status 'active'; other statuses are disabled). */
  activeCategoryRules(appId: string): Promise<CategoryRule[]>;
}

const PLATFORM_COLUMNS = [
  'code',
  'key_prefix',
  'key_stability',
  'search_support',
  'convert_support',
  'order_sync_support',
  'stage',
] as const;

type PlatformRow = Pick<DB['platforms'], (typeof PLATFORM_COLUMNS)[number]>;

function toPlatformRecord(row: PlatformRow): PlatformRecord {
  // key_stability is constrained by platforms_key_stability_check to the four values.
  return { ...row, key_stability: row.key_stability as PlatformRecord['key_stability'] };
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

export function createKyselyCatalogStore(db: Kysely<DB>): CatalogStore {
  return {
    async listPlatforms(): Promise<PlatformRecord[]> {
      const rows = await db.selectFrom('platforms').select(PLATFORM_COLUMNS).execute();
      return rows.map(toPlatformRecord);
    },

    async findPlatform(code: string): Promise<PlatformRecord | null> {
      const row = await db
        .selectFrom('platforms')
        .select(PLATFORM_COLUMNS)
        .where('code', '=', code)
        .executeTakeFirst();
      return row === undefined ? null : toPlatformRecord(row);
    },

    async nextAlias(key: string): Promise<string | null> {
      const row = await db
        .selectFrom('product_key_aliases')
        .select('new_key')
        .where('old_key', '=', key)
        .executeTakeFirst();
      return row?.new_key ?? null;
    },

    async upsertProductRef(ref: ProductRef, now: Date): Promise<void> {
      await db
        .insertInto('product_refs')
        .values({
          app_id: ref.appId,
          product_key: ref.productKey,
          platform: ref.platform,
          raw_item_id: ref.rawItemId,
          raw_fetched_at: ref.rawFetchedAt,
          canonical_url: ref.canonicalUrl,
          title: ref.title,
          shop_id: ref.shopId,
          shop_type: ref.shopType,
          source: ref.source,
          refreshed_at: ref.receivedAt,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['app_id', 'product_key'])
            .doUpdateSet((eb) => ({
              raw_item_id: eb.ref('excluded.raw_item_id'),
              raw_fetched_at: eb.ref('excluded.raw_fetched_at'),
              canonical_url: sql<
                string | null
              >`COALESCE(excluded.canonical_url, product_refs.canonical_url)`,
              title: eb.ref('excluded.title'),
              // B1-05zm (S17-c1): a response without a shop id keeps the stored one.
              shop_id: sql<string | null>`COALESCE(excluded.shop_id, product_refs.shop_id)`,
              shop_type: eb.ref('excluded.shop_type'),
              source: eb.ref('excluded.source'),
              refreshed_at: eb.ref('excluded.refreshed_at'),
              updated_at: eb.ref('excluded.updated_at'),
            }))
            .where(
              sql<boolean>`product_refs.refreshed_at < excluded.refreshed_at
                AND product_refs.platform = excluded.platform`,
            ),
        )
        .execute();
    },

    async readProductRef(
      appId: string,
      platform: string,
      productKey: string,
    ): Promise<ProductRef | null> {
      const row = await db
        .selectFrom('product_refs')
        .select([
          'app_id',
          'platform',
          'product_key',
          'raw_item_id',
          'raw_fetched_at',
          'refreshed_at',
          'canonical_url',
          'title',
          'shop_id',
          'shop_type',
          'source',
        ])
        .where('app_id', '=', appId)
        .where('product_key', '=', productKey)
        .where('platform', '=', platform)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        appId: row.app_id,
        platform: row.platform as ProductRef['platform'],
        productKey: row.product_key,
        rawItemId: row.raw_item_id,
        rawFetchedAt: iso(row.raw_fetched_at),
        receivedAt: iso(row.refreshed_at),
        canonicalUrl: row.canonical_url,
        title: row.title,
        shopId: row.shop_id,
        shopType: row.shop_type,
        // product_refs_source_check limits the column to the four sources.
        source: row.source as ProductRef['source'],
      };
    },

    async activeCategoryRules(appId: string): Promise<CategoryRule[]> {
      const rows = await db
        .selectFrom('category_blocklist')
        .select(['platform', 'category_id', 'keyword'])
        .where('app_id', '=', appId)
        .where('status', '=', 'active')
        .execute();
      return rows.map((row) => ({
        platform: row.platform,
        categoryId: row.category_id,
        keyword: row.keyword,
      }));
    },
  };
}
