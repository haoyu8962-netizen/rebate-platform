// B1-05r: the read side of product pools (contract listPageSectionItems「Fetching product_pool」and
// 「Union fall-back」, BR-PRICE-11, TRADE-12). Rule tests build a reader with createKyselyPoolReader
// and hand it to getSectionItems and getProduct; they never call its methods, so the members below
// are the implementer's to shape. The reader owns the config keys pool.max_age_sec and
// feed.fallback_pool_id. Rule tests: test/spec/catalog/product-pool-read/**.
import type { UnionItemDetail } from '../../union/index.ts';
import type { ProductRef } from '../domain/types.ts';

/**
 * One pool row in the shape the single card entry takes. item.quoted_at is the row's last refresh;
 * ref.rawFetchedAt is when ref.rawItemId was obtained, which goes into the card's item_ref and link.
 * A refresh moves the first and leaves the raw ID, so it never makes the second fresh (BR-PROD-05).
 * item.main_image_url is the row's stored image (B1-05za), absent when the row has none; no other
 * image field is filled.
 */
export interface PoolCandidate {
  readonly item: UnionItemDetail;
  readonly ref: ProductRef;
}

/**
 * When a row's raw ID was obtained, at the latest: a refresh moves quoted_at and leaves the raw ID,
 * so quoted_at alone would make an old ID look fresh; an add or re-check moves it with the raw ID, so
 * created_at alone would hide an old one. The earlier of the two never reads younger than the ID.
 */
export function poolRawFetchedMs(row: {
  readonly created_at: Date;
  readonly quoted_at: Date;
}): number {
  return Math.min(row.created_at.getTime(), row.quoted_at.getTime());
}

export interface PoolPageRequest {
  readonly appId: string;
  readonly poolId: string;
  /** Row offset into the pool's list, the value the cursor records. */
  readonly offset: number;
  /** At most this many rows are read: min(data source limit, 20). */
  readonly limit: number;
}

export interface PoolPage {
  readonly candidates: readonly PoolCandidate[];
  /** The offset of the next page; null when no row remains. */
  readonly nextOffset: number | null;
}

export interface PoolReader {
  /** One page of the pool's rows; null when the pool is missing or disabled (never a throw). */
  page(request: PoolPageRequest): Promise<PoolPage | null>;
  /** feed.fallback_pool_id of the app; null when it is unset. */
  fallbackPoolId(appId: string): Promise<string | null>;
  /** The row a detail falls back to (BR-PRICE-11, TRADE-12); null when no row qualifies. */
  detail(appId: string, productKey: string): Promise<PoolCandidate | null>;
}
