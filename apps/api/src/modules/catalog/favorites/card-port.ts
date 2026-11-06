import { createCatalogCardEntry, type CatalogCardEntryOptions } from '../application/card-entry.ts';
import type { CatalogProductReader } from '../application/product-reader.ts';
import { getProduct, type ProductDetailOptions } from '../detail.ts';
import { CatalogError } from '../domain/rules.ts';
import type { FavoriteCardPort } from './types.ts';

export interface FavoriteCardPortOptions
  extends
    Omit<ProductDetailOptions, 'viewerContext' | 'cards' | 'priceHistory'>,
    Pick<CatalogCardEntryOptions, 'quoter' | 'registrar' | 'sourceLinks' | 'logger'> {
  readonly products: CatalogProductReader;
}

/**
 * Reuse detail's raw-ID selection, derivation check and product_refs registration, but assemble
 * in retrieval mode. The per-call viewer is captured locally, including concurrent page reads.
 * The only link operation exposed here is registration with its quote snapshot; no conversion.
 */
export function createFavoriteCardPort(options: FavoriteCardPortOptions): FavoriteCardPort {
  return {
    async fetch({ viewer, platform, productKey }) {
      const viewerContext = { current: async () => ({ ...viewer }) };
      const entry = createCatalogCardEntry({ ...options, viewerContext });
      try {
        const card = await getProduct(
          { product_key: productKey },
          {
            clock: options.clock,
            config: options.config,
            itemRefs: options.itemRefs,
            upstream: options.upstream,
            reparse: false,
            // B1-05ze: ProductCard.images is only on the detail route, never on a favorite card.
            images: false,
            // B1-05zk: nor are the five detail-only keys (coupon_end_at … shop_entry).
            detailExtras: false,
            viewerContext,
            catalog: {
              // A favorite also names its platform: a mismatched key must fail before upstream.
              listPlatforms: async () =>
                (await options.catalog.listPlatforms()).filter((row) => row.code === platform),
              readProductRef: (identity) => options.catalog.readProductRef(identity),
              registerProductRef: (ref, capabilities) =>
                options.catalog.registerProductRef(ref, capabilities),
            },
            cards: {
              assemble: async (input) => {
                const result = await entry.assemble({ ...input, scene: 'retrieval' });
                if (result.kind !== 'card') {
                  // Retrieval skips anomalous prices; keep the favorite but never issue a link.
                  throw new CatalogError(50303, 'favorites: no priced card available');
                }
                return result;
              },
            },
          },
        );
        return { kind: 'card', card };
      } catch (error: unknown) {
        if (!(error instanceof CatalogError) || error.code !== 30141) throw error;
        // The current union API collapses missing/delisted/non-promotable into
        // item_unavailable, mapped by detail to 30141. Do not invent platform-specific fields.
        const product = await options.products.read({
          appId: viewer.appId,
          platform,
          productKey,
          rawItemId: null,
        });
        return {
          kind: 'unavailable',
          reason: 'off_shelf',
          title: product.title,
          image: product.image,
        };
      }
    },
  };
}
