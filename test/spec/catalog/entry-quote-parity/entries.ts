// B1-05zc: the pre-order entries driven through their own use cases, with only the quote port
// swapped for a parity quoter (kit.ts). Search, paste, home pool, detail, hot list and Agent each
// hand the same taobao price fields (kit PRICE) to catalog's single card entry with their own
// entry_source; the other ports reuse the entries' existing rule-test kits unchanged.
import { vi } from 'vitest';
import {
  createCatalogCardEntry,
  getHotRank,
  getProduct,
  getSectionItems,
  searchProducts,
  type CardRebateQuoter,
  type RegisterLinkInput,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { createLinkQuoteRunner } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { createParsing } from '../../../../apps/api/src/modules/parsing/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  candidate as agentCandidate,
  context as agentContext,
  fixture as agentFixture,
  productOf,
} from '../../agent/tools-quote/kit.ts';
import {
  CTX,
  URL_A,
  cards as parsedCards,
  fixture as parseFixture,
  item as parseItem,
} from '../../parsing/core/kit.ts';
import { fixture as detailFixture, PRODUCT_KEY } from '../detail/kit.ts';
import { channel } from '../hot-rank-upstream/kit.ts';
import { candidate as searchCandidate, fixture as searchFixture, QUERY } from '../search/kit.ts';
import { NOW, PRICE, tbItem, tbRef, viewer, type ParityQuoter } from './kit.ts';

/** The originating card of a detail opened from another card (from_link_id). */
export const SOURCE_LINK = '01920000-0000-7000-8000-0000000b05c0';

function entrySources(register: {
  readonly mock: { readonly calls: readonly (readonly [RegisterLinkInput])[] };
}) {
  return register.mock.calls.map(([input]) => input.entrySource);
}

function linkRecorder(prefix: string) {
  let serial = 0;
  return vi.fn(async (input: RegisterLinkInput) => {
    void input;
    serial += 1;
    return { linkId: `${prefix}-${String(serial)}` };
  });
}

/** GET /v1/products/search (catalog/search.ts, entry_source search). */
export async function viaSearch(q: ParityQuoter) {
  const s = searchFixture();
  const found = searchCandidate('parity', PRICE.final_price_fen, PRICE.coupon_fen);
  s.pages.set(1, {
    items: [{ ...found, item: { ...found.item, commission_rate_bp: PRICE.commission_rate_bp } }],
    hasMore: false,
  });
  const cards = createCatalogCardEntry({
    clock: s.clock,
    viewerContext: s.options.viewerContext,
    quoter: q.quoter,
    registrar: { register: s.register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: s.warn },
  });
  const data = await searchProducts(QUERY, { ...s.options, cards });
  return { cards: data.items, entrySources: entrySources(s.register) };
}

/** Pasted link (parsing/application/parsing.ts, entry_source parse). */
export async function viaParse(q: ParityQuoter) {
  const p = parseFixture();
  p.getItem.mockImplementation(async (ref) => parseItem(ref, PRICE));
  const cards = createCatalogCardEntry({
    clock: p.options.clock,
    viewerContext: { current: async () => p.viewer },
    quoter: q.quoter,
    registrar: { register: p.register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: vi.fn() },
  });
  const results = await createParsing({ ...p.options, cards }).parseInput(URL_A, CTX);
  return { cards: parsedCards(results), entrySources: entrySources(p.register) };
}

/** Home product-pool section (catalog/section-items.ts, entry_source feed). */
export async function viaFeed(q: ParityQuoter) {
  const who = viewer();
  const register = linkRecorder('synthetic-feed-link');
  const cards = createCatalogCardEntry({
    clock: new FixedClock(NOW),
    viewerContext: { current: async () => who },
    quoter: q.quoter,
    registrar: { register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: vi.fn() },
  });
  const refuse = async (): Promise<never> => {
    throw new Error('synthetic: a product_pool section reads no union channel');
  };
  const data = await getSectionItems(
    { pageKey: 'home', sectionId: 'synthetic-parity-pool' },
    {
      viewerContext: { current: async () => who },
      cards,
      channels: () => ({ version: 'synthetic-parity', channels: [] }),
      upstream: { categories: refuse, page: refuse },
      pages: {
        section: async () => ({
          dataSource: { kind: 'product_pool', pool_id: 'synthetic-parity-pool', limit: 20 },
        }),
      },
      logger: { warn: vi.fn() },
      poolReader: {
        page: async () => ({
          candidates: [{ item: tbItem(), ref: tbRef(who.appId, 'pool') }],
          nextOffset: null,
        }),
        fallbackPoolId: async () => null,
        detail: async () => null,
      },
    },
  );
  return { cards: data.items, entrySources: entrySources(register) };
}

/**
 * GET /v1/products/{product_key} (catalog/detail.ts): entry_source detail, or with from_link_id
 * the originating card's entry_source read through SourceLinkReader.
 */
export async function viaDetail(q: ParityQuoter, from?: { readonly source: string | null }) {
  const d = detailFixture();
  if (from !== undefined) d.entrySource.mockResolvedValue(from.source);
  const cards = createCatalogCardEntry({
    clock: d.clock,
    viewerContext: { current: d.current },
    quoter: q.quoter,
    registrar: { register: d.register },
    sourceLinks: { entrySource: d.entrySource },
    itemRefs: d.itemRefs,
    logger: { warn: vi.fn() },
  });
  const card = await getProduct(
    { product_key: PRODUCT_KEY, ...(from === undefined ? {} : { from_link_id: SOURCE_LINK }) },
    { ...d.options, cards },
  );
  return {
    cards: [card],
    entrySources: d.rows.map((row) => row.entrySource),
    sourceReads: d.entrySource.mock.calls,
  };
}

/** GET /v1/rank/hot (catalog/hot-rank.ts, entry_source rank). */
export async function viaRank(q: ParityQuoter) {
  const who = viewer();
  const register = linkRecorder('synthetic-rank-link');
  const clock = new FixedClock(NOW);
  const cards = createCatalogCardEntry({
    clock,
    viewerContext: { current: async () => who },
    quoter: q.quoter,
    registrar: { register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: vi.fn() },
  });
  const data = await getHotRank(
    { platform: 'taobao' },
    {
      clock,
      viewerContext: { current: async () => who },
      cards,
      channels: () => ({
        version: 'synthetic-parity',
        channels: [channel('taobao', 'synthetic_parity_sales')],
      }),
      upstream: {
        categories: async () => [],
        page: async () => ({
          items: [{ item: tbItem(), ref: tbRef(who.appId, 'search'), salesText: null }],
          hasMore: false,
        }),
      },
      logger: { warn: vi.fn() },
    },
  );
  return {
    cards: data.items.map((entry) => entry.product_card),
    entrySources: entrySources(register),
  };
}

/** Agent get_rebate_quote over a pasted link (agent/tools/quote/index.ts, entry_source agent). */
export async function viaAgent(q: ParityQuoter) {
  const f = agentFixture();
  const quotedAt = f.current.ref.rawFetchedAt;
  f.setProduct({
    item: tbItem({ quoted_at: quotedAt }),
    ref: {
      ...f.current.ref,
      platform: 'taobao',
      productKey: 'tb:001',
      rawItemId: 'synthetic-parity-001',
    },
  });
  // The kit's quote double is typed with the item only; the entry passes viewer and context too.
  f.quote.mockImplementation((...args: unknown[]) =>
    q.quoter.quote(...(args as Parameters<CardRebateQuoter['quote']>)),
  );
  const outcome = await createLinkQuoteRunner(f.deps).run(agentCandidate, agentContext());
  return { product: productOf(outcome.cards), entrySources: entrySources(f.register) };
}
