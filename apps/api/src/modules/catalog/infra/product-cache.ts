// B1-05g: search page and product detail cache (BR-PROD-07, BR-PRICE-11) as decorators of the
// use cases' upstream ports. The cache holds the union's normalized public data only (title,
// price, coupon, commission rate, quoted_at, the raw IDs needed to look the item up again) plus
// fetched_at, the server receipt instant of the union response. Cards, quotes, links and item_refs
// are assembled per request by the callers, never cached. B1-05zf: the card source fields the union
// gave (shop_name, category_l1_id / _name, main_image_url, image_urls) are kept as is; absent ones
// stay absent, and a stored one of the wrong type makes the entry unreadable (a miss).
//   hit:    now − fetched_at ≤ search.cache_ttl_sec (default 300 s), quoted_at unchanged;
//   stale:  on a union dependency failure, an entry with now − fetched_at ≤
//           search.cache.stale_max_age_s (default 300 s, at most the physical TTL) is returned
//           marked stale; business refusals never read an old entry;
//   expiry: the physical Redis TTL (3600 s) only cleans up, it never decides a hit.
// Without Redis (no provider, or RedisUnavailableError on a command) the decorators read the
// union directly (02 §14).
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import {
  GovernanceError,
  RedisUnavailableError,
  type Clock,
  type RedisNamespace,
} from '../../platform/index.ts';
import { UnionError, type UnionItem, type UnionItemDetail } from '../../union/index.ts';
import {
  detailRawItemId,
  markCachedDetail,
  markStaleDetail,
  type ProductDetailUpstream,
} from '../detail.ts';
import type { ProductRef } from '../domain/types.ts';
import type { CatalogConfigReader } from '../ports.ts';
import type {
  SearchCandidate,
  SearchUpstream,
  SearchUpstreamPage,
  SearchUpstreamRequest,
} from '../search.ts';

/** Cache decorators retain the public use-case ports; callers still assemble each card. */
export interface ProductCacheOptions {
  readonly redis: RedisNamespace | null;
  readonly clock: Clock;
  readonly config: CatalogConfigReader;
}

/** Redis namespace of the search page and product detail cache; keys start with the app_id. */
export const PRODUCT_CACHE_NAMESPACE = 'catalog-cache';
/** BR-PROD-07: physical Redis TTL of search and detail entries, cleanup only. */
export const PRODUCT_CACHE_PHYSICAL_TTL_SECONDS = 3600;
/** BR-PRICE-11 search.cache_ttl_sec default: the hit window. */
const DEFAULT_HIT_WINDOW_SECONDS = 300;
/** BR-PROD-07 search.cache.stale_max_age_s default; capped at the physical TTL. */
const DEFAULT_STALE_WINDOW_SECONDS = 300;
const HIT_WINDOW_KEY = 'search.cache_ttl_sec';
const STALE_WINDOW_KEY = 'search.cache.stale_max_age_s';
const FILTER_VERSION_KEY = 'search.filter_cfg_version';
/** Format version of the stored JSON; another version reads as a miss. */
const ENTRY_VERSION = 1;

/** BR-PROD-07 norm(q): NFKC, trim, collapse runs of whitespace, lower case. */
export function normalizeKeyword(q: string): string {
  return q.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Union dependency failures (after the governed adapter's retries): governance timeout, open
 * breaker, exhausted quota; UnionError upstream_unavailable / rate_limited. Only these may fall
 * back to a stale entry; business refusals (off shelf, invalid_policy …) and anything else never do.
 */
export function isDependencyFailure(error: unknown): boolean {
  if (error instanceof GovernanceError) return error.code !== 'invalid_policy';
  if (error instanceof UnionError) {
    return error.code === 'upstream_unavailable' || error.code === 'rate_limited';
  }
  return false;
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

interface Windows {
  readonly hitMs: number;
  readonly staleMs: number;
}

async function windowsOf(config: CatalogConfigReader, appId: string): Promise<Windows> {
  const hit = await config.configValue(appId, HIT_WINDOW_KEY);
  const stale = await config.configValue(appId, STALE_WINDOW_KEY);
  return {
    hitMs: positiveSeconds(hit?.value, DEFAULT_HIT_WINDOW_SECONDS) * 1000,
    // S2 ①: never beyond the physical TTL, whatever the configuration says.
    staleMs:
      Math.min(
        positiveSeconds(stale?.value, DEFAULT_STALE_WINDOW_SECONDS),
        PRODUCT_CACHE_PHYSICAL_TTL_SECONDS,
      ) * 1000,
  };
}

/** Sorted-key JSON of a flat record (values are strings, numbers, booleans or null). */
function canonicalJson(record: Readonly<Record<string, string | number | boolean | null>>): string {
  const sorted: Record<string, string | number | boolean | null> = {};
  for (const name of Object.keys(record).sort()) sorted[name] = record[name]!;
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------------------------
// Stored item shape: an explicit allow-list of the normalized union fields. Every link, password,
// personal or quote field the adapter may have attached is dropped by construction.

const ITEM_STRINGS = [
  'item_id',
  'itemId',
  'skuId',
  'goods_id',
  'goods_sign',
  'title',
  'quoted_at',
  'coupon_ids',
  'price_status',
  'price_anomaly_reason',
  'description',
] as const;
/** Optional card source strings (B1-05zf): stored only when the union gave a string. */
const CARD_STRINGS = ['shop_name', 'category_l1_id', 'category_l1_name', 'main_image_url'] as const;
/** Optional card source list (B1-05zf): an array of strings, order and repeats kept. */
const CARD_LIST = 'image_urls';
const ITEM_AMOUNTS = ['price_fen', 'coupon_fen', 'final_price_fen', 'commission_rate_bp'] as const;
const REF_STRINGS = [
  'appId',
  'platform',
  'productKey',
  'rawItemId',
  'rawFetchedAt',
  'receivedAt',
  'title',
  'shopId',
  'shopType',
  'source',
] as const;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function storeItem(item: UnionItem): Json {
  const source = item as unknown as Json;
  const out: Json = { platform: item.platform };
  for (const name of ITEM_STRINGS) {
    const value = source[name];
    if (typeof value === 'string' || value === null) out[name] = value;
  }
  for (const name of ITEM_AMOUNTS) out[name] = String(source[name]);
  for (const name of CARD_STRINGS) {
    const value = source[name];
    if (typeof value === 'string') out[name] = value;
  }
  const list = source[CARD_LIST];
  if (isStringList(list)) out[CARD_LIST] = [...list];
  return out;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

/** A stored value of another shape; readers treat it as a miss. */
export class Unreadable extends Error {}

export function loadItem(value: unknown): UnionItemDetail {
  if (!isRecord(value) || typeof value['platform'] !== 'string') throw new Unreadable();
  const out: Json = { platform: value['platform'] };
  for (const name of ITEM_STRINGS) {
    const field = value[name];
    if (field === undefined) continue;
    if (typeof field !== 'string' && field !== null) throw new Unreadable();
    out[name] = field;
  }
  for (const name of ITEM_AMOUNTS) {
    const field = value[name];
    if (typeof field !== 'string' || !/^-?\d+$/.test(field)) throw new Unreadable();
    out[name] = BigInt(field);
  }
  // Entries written before B1-05zf lack the card fields; absent stays absent.
  for (const name of CARD_STRINGS) {
    const field = value[name];
    if (field === undefined) continue;
    if (typeof field !== 'string') throw new Unreadable();
    out[name] = field;
  }
  const list = value[CARD_LIST];
  if (list !== undefined) {
    if (!isStringList(list)) throw new Unreadable();
    out[CARD_LIST] = [...list];
  }
  if (typeof out['title'] !== 'string' || typeof out['quoted_at'] !== 'string') {
    throw new Unreadable();
  }
  return out as unknown as UnionItemDetail;
}

/** The raw ID the detail entry was fetched with (not a union field; never part of the key). */
const DETAIL_RAW_FIELD = 'requested_raw_item_id';

interface CachedDetail {
  readonly item: UnionItemDetail;
  readonly rawItemId: string | null;
}

function loadDetail(value: unknown): CachedDetail {
  const item = loadItem(value);
  const raw = (value as Json)[DETAIL_RAW_FIELD];
  // Entries written before this field existed read as fetched without a raw ID.
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new Unreadable();
  return { item, rawItemId: typeof raw === 'string' ? raw : null };
}

export function storeRef(ref: ProductRef): Json {
  const source = ref as unknown as Json;
  const out: Json = {};
  for (const name of REF_STRINGS) out[name] = source[name] ?? null;
  return out;
}

export function loadRef(value: unknown): ProductRef {
  if (!isRecord(value)) throw new Unreadable();
  const out: Json = { canonicalUrl: null };
  for (const name of REF_STRINGS) {
    const field = value[name];
    if (typeof field !== 'string' && field !== null) throw new Unreadable();
    out[name] = field;
  }
  // productKey may be null on a search candidate; the identity strings may not.
  for (const name of ['appId', 'platform', 'rawItemId', 'title', 'source'] as const) {
    if (typeof out[name] !== 'string') throw new Unreadable();
  }
  return out as unknown as ProductRef;
}

// ---------------------------------------------------------------------------------------------

interface Entry<T> {
  readonly fetchedAtMs: number;
  readonly value: T;
}

/** Redis access that degrades to "no cache" on RedisUnavailableError; other errors propagate. */
function store(redis: RedisNamespace) {
  return {
    async read<T>(key: string, load: (value: unknown) => T): Promise<Entry<T> | null> {
      let text: string | null;
      try {
        text = await redis.get(key);
      } catch (error: unknown) {
        if (error instanceof RedisUnavailableError) return null;
        throw error;
      }
      if (text === null) return null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          !isRecord(parsed) ||
          parsed['v'] !== ENTRY_VERSION ||
          typeof parsed['fetched_at_ms'] !== 'number' ||
          !Number.isFinite(parsed['fetched_at_ms'])
        ) {
          return null;
        }
        return { fetchedAtMs: parsed['fetched_at_ms'], value: load(parsed['data']) };
      } catch {
        // Unparsable or another shape: a miss, overwritten by the next union answer.
        return null;
      }
    },
    async write(key: string, fetchedAtMs: number, data: unknown): Promise<void> {
      const text = JSON.stringify({ v: ENTRY_VERSION, fetched_at_ms: fetchedAtMs, data });
      try {
        await redis.set(key, text, PRODUCT_CACHE_PHYSICAL_TTL_SECONDS);
      } catch (error: unknown) {
        if (!(error instanceof RedisUnavailableError)) throw error;
      }
    },
  };
}

interface CachedPage {
  readonly hasMore: boolean;
  readonly items: readonly SearchCandidate[];
}

function loadPage(value: unknown): CachedPage {
  if (!isRecord(value) || typeof value['has_more'] !== 'boolean') throw new Unreadable();
  const items = value['items'];
  if (!Array.isArray(items)) throw new Unreadable();
  return {
    hasMore: value['has_more'],
    items: items.map((entry: unknown) => {
      if (!isRecord(entry)) throw new Unreadable();
      return { item: loadItem(entry['item']), ref: loadRef(entry['ref']) };
    }),
  };
}

/**
 * BR-PROD-07 search key: `<app_id>:search:<platform>:<sha1(canonical union params)>:<filter
 * version>`. The params are exactly what is sent to the union for the page — norm(q), sort,
 * has_coupon, the price lower bound, the union page number and page size — never the promotion
 * slot, relation_id, the requester or our session / cursor. The price upper bound is filtered
 * after the cache (AC-B1-05d#4) and is not a union parameter.
 */
function searchKey(
  input: SearchUpstreamRequest,
  keyword: string,
  filterVersion: string,
  jdMode: string | null,
): string {
  const params = canonicalJson({
    q: keyword,
    sort: input.sort,
    has_coupon: input.hasCoupon === true,
    start_price_fen: input.priceMinFen ?? null,
    page_no: input.pageNo,
    page_size: input.pageSize,
    // The cached refs carry product keys derived under product_key.jd.mode (BR-PROD-03); a mode
    // change must not serve keys of the old mode for the rest of the hit window.
    ...(jdMode === null ? {} : { jd_product_key_mode: jdMode }),
  });
  const digest = createHash('sha1').update(params, 'utf8').digest('hex');
  return `${input.appId}:search:${input.platform}:${digest}:${filterVersion}`;
}

/** The JD product key mode the cached refs were derived under (absent = item, BR-PROD-03). */
async function jdModeOf(
  config: CatalogConfigReader,
  input: SearchUpstreamRequest,
): Promise<string | null> {
  if (input.platform !== 'jd') return null;
  const entry = await config.configValue(input.appId, 'product_key.jd.mode');
  return entry === null ? 'item' : String(entry.value);
}

async function filterVersionOf(config: CatalogConfigReader, appId: string): Promise<string> {
  const entry = await config.configValue(appId, FILTER_VERSION_KEY);
  if (entry === null || entry.value === null) return '0';
  return typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
}

/** RedisNamespace has no delete of its own; this script writes nothing, so ARGV[1] goes unused. */
const DROP_KEY = "return redis.call('DEL', KEYS[1])";

/**
 * BR-PROD-07 主动失效 of one detail entry, on the key cacheDetailUpstream writes. Without Redis there
 * is nothing to drop; a Redis outage only leaves the entry to expire.
 */
export function detailCacheDropper(
  redis: RedisNamespace | null,
  logger: Pick<Logger, 'warn'>,
): (appId: string, productKey: string) => Promise<void> {
  return async (appId, productKey) => {
    if (redis === null) return;
    try {
      await redis.eval(DROP_KEY, {
        keys: [`${appId}:product:${productKey}`],
        args: [],
        ttlSeconds: 1,
      });
    } catch (error: unknown) {
      if (!(error instanceof RedisUnavailableError)) throw error;
      logger.warn(
        { event: 'pool_detail_cache_not_dropped', product_key: productKey },
        'catalog: detail cache entry left to expire',
      );
    }
  };
}

export function cacheSearchUpstream(
  upstream: SearchUpstream,
  options: ProductCacheOptions,
): SearchUpstream {
  const { redis, clock, config } = options;
  const cache = redis === null ? null : store(redis);

  return {
    async search(input: SearchUpstreamRequest): Promise<SearchUpstreamPage> {
      const keyword = normalizeKeyword(input.keyword);
      // The union receives exactly the parameters the key is built from (only known fields).
      const request: SearchUpstreamRequest = {
        appId: input.appId,
        platform: input.platform,
        keyword,
        pageNo: input.pageNo,
        pageSize: input.pageSize,
        sort: input.sort,
        ...(input.hasCoupon === undefined ? {} : { hasCoupon: input.hasCoupon }),
        ...(input.priceMinFen === undefined ? {} : { priceMinFen: input.priceMinFen }),
        promotionSlot: input.promotionSlot,
      };
      if (cache === null) return upstream.search(request);
      const windows = await windowsOf(config, input.appId);
      const key = searchKey(
        input,
        keyword,
        await filterVersionOf(config, input.appId),
        await jdModeOf(config, input),
      );
      const entry = await cache.read(key, loadPage);
      if (entry !== null && clock.now().getTime() - entry.fetchedAtMs <= windows.hitMs) {
        return { items: entry.value.items, hasMore: entry.value.hasMore };
      }
      let page: SearchUpstreamPage;
      try {
        page = await upstream.search(request);
      } catch (error: unknown) {
        if (
          entry !== null &&
          isDependencyFailure(error) &&
          clock.now().getTime() - entry.fetchedAtMs <= windows.staleMs
        ) {
          return { items: entry.value.items, hasMore: entry.value.hasMore, stale: true };
        }
        throw error;
      }
      // fetched_at: the receipt instant of this union response (BR-PROD-07).
      const fetchedAtMs = clock.now().getTime();
      await cache.write(key, fetchedAtMs, {
        has_more: page.hasMore,
        items: page.items.map(({ item, ref }) => ({ item: storeItem(item), ref: storeRef(ref) })),
      });
      return page;
    },
    // The fallback feed is a courtesy list outside BR-PROD-07's search cache.
    materialFeed: (input) => upstream.materialFeed(input),
  };
}

export function cacheDetailUpstream(
  upstream: ProductDetailUpstream,
  options: ProductCacheOptions,
): ProductDetailUpstream {
  const { redis, clock, config } = options;
  const cache = redis === null ? null : store(redis);

  return {
    async detail(request) {
      if (cache === null || request.platform === undefined) return upstream.detail(request);
      const windows = await windowsOf(config, request.appId);
      // BR-PROD-07 detail key: `<app_id>:product:<product_key>`, never the raw ID.
      const key = `${request.appId}:product:${request.productKey}`;
      const entry = await cache.read(key, loadDetail);
      // AC-B1-05k#5/#7: when the caller requires its raw ID, an entry fetched under another raw
      // ID of the same product_key is a miss (no hit, no stale answer) and is overwritten below.
      const rawMismatch =
        entry !== null &&
        request.requireRawMatch === true &&
        entry.value.rawItemId !== (request.rawItemId ?? null);
      const usable =
        entry !== null && !rawMismatch && entry.value.item.platform === request.platform
          ? { fetchedAtMs: entry.fetchedAtMs, value: entry.value.item }
          : null;
      if (usable !== null && clock.now().getTime() - usable.fetchedAtMs <= windows.hitMs) {
        return markCachedDetail(usable.value);
      }
      let item: UnionItemDetail;
      try {
        item = await upstream.detail(request);
      } catch (error: unknown) {
        if (
          usable !== null &&
          isDependencyFailure(error) &&
          clock.now().getTime() - usable.fetchedAtMs <= windows.staleMs
        ) {
          return markStaleDetail(usable.value);
        }
        throw error;
      }
      const fetchedAtMs = clock.now().getTime();
      // Only an answer for this key's platform is shared; the use case validates the rest.
      if (item.platform === request.platform) {
        await cache.write(key, fetchedAtMs, {
          ...storeItem(item),
          // A re-parse asks without one: the answer's raw ID is what product_refs now offers.
          [DETAIL_RAW_FIELD]:
            request.rawItemId ?? detailRawItemId(item, request.jdMode ?? 'item') ?? null,
        });
      }
      return item;
    },
  };
}
