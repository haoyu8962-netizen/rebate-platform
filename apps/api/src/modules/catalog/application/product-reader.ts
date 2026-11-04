// B1-06j: catalog's read-only product port for cards that are not assembled from a union answer
// (the in-app link landing card, BR-ATTR-05 细则「App 内打开链接的入口」: the opener sees the
// product, its coupon and the post-coupon price; 01 §4.2 出商品卡 by link_id). It never registers a
// link, writes no table (product_refs included: a landing view is no union answer of this
// request's own registration flow), converts nothing and never prices: prices stay with the
// caller's snapshot. Order: ① the app's product_refs row (title, shop_type); ② without one, a single
// governed union detail by the caller's raw ID (title). Any union failure leaves the fields null.
import { isRegisteredPlatform, type UnionItemDetail } from '../../union/index.ts';
import type { ProductDetailRequest, ProductDetailUpstream } from '../detail.ts';
import type { CatalogConfigReader } from '../ports.ts';

export interface CatalogProductQuery {
  readonly appId: string;
  readonly platform: string;
  /** null for an amount_unknown link: nothing is looked up. */
  readonly productKey: string | null;
  /** The raw ID the caller already holds (a links snapshot), used only for the union fallback. */
  readonly rawItemId: string | null;
}

/** Display fields of a product; every field is null when it cannot be read. */
export interface CatalogProductSummary {
  readonly title: string | null;
  /** The union detail's main image (cleaned by the adapter); null when it gave none. */
  readonly image: string | null;
  /** The union DTO carries no shop name yet; null. */
  readonly shopName: string | null;
  readonly shopType: string | null;
}

/** Catalog's read port for other modules (app.module.ts wires it); read-only by contract. */
export abstract class CatalogProductReader {
  abstract read(query: CatalogProductQuery): Promise<CatalogProductSummary>;
}

/** The product_refs columns this port reads, in the caller's app scope. */
export interface CatalogProductRefs {
  readProductRef(
    appId: string,
    platform: string,
    productKey: string,
  ): Promise<{ readonly title: string; readonly shopType: string | null } | null>;
}

export interface CatalogProductReaderOptions {
  readonly refs: CatalogProductRefs;
  /** The governed union detail (createUnionDetailUpstream); only getItem, never a conversion. */
  readonly upstream: ProductDetailUpstream;
  /** product_key.jd.mode: which jd raw ID field the snapshot's raw ID fills. */
  readonly config: CatalogConfigReader;
}

const JD_MODE = 'product_key.jd.mode';

const EMPTY: CatalogProductSummary = Object.freeze({
  title: null,
  image: null,
  shopName: null,
  shopType: null,
});

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * TODO(规划/11 §4.5): 店铺名 — blocked on 联盟 DTO 增加店铺名字段（union/domain/types.ts UnionItem
 * 目前没有店铺名）
 */
export function createCatalogProductReader(
  options: CatalogProductReaderOptions,
): CatalogProductReader {
  const { refs, upstream, config } = options;

  async function fromUnion(
    query: CatalogProductQuery,
    productKey: string,
  ): Promise<CatalogProductSummary> {
    const rawItemId = nonEmpty(query.rawItemId);
    const platform = query.platform;
    if (rawItemId === null || !isRegisteredPlatform(platform)) return EMPTY;
    let item: UnionItemDetail;
    try {
      const jdEntry = platform === 'jd' ? await config.configValue(query.appId, JD_MODE) : null;
      const request: ProductDetailRequest = {
        appId: query.appId,
        productKey,
        platform,
        rawItemId,
        ...(platform === 'jd' ? { jdMode: jdEntry === null ? 'item' : String(jdEntry.value) } : {}),
      };
      item = await upstream.detail(request);
    } catch {
      // A display read: a union or configuration failure leaves the product fields null.
      return EMPTY;
    }
    if (item.platform !== platform) return EMPTY;
    // B1-05za: only the main image; image_urls never stands in for it.
    return { ...EMPTY, title: nonEmpty(item.title), image: nonEmpty(item.main_image_url) };
  }

  return {
    async read(query: CatalogProductQuery): Promise<CatalogProductSummary> {
      const productKey = nonEmpty(query.productKey);
      if (productKey === null) return EMPTY;
      const stored = await refs.readProductRef(query.appId, query.platform, productKey);
      if (stored !== null) {
        return { ...EMPTY, title: nonEmpty(stored.title), shopType: nonEmpty(stored.shopType) };
      }
      return fromUnion(query, productKey);
    },
  };
}
