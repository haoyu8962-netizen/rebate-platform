// B1-05zm (S17-c1, D10-891 ①): catalog's read-only shop port for linking's shop conversion. It
// answers which shop a product of the caller's app belongs to from what catalog already holds —
// first the detail cache (an entry counts only when it carries both shop_ref and shop_name), then
// product_refs (shop_id; product_refs has no shop name column, so a row alone answers null). It
// never calls the union, never writes, and a product key of another app is never visible.
// Rule tests: test/spec/catalog/shop-entry/**.
import { RedisUnavailableError, type RedisNamespace } from '../../platform/index.ts';
import type { UnionItemDetail } from '../../union/index.ts';
import { loadItem } from '../infra/product-cache.ts';

/** The shop of a product: the union's shop_ref and shop_name, both non-empty. */
export interface ShopOfAnswer {
  readonly shopRef: string;
  readonly shopName: string;
}

/**
 * shopOf(appId, productKey, itemRef?): the product's shop, or null when catalog holds no shop_ref
 * together with a shop_name for it in that app.
 */
export type ShopOf = (
  appId: string,
  productKey: string,
  itemRef?: string,
) => Promise<ShopOfAnswer | null>;

/** product_refs.shop_id of (app_id, product_key), read only; null when no row or no shop id. */
export interface ShopOfRefs {
  shopIdOf(appId: string, productKey: string): Promise<string | null>;
}

export interface ShopOfOptions {
  /**
   * The PRODUCT_CACHE_NAMESPACE namespace the detail cache writes (`<app_id>:product:<product_key>`),
   * read only; null (no REDIS) reads no cache.
   */
  readonly cache: RedisNamespace | null;
  readonly refs: ShopOfRefs;
}

/** Format version of a detail cache entry (infra/product-cache.ts); another version is a miss. */
const DETAIL_ENTRY_VERSION = 1;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The union detail of `<app_id>:product:<product_key>` as cacheDetailUpstream stored it, read only
 * and whatever its age; an absent, unreadable or other-version entry, or a Redis outage, is null.
 */
async function cachedDetail(
  cache: RedisNamespace,
  appId: string,
  productKey: string,
): Promise<UnionItemDetail | null> {
  let text: string | null;
  try {
    text = await cache.get(`${appId}:product:${productKey}`);
  } catch (error: unknown) {
    if (error instanceof RedisUnavailableError) return null;
    throw error;
  }
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>)['v'] !== DETAIL_ENTRY_VERSION
    ) {
      return null;
    }
    return loadItem((parsed as Record<string, unknown>)['data']);
  } catch {
    return null;
  }
}

export function createShopOf(options: ShopOfOptions): ShopOf {
  const { cache } = options;
  return async (appId, productKey, itemRef) => {
    // The item_ref names the same product of the same app; the cache key needs only the key.
    void itemRef;
    if (cache !== null) {
      const item = await cachedDetail(cache, appId, productKey);
      const shopRef = nonEmpty(item?.shop_ref);
      const shopName = nonEmpty(item?.shop_name);
      if (shopRef !== null && shopName !== null) return { shopRef, shopName };
    }
    // product_refs keeps shop_id but no shop name, so it can never answer { shopRef, shopName }
    // on its own; options.refs is not read until a shop name source exists beside it.
    // TODO(规划/11 §2.3): product_refs 店名来源 — blocked on product_refs 没有店名列
    return null;
  };
}
