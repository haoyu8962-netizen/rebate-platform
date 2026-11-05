// B1-05r: PoolReader over product_pools and pool_items (read only; catalog stays their single
// writer through infra/kysely-pool-admin-store.ts and worker/pool-refresh.ts). Every statement is
// scoped by app_id. An aged row or one without a commission rate never leaves here, so the pages
// stay full; no_rebate and an anomalous price are the card entry's to tell.
import type { DB } from '@couli/db';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { Platform } from '../../union/index.ts';
import { createCatalog } from '../application/catalog.ts';
import { poolRawFetchedMs, type PoolCandidate, type PoolReader } from '../application/pool-read.ts';
import { toPlusEight } from '../domain/card.ts';
import type { CatalogConfigReader } from '../ports.ts';

export interface KyselyPoolReaderOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: Pick<CatalogConfigReader, 'configValue'>;
}

const MAX_AGE_KEY = 'pool.max_age_sec';
const FALLBACK_POOL_KEY = 'feed.fallback_pool_id';
/** BR-PRICE-11 pool.max_age_sec default. */
const DEFAULT_MAX_AGE_SEC = 7200;
/** The column is uuid: anything else names no pool, and must not reach the statement. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROW_COLUMNS = [
  'platform',
  'product_key',
  'raw_item_id',
  'title',
  'image',
  'price_fen',
  'coupon_fen',
  'final_price_fen',
  'commission_rate_bp',
  'shop_name',
  'quoted_at',
  'created_at',
] as const;

interface PoolRow {
  readonly platform: string;
  readonly product_key: string;
  readonly raw_item_id: string;
  readonly title: string;
  readonly image: string | null;
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly commission_rate_bp: number | null;
  readonly shop_name: string | null;
  readonly quoted_at: Date;
  readonly created_at: Date;
}

/** The item_ref and link of a pool card carry the raw ID's own age (BR-PROD-05), not quoted_at. */
function candidateOf(appId: string, row: PoolRow): PoolCandidate {
  const platform = row.platform as Platform;
  const rawFetchedAt = toPlusEight(poolRawFetchedMs(row));
  return {
    item: {
      platform,
      title: row.title,
      price_fen: row.price_fen,
      coupon_fen: row.coupon_fen,
      final_price_fen: row.final_price_fen,
      commission_rate_bp: BigInt(row.commission_rate_bp ?? 0),
      quoted_at: toPlusEight(row.quoted_at.getTime()),
      // B1-05za: the card image is the row's own image column; nothing fills it from elsewhere.
      ...(row.image !== null && row.image !== '' ? { main_image_url: row.image } : {}),
      // B1-05zd: likewise the row's own shop_name column, absent when NULL.
      ...(row.shop_name !== null && row.shop_name !== '' ? { shop_name: row.shop_name } : {}),
    },
    ref: {
      appId,
      platform,
      productKey: row.product_key,
      rawItemId: row.raw_item_id,
      rawFetchedAt,
      receivedAt: rawFetchedAt,
      canonicalUrl: null,
      title: row.title,
      shopId: null,
      shopType: null,
      source: 'pool',
    },
  };
}

export function createKyselyPoolReader(options: KyselyPoolReaderOptions): PoolReader {
  const { db, clock, config } = options;
  const catalog = createCatalog({ db, clock, warn: () => undefined });

  /** The oldest quoted_at still shown, as an instant with milliseconds. */
  async function oldestQuote(appId: string, nowMs: number): Promise<RawBuilder<Date>> {
    const value = (await config.configValue(appId, MAX_AGE_KEY))?.value;
    const seconds =
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : DEFAULT_MAX_AGE_SEC;
    return sql<Date>`${toPlusEight(nowMs - seconds * 1000)}::timestamptz`;
  }

  return {
    async page({ appId, poolId, offset, limit }) {
      if (!UUID.test(poolId)) return null;
      const pool = await db
        .withSchema('app')
        .selectFrom('product_pools')
        .select('status')
        .where('app_id', '=', appId)
        .where('pool_id', '=', poolId)
        .executeTakeFirst();
      if (pool?.status !== 'active') return null;
      const now = clock.now();
      const rows = await db
        .withSchema('app')
        .selectFrom('pool_items')
        .select(ROW_COLUMNS)
        .where('app_id', '=', appId)
        .where('pool_id', '=', poolId)
        .where('status', '=', 'online')
        .where('commission_rate_bp', 'is not', null)
        .where('quoted_at', '>=', await oldestQuote(appId, now.getTime()))
        .where((eb) => eb.or([eb('start_at', 'is', null), eb('start_at', '<=', now)]))
        .where((eb) => eb.or([eb('end_at', 'is', null), eb('end_at', '>=', now)]))
        .orderBy('sort', 'asc')
        .orderBy('product_key', 'asc')
        .offset(offset)
        .limit(limit + 1)
        .execute();
      return {
        candidates: rows.slice(0, limit).map((row) => candidateOf(appId, row)),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    },

    async fallbackPoolId(appId) {
      const value = (await config.configValue(appId, FALLBACK_POOL_KEY))?.value;
      return typeof value === 'string' && value !== '' ? value : null;
    },

    async detail(appId, productKey) {
      // A pool stores the resolved key; a client may still hold the one an alias replaced.
      const resolved = await catalog.resolveProductKey(productKey);
      const row = await db
        .withSchema('app')
        .selectFrom('pool_items')
        .select(ROW_COLUMNS)
        .where('app_id', '=', appId)
        .where('product_key', 'in', [productKey, resolved])
        .where('status', '=', 'online')
        .where('commission_rate_bp', 'is not', null)
        .where('quoted_at', '>=', await oldestQuote(appId, clock.now().getTime()))
        .orderBy('quoted_at', 'desc')
        .orderBy('pool_id', 'asc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : candidateOf(appId, row);
    },
  };
}
