// B1-05q: adminSearchPoolCandidates. The search is searchProducts itself (switch, query PID,
// BR-PROD-07 cache, BR-PROD-08 ①② dedupe, cursor rules), with the admin as the requester and three
// things removed around it: no link is registered, a no_rebate product stays in the list, and an
// empty result has no fall-back feed. The rebate is computed only for the same-price tie.
import type { Schema } from '@couli/contracts-ts';
import type { ProductCard } from './card-assembler.ts';
import type { CatalogCardEntry } from './card-entry.ts';
import type { Catalog } from '../domain/types.ts';
import type { ViewerContext } from '../ports.ts';
import {
  searchProducts,
  type SearchProductsOptions,
  type SearchProductsQuery,
  type SearchUpstream,
} from '../search.ts';

export type PoolCandidateList = Schema<'AdminPoolCandidateList'>;

export interface PoolCandidateQuery {
  readonly platform: SearchProductsQuery['platform'];
  readonly q: string;
  readonly cursor?: string;
}

/** BR-PROD-07 server page size of this console search. */
const CANDIDATE_PAGE_SIZE = 20;

function withFilter(
  filter: Pick<Catalog, 'filterCategories'> | undefined,
): Pick<SearchProductsOptions, 'categoryFilter'> {
  return filter === undefined ? {} : { categoryFilter: filter };
}

/** The prepared card keeps its quote for the tie; commit registers nothing (no link here). */
function candidateCards(entry: CatalogCardEntry): CatalogCardEntry {
  return {
    async assemble(input) {
      const result = await entry.assemble(input);
      if (result.kind !== 'prepared') return result;
      // searchProducts drops no_rebate cards; the pool filters them when it is read (BR-PRICE-08).
      const card = { ...result.card, rebate_basis: 'normal' as const };
      return {
        kind: 'prepared',
        card,
        commit: () => Promise.resolve({ ...card, link_id: '' }),
      };
    },
  };
}

/** An empty first page stays empty: the product pool and the feed are never candidates. */
function noFeed(upstream: SearchUpstream): SearchUpstream {
  return {
    search: (input) => upstream.search(input),
    materialFeed: () => Promise.resolve({ items: [], hasMore: false }),
  };
}

/** A search card is always priced and keyed: the nullable card fields are set here. */
function toCandidate(card: ProductCard): Schema<'AdminPoolCandidate'> {
  return {
    item_ref: card.item_ref!,
    product_key: card.product_key!,
    platform: card.platform,
    title: card.title!,
    image: card.image,
    price_fen: card.price_fen!,
    coupon_fen: card.coupon_fen!,
    final_price_fen: card.final_price_fen!,
    quoted_at: card.quoted_at!,
  };
}

/**
 * B1-05zo: the search tab's category blocklist. The admin wiring hands its full Catalog as
 * `options.catalog`; a catalog without filterCategories (hand-written fixtures) leaves it off.
 */
function categoryFilterOf(
  options: Omit<SearchProductsOptions, 'viewerContext'>,
): Pick<Catalog, 'filterCategories'> | undefined {
  if (options.categoryFilter !== undefined) return options.categoryFilter;
  const catalog = options.catalog as Partial<Catalog>;
  return typeof catalog.filterCategories === 'function'
    ? (catalog as Pick<Catalog, 'filterCategories'>)
    : undefined;
}

/**
 * `options.cards` and `options.upstream` are searchProducts' own; `requester` is the admin's.
 * Blocked-category products never become candidates (B1-05zo, as the search tab).
 */
export async function searchPoolCandidates(
  query: PoolCandidateQuery,
  requester: ViewerContext,
  options: Omit<SearchProductsOptions, 'viewerContext'>,
): Promise<PoolCandidateList> {
  const data = await searchProducts(
    {
      platform: query.platform,
      q: query.q,
      limit: CANDIDATE_PAGE_SIZE,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    },
    {
      ...options,
      viewerContext: requester,
      cards: candidateCards(options.cards),
      ...withFilter(categoryFilterOf(options)),
      upstream: noFeed(options.upstream),
    },
  );
  return { items: data.items.map(toCandidate), next_cursor: data.next_cursor };
}
