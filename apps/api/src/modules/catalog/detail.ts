// B1-05e: GET /v1/products/{product_key}, the product detail use case. Tests call this file
// directly; the HTTP controller (http/public/product.controller.ts) supplies the
// contract-validated path and query plus the server-owned ports.
import type { components } from '@couli/contracts-ts';
import {
  ProductKeyInvalid,
  ProductKeyUnderivable,
  deriveProductKey,
  splitProductKey,
} from '@couli/domain';
import { GovernanceError, type Clock } from '../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  isRegisteredPlatform,
  type ItemRef,
  type RegisteredPlatform,
  type UnionItemDetail,
} from '../union/index.ts';
import type { CatalogCardEntry, CatalogCardResult } from './application/card-entry.ts';
import type { ItemRefService } from './application/item-ref.ts';
import type { PoolReader } from './application/pool-read.ts';
import { detailImages, type DetailImage } from './domain/detail-images.ts';
import { CatalogError, isFresh } from './domain/rules.ts';
import type { Catalog, ProductCapabilities, ProductRef, RequestRawRef } from './domain/types.ts';
import type { CatalogConfigReader, ViewerContext } from './ports.ts';
import type { PriceSnapshotRecorder } from './price-history/types.ts';

export interface ProductDetailQuery {
  readonly product_key: string;
  readonly item_ref?: string;
  /** Server-read source link; never trust a client-supplied entry_source. */
  readonly from_link_id?: string;
}

export interface ProductDetailRequest {
  readonly appId: string;
  readonly productKey: string;
  /** Platform of the requested key's prefix (platforms.key_prefix). */
  readonly platform?: RegisteredPlatform;
  /** product_key.jd.mode of the app, only for jd: which raw ID field rawItemId fills. */
  readonly jdMode?: string;
  /** Absent means re-resolve the product key, never fabricate an upstream raw ID. */
  readonly rawItemId?: string;
  /**
   * BR-PROD-05 ③ of a key with a product_refs row or a qualifying pool row: without rawItemId the
   * union is asked by this canonical_url, else by this title. Absent too, it is not asked: 30143.
   */
  readonly reparse?: {
    readonly title: string;
    readonly keyPrefix: string | null;
    readonly canonicalUrl?: string | null;
  };
  /**
   * The detail use case's resolved raw ID (item_ref or product_refs) must be the one the union is
   * asked with: a detail cache entry fetched under another raw ID of the same product_key counts
   * as a miss and is overwritten (AC-B1-05k#5/#7). Display reads leave it unset and share the
   * entry by product_key alone (BR-PROD-07).
   */
  readonly requireRawMatch?: boolean;
}

/**
 * Union answers a cache served from an entry past its hit window because the union was down
 * (BR-PROD-07 熔断降级, BR-PRICE-11): the card is stale=true with the entry's quoted_at.
 */
const STALE_DETAILS = new WeakSet<object>();
const FRESH_DETAILS = new WeakSet<object>();
/** An entry inside its hit window: no union response, so no product_refs write (BR-PROD-05). */
const CACHED_DETAILS = new WeakSet<object>();

/** Marks a detail answer as a stale cache entry (infra/product-cache.ts). */
export function markStaleDetail<T extends UnionItemDetail>(item: T): T {
  STALE_DETAILS.add(item);
  return item;
}

/** Marks a detail answer as a cache hit (infra/product-cache.ts). */
export function markCachedDetail<T extends UnionItemDetail>(item: T): T {
  CACHED_DETAILS.add(item);
  return item;
}

/**
 * B1-17c: marks a detail answer as a fresh union return (the module marks what the union side
 * under the cache returns; a cache hit or a stale entry is never marked) and returns it. Only a
 * marked answer is handed to the price history recorder (BR-WATCH-19 (1)).
 */
export function markFreshDetail<T extends UnionItemDetail>(item: T): T {
  FRESH_DETAILS.add(item);
  return item;
}

export interface ProductDetailUpstream {
  detail(request: ProductDetailRequest): Promise<UnionItemDetail>;
}

export interface ProductDetailOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly config: CatalogConfigReader;
  readonly catalog: Pick<Catalog, 'listPlatforms' | 'readProductRef' | 'registerProductRef'>;
  readonly itemRefs: ItemRefService;
  readonly cards: CatalogCardEntry;
  readonly upstream: ProductDetailUpstream;
  /**
   * B1-17c: the price history hook (BR-WATCH-19 (1), source_kind detail). Absent, the detail
   * behaves exactly as before. Present, a union answer marked by markFreshDetail is handed to
   * record() once (not awaited; a throw is swallowed; the response never changes).
   */
  readonly priceHistory?: PriceSnapshotRecorder;
  /** B1-05r: the pool price of a union outage (BR-PRICE-11, TRADE-12); absent, it stays 50401. */
  readonly poolReader?: PoolReader;
  /**
   * B1-05w: false keeps a caller out of BR-PROD-05 ③, so a key without a fresh raw ID is 30143 with
   * no union call: a favorites page reads many cards and must not spend one title search on each.
   */
  readonly reparse?: boolean;
  /**
   * B1-05ze (FU-DETAIL-GALLERY, CT-26o): false leaves `images` off the card. ProductCard.images is
   * only on GET /v1/products/{product_key}; another caller reusing this use case (favorites) is
   * not the detail route. Absent means the detail route: the card carries images.
   */
  readonly images?: boolean;
}

export type ProductDetailData = components['schemas']['ProductResponse']['data'];

const JD_MODE = 'product_key.jd.mode';
/**
 * BR-PROD-10 细则「按平台的搜索开关」: search.enabled.<platform> governs keyword search only;
 * a product detail is unaffected. Like parsing, a registered platform with a union adapter counts
 * as able to resolve (checked before any union call), so the detail never depends on the switch.
 */
const DETAIL_CAPABILITIES: ProductCapabilities = Object.freeze({
  parseEnabled: true,
  searchEnabled: false,
});
/** BR-PRICE-07 来源判定表: a detail without a source card is entry_source `detail` (→ risk). */
const DETAIL_ENTRY_SOURCE = 'detail';

function refExpired(message: string): never {
  throw new CatalogError(30143, `detail: ${message}`);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * BR-PROD-05 raw_item_id of a union response, taken as is: taobao item_id; jd skuId (sku mode)
 * or the whole itemId (item mode); pdd goods_sign. Never inferred from another field.
 */
export function detailRawItemId(item: ItemRef, jdMode: string): string | undefined {
  switch (item.platform) {
    case 'taobao':
      return nonEmpty(item.item_id);
    case 'jd':
      return jdMode === 'sku' ? nonEmpty(item.skuId) : nonEmpty(item.itemId);
    case 'pdd':
      return nonEmpty(item.goods_sign);
    default:
      return undefined;
  }
}

/**
 * Union failure → contract code. Off shelf is 30141 (BR-PRICE-14). A dependency failure
 * (network / 5xx, throttling, governor timeout, open breaker, exhausted quota) with no usable cache
 * is 50401, the 「暂时查不到」 branch of BR-PRICE-11; getProduct reads the product pool first. A union refusal of the raw ID itself
 * (upstream_rejected / invalid_dto / link_unrecognized) is 30143 ref_expired (BR-PROD-05 结果分类
 * 「引用失效」). Anything else propagates unchanged.
 */
export function upstreamFailure(error: unknown): unknown {
  if (error instanceof CatalogError) return error;
  if (
    (error instanceof UnionError && error.code === 'item_unavailable') ||
    (error instanceof DemoUnionError && error.code === 'demo_delisted')
  ) {
    return new CatalogError(30141, 'detail: item is off the shelf', undefined, { cause: error });
  }
  if (
    error instanceof UnionError &&
    (error.code === 'upstream_rejected' ||
      error.code === 'invalid_dto' ||
      error.code === 'link_unrecognized')
  ) {
    // BR-PROD-05 结果分类「引用失效」: the union refuses this raw ID itself.
    return new CatalogError(30143, 'detail: union rejected the raw item id', undefined, {
      cause: error,
    });
  }
  if (
    (error instanceof UnionError &&
      (error.code === 'upstream_unavailable' || error.code === 'rate_limited')) ||
    (error instanceof GovernanceError && error.code !== 'invalid_policy')
  ) {
    return new CatalogError(50401, 'detail: union temporarily unavailable', undefined, {
      cause: error,
    });
  }
  return error;
}

/**
 * GET /v1/products/{product_key} (04 §6.3; BR-PROD-03 / 05 / 11, BR-PRICE-05 / 07 / 11 / 12 / 14).
 * Order: request key → platform (20001 on a malformed or unregistered key) → item_ref (an
 * authenticated same-app token naming another product is 20001, before any union call) → raw ID
 * by BR-PROD-05 ① item_ref ≤ 1800 s, ② product_refs refreshed ≤ 1800 s, ③ re-parse (a key with a
 * product_refs row of any age or a qualifying pool row; with neither there is no title to search:
 * 30143 without a union call) → union detail (off shelf 30141, 结果分类 ② 30143, dependency failure:
 * the stale cache, the pool's price, or 50401) → the single derivation deriveProductKey; another key
 * or none is 30143 → product_refs (source detail, receipt instant from the Clock after the response;
 * a cache answer holds no union response and writes nothing) → the card entry (active query; quote, item_ref, link
 * registration). Every call registers a new link; a failed registration rejects the call, so no
 * unregistered link_id goes out. A valid item_ref whose raw ID was used is returned unchanged;
 * otherwise the card carries a freshly issued one.
 */
/** The card of the entry's answer; an anomalous price has no card (D33 active query). */
function issuedCard(result: CatalogCardResult): ProductDetailData {
  switch (result.kind) {
    case 'card':
      return result.card;
    case 'price_unavailable':
      // D33 active query: no amount and no link_id; 50303 until F-37 gives the card a shape.
      // TODO(规划/11 §9.2): price_unavailable 卡的线上形状 — blocked on followups F-37 契约同步
      throw new CatalogError(50303, 'detail: price temporarily unavailable');
    default:
      throw new TypeError(`detail: unexpected card result ${result.kind}`);
  }
}

/**
 * B1-05ze: the detail card with its images (contract ProductCard.images, only on the detail route);
 * unchanged when the caller opted out.
 */
function withImages(
  card: ProductDetailData,
  images: DetailImage[],
  options: Pick<ProductDetailOptions, 'images'>,
): ProductDetailData {
  return options.images === false ? card : { ...card, images };
}

export async function getProduct(
  query: ProductDetailQuery,
  options: ProductDetailOptions,
): Promise<ProductDetailData> {
  const { clock, viewerContext, config, catalog, itemRefs, cards, upstream } = options;
  const productKey = query.product_key;
  const viewer = await viewerContext.current();
  const appId = viewer.appId;

  const rows = await catalog.listPlatforms();
  let platform: string;
  try {
    // Format and prefix only (BR-PROD-02): serving switches are checked by registerProductRef.
    platform = splitProductKey(
      productKey,
      rows.map((row) => ({
        platform: row.code,
        keyPrefix: row.key_prefix,
        parseEnabled: true,
        searchEnabled: true,
      })),
    ).platform;
  } catch (error: unknown) {
    if (error instanceof ProductKeyInvalid) {
      throw new CatalogError(20001, 'detail: product_key invalid', undefined, { cause: error });
    }
    throw error;
  }
  if (!isRegisteredPlatform(platform)) {
    // BR-PROD-03: only taobao, jd and pdd have product keys and a union adapter.
    throw new CatalogError(30131, 'detail: platform has no union adapter');
  }
  const row = rows.find((entry) => entry.code === platform);

  // ① The tapped card's token: 20001 on a same-app product mismatch, ignored when unusable.
  const token: RequestRawRef | null = itemRefs.verify({
    itemRef: query.item_ref ?? null,
    appId,
    productKey,
  });
  const nowMs = clock.now().getTime();
  let rawItemId: string | undefined;
  let tokenRaw: string | undefined;
  let stored: ProductRef | null = null;
  if (token !== null && token.platform === platform && isFresh(token.fetchedAt, nowMs)) {
    rawItemId = token.rawItemId;
    tokenRaw = token.rawItemId;
  } else {
    // ② product_refs of (app_id, product_key); refreshed_at is the stored receipt instant.
    stored = await catalog.readProductRef({ appId, platform, productKey });
    if (stored !== null && isFresh(stored.receivedAt, nowMs)) rawItemId = stored.rawItemId;
  }

  const jdEntry = platform === 'jd' ? await config.configValue(appId, JD_MODE) : null;
  // Absent means item (BR-PROD-03); any other value fails closed in deriveProductKey.
  const jdMode = jdEntry === null ? 'item' : String(jdEntry.value);

  // ③ A key with a product_refs row or a qualifying pool row, under the key that pool row stores.
  const reparsing =
    rawItemId === undefined
      ? ((await options.poolReader?.detail(appId, productKey)) ?? null)
      : null;
  const targetKey = reparsing?.ref.productKey ?? productKey;
  const reparseTitle =
    rawItemId === undefined && options.reparse !== false
      ? (stored?.title ?? reparsing?.item.title)
      : null;

  let item: UnionItemDetail;
  try {
    item = await upstream.detail({
      appId,
      productKey: targetKey,
      platform,
      ...(platform === 'jd' ? { jdMode } : {}),
      ...(rawItemId === undefined ? {} : { rawItemId, requireRawMatch: true }),
      ...(reparseTitle === undefined || reparseTitle === null
        ? {}
        : {
            reparse: {
              title: reparseTitle,
              keyPrefix: row?.key_prefix ?? null,
              canonicalUrl: stored?.canonicalUrl ?? null,
            },
          }),
    });
  } catch (error: unknown) {
    const failure = upstreamFailure(error);
    if (failure instanceof CatalogError && failure.code === 50401) {
      // BR-PRICE-11, TRADE-12. The pool's row is no union answer: no product_refs, no price history.
      // Read now, not `reparsing`: the row may have aged out while the union timed out.
      const pooled = await options.poolReader?.detail(appId, productKey);
      if (pooled !== null && pooled !== undefined) {
        const card = issuedCard(
          await cards.assemble({
            item: pooled.item,
            ref: pooled.ref,
            entrySource: DETAIL_ENTRY_SOURCE,
            ...(query.from_link_id === undefined ? {} : { sourceLinkId: query.from_link_id }),
            stale: true,
            scene: 'active_query',
          }),
        );
        // B1-05ze: the pool row keeps only the main image of its listing; nothing is added from
        // elsewhere, so the images are [main] or [].
        const main = pooled.item.main_image_url;
        return withImages(
          card,
          detailImages(main === undefined ? {} : { main_image_url: main }),
          options,
        );
      }
    }
    throw failure;
  }
  // BR-PROD-05: refreshed_at is the receipt instant of this union response.
  const receivedAt = clock.now().toISOString();

  if (item.platform !== platform) refExpired('union answered for another platform');
  let derived: string;
  try {
    derived = deriveProductKey(
      {
        platform,
        keyPrefix: row?.key_prefix ?? null,
        ...(platform === 'jd' ? { jdMode: jdMode as 'item' | 'sku' } : {}),
      },
      item,
    );
  } catch (error: unknown) {
    if (error instanceof ProductKeyUnderivable) refExpired('product key not derivable');
    throw error;
  }
  if (derived !== targetKey) refExpired('response derives another product key');
  const responseRaw = detailRawItemId(item, jdMode);
  if (responseRaw === undefined) refExpired('response carries no raw item id');

  if (options.priceHistory !== undefined && FRESH_DETAILS.has(item) && !STALE_DETAILS.has(item)) {
    try {
      void Promise.resolve(
        options.priceHistory.record({
          appId,
          platform: item.platform,
          productKey: derived,
          skuKey: item.skuId ?? null,
          sourceKind: 'detail',
          outcome: 'ok',
          priceFen: item.price_fen,
          couponFen: item.coupon_fen,
          finalPriceFen: item.final_price_fen,
          priceStatus: item.price_status ?? 'ok',
          inStock: true,
          fresh: true,
          userScoped: false,
          goodsSignPlan: null,
        }),
      ).catch(() => undefined);
    } catch {
      // A broken optional recorder must not change the detail's response or error path.
    }
  }

  const ref: ProductRef = {
    appId,
    platform,
    productKey: targetKey,
    rawItemId: responseRaw,
    rawFetchedAt: item.quoted_at,
    receivedAt,
    canonicalUrl: null,
    title: item.title,
    shopId: null,
    shopType: null,
    source: 'detail',
  };
  // BR-PROD-05: refreshed_at only ever moves with a union response, which a cache answer is not.
  if (!CACHED_DETAILS.has(item) && !STALE_DETAILS.has(item)) {
    await catalog.registerProductRef(ref, DETAIL_CAPABILITIES);
  }

  const result = await cards.assemble({
    item,
    ref,
    entrySource: DETAIL_ENTRY_SOURCE,
    ...(query.from_link_id === undefined ? {} : { sourceLinkId: query.from_link_id }),
    stale: STALE_DETAILS.has(item),
    scene: 'active_query',
  });
  // B1-05ze: a cache hit or a stale entry is the same UnionItemDetail, so it reads the same way.
  const card = withImages(issuedCard(result), detailImages(item), options);
  // BR-PROD-11: a valid tapped token that supplied this call's raw ID goes back unchanged (原样
  // 透传), even if the union now reports another raw ID for the same key; otherwise the card's
  // freshly issued token stands.
  return tokenRaw !== undefined && query.item_ref !== undefined
    ? { ...card, item_ref: query.item_ref }
    : card;
}
