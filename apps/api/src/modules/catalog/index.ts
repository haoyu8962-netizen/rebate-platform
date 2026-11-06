// Public surface of the catalog module (规划/02 §4.1); other modules import only from this file.
// Task B1-05c: platform dictionary (BR-PROD-10), product_refs registration and the raw-ID order
// (BR-PROD-05), alias resolution resolveProductKey and isSameProduct (BR-PROD-01, BR-PROD-02),
// the category blocklist filter, and the five ports catalog uses. Rule tests:
// test/spec/catalog/base/**. Task B1-05h: item_ref issue/verify (BR-PROD-11), rule tests
// test/spec/catalog/item-ref/**. Task B1-05f: CardAssembler (priced ProductCard per request,
// BR-PRICE-01/06/07/08/09/11/17/21) and the non-production demo quoter, rule tests
// test/spec/catalog/card/**; no Nest provider until B1-06c wires the link registrar.
// Task B1-05i: createCatalogCardEntry, the single card entry split by D33 price state (retrieval
// skips a price anomaly, an active query fails closed with price_unavailable; PRICE_ANOMALY is
// logged there), rule tests test/spec/catalog/price-state/**. Task B1-05d: searchProducts, the
// single-platform search use case (BR-PROD-07/08/10, BR-PRICE-08/15), rule tests
// test/spec/catalog/search/**. Task B1-05j: its HTTP route GET /v1/products/search (controller
// in CatalogModule, ports from app.module's global providers), rule tests
// test/spec/catalog/search-route/**. Task B1-05e: getProduct, GET /v1/products/{product_key}
// (ProductController in CatalogModule), rule tests test/spec/catalog/detail/**.
export { createCatalogCardEntry } from './application/card-entry.ts';
export type {
  CatalogCardEntry,
  CatalogCardEntryOptions,
  CatalogCardInput,
  CatalogCardResult,
  CatalogCardScene,
} from './application/card-entry.ts';
export { CatalogSearchService } from './application/search-service.ts';
export { CatalogDetailService } from './application/detail-service.ts';
export { CatalogHotRankService } from './application/hot-rank-service.ts';
export { HOT_RANK_MAX_PAGE_NO, HOT_RANK_PAGE_SIZE, getHotRank } from './hot-rank.ts';
export type {
  HotRankCandidate,
  HotRankCategoryEntry,
  HotRankData,
  HotRankOptions,
  HotRankQuery,
  HotRankUpstream,
  HotRankUpstreamPage,
} from './hot-rank.ts';
// Task B1-05o: GET /v1/pages/{page_key}/sections/{section_id}/items, the union_material data source
// (SectionItemsController in CatalogModule), rule tests test/spec/catalog/section-items/**.
export { CatalogSectionItemsService } from './application/section-items-service.ts';
export { getSectionItems } from './section-items.ts';
export type {
  PageSectionItemsData,
  SectionItemsOptions,
  SectionItemsPages,
  SectionItemsQuery,
  SectionItemsSection,
} from './section-items.ts';
export { getProduct } from './detail.ts';
export type {
  ProductDetailData,
  ProductDetailOptions,
  ProductDetailQuery,
  ProductDetailRequest,
  ProductDetailUpstream,
} from './detail.ts';
// Task B1-06j: the read-only product port of the link landing card (product_refs first, then one
// governed union detail by the snapshot's raw ID; no registration, no write, no conversion).
export { CatalogProductReader, createCatalogProductReader } from './application/product-reader.ts';
export type {
  CatalogProductQuery,
  CatalogProductReaderOptions,
  CatalogProductRefs,
  CatalogProductSummary,
} from './application/product-reader.ts';
export { createDbCatalogProductReader } from './infra/product-reader-wiring.ts';
// B3-03j: the uncached union search and detail sides, for the stream entry's Agent tools (app.module
// wires them; the Agent reads fresh, outside the HTTP search session and the detail cache).
export { createUnionSearchUpstream } from './infra/search-wiring.ts';
export type { UnionSearchUpstreamOptions } from './infra/search-wiring.ts';
export { createUnionDetailUpstream } from './infra/detail-wiring.ts';
export { PRODUCT_CACHE_NAMESPACE } from './infra/product-cache.ts';
export { createCatalog } from './application/catalog.ts';
export { SEARCH_SEEN_LIMIT, SEARCH_SESSION_TTL_SECONDS, searchProducts } from './search.ts';
export type {
  SearchCandidate,
  SearchCursor,
  SearchCursorCodec,
  SearchProductsData,
  SearchProductsOptions,
  SearchProductsQuery,
  SearchSession,
  SearchSessionStore,
  SearchUpstream,
  SearchUpstreamPage,
  SearchUpstreamRequest,
} from './search.ts';
export type { CatalogOptions } from './application/catalog.ts';
export { createCardAssembler, createDemoRebateQuoter } from './application/card-assembler.ts';
export type {
  AssembleCardInput,
  CardAssembler,
  CardAssemblerOptions,
  CardQuoteContext,
  CardRebateQuoter,
  DemoQuoteRule,
  DemoRebateQuoterOptions,
  PreparedCard,
  ProductCard,
  UnlinkedCard,
} from './application/card-assembler.ts';
// Task B1-15w: the buy_type=share quote of POST /v1/shares (BR-PRICE-06), same quoter port.
export { SHARE_ENTRY_SOURCE, quoteShare, settleShareQuote } from './application/share-quote.ts';
export type { ShareEstPromo, ShareQuote, ShareQuoteContext } from './application/share-quote.ts';
export { createItemRefService } from './application/item-ref.ts';
export { processItemRefCipher } from './infra/process-item-ref-cipher.ts';
export type {
  ItemRefClaims,
  ItemRefOptions,
  ItemRefRequest,
  ItemRefService,
} from './application/item-ref.ts';
// Task B1-05zg (BR-TEXT-12 购买按钮): the one button-key rule, for cards re-based outside catalog.
export { ctaKeyFor } from './domain/card.ts';
export type { CtaBasis } from './domain/card.ts';
export { CatalogError, RAW_ID_MAX_AGE_MS } from './domain/rules.ts';
export type { CatalogErrorCode } from './domain/rules.ts';
export type {
  Catalog,
  CatalogWarning,
  CategoryCandidate,
  PlatformRecord,
  ProductCapabilities,
  ProductIdentity,
  ProductRef,
  ProductRefSource,
  RawItemRequest,
  RawItemResult,
  ReparseResult,
  RequestRawRef,
} from './domain/types.ts';
export {
  CatalogConfigReader,
  GovernedUnion,
  LinkRegistrar,
  POOL_EXTRA_JOBS,
  RebateQuoter,
  SourceLinkReader,
  ViewerContext,
  createGuestViewerContext,
} from './ports.ts';
export type { PoolExtraJobs, RebateQuote, RegisterLinkInput, Viewer } from './ports.ts';
export { CATALOG, CatalogModule } from './catalog.module.ts';
// Task B1-05q: /admin/v1/product-pools* (CT-07d, content.pool) on the admin entry, rule tests
// test/spec/catalog/product-pool-admin/**.
export { CatalogAdminModule } from './catalog-admin.module.ts';
export type { CatalogAdminOptions } from './catalog-admin.module.ts';
export { CatalogWorkerModule } from './catalog-worker.module.ts';
export type { CatalogWorkerOptions } from './catalog-worker.module.ts';
export type {
  PoolLinkAdapters,
  PoolLinkAnswer,
  PoolLinkCandidate,
  PoolLinkParser,
} from './application/pool-source.ts';
export { createPriceHistoryRecorder, type PriceHistoryWiring } from './catalog.module.ts';
export * from './price-history/index.ts';
export * from './price-trend/index.ts';
export type { CatalogConfigReaderFactory } from './catalog.module.ts';
export * from './favorites/index.ts';
// Task B1-05m: GET /v1/search/hot-words (HotWordsController in CatalogModule) and the save checks
// of search.hot_words / search.keyword_routes (app.module hands searchConfigSaveCheck to content's
// configuration center), rule tests test/spec/catalog/hot-words/**.
export * from './hot-words/index.ts';
