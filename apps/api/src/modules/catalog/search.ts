// B1-05d public search use case. Tests call this file directly; no forwarding-only entry.
// The HTTP controller will supply contract-validated query parameters and server-owned ports.
import type { components, operations } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import {
  GovernanceError,
  RedisUnavailableError,
  getMaterialChannels,
  type Clock,
} from '../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  isPriceAnomaly,
  type Platform,
  type UnionItem,
  type UnionPidService,
} from '../union/index.ts';
import type { ProductCard, UnlinkedCard } from './application/card-assembler.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import { CatalogError, categoryMissing } from './domain/rules.ts';
import type { Catalog, ProductRef } from './domain/types.ts';
import type { CatalogConfigReader, Viewer, ViewerContext } from './ports.ts';
import type { PriceSnapshotRecorder } from './price-history/types.ts';

export type SearchProductsQuery = operations['searchProducts']['parameters']['query'];
export type SearchProductsData = components['schemas']['SearchProductsData'];

export interface SearchCursor {
  readonly search_session_id: string;
  readonly page_no: number;
}

/** Encoding is deliberately opaque to clients; only these two claims may be encoded. */
export interface SearchCursorCodec {
  encode(value: SearchCursor): string;
  decode(value: string): unknown;
}

/** Normalized union public page, before caller-specific filtering or session deduplication. */
export interface SearchCandidate {
  readonly item: UnionItem;
  readonly ref: ProductRef;
}

export interface SearchUpstreamRequest {
  readonly appId: string;
  readonly platform: Platform;
  readonly keyword: string;
  readonly pageNo: number;
  readonly pageSize: number;
  readonly sort: 'relevance' | 'sales_desc';
  readonly hasCoupon?: boolean;
  readonly priceMinFen?: number;
  readonly promotionSlot: string;
}

export interface SearchUpstreamPage {
  readonly items: readonly SearchCandidate[];
  readonly hasMore: boolean;
  /**
   * True when the cache answered a union dependency failure with an entry inside the stale window
   * (BR-PROD-07 熔断降级): every card of the page carries stale=true and its original quoted_at.
   */
  readonly stale?: boolean;
  /**
   * True when the union continuation cursor of this page could not be remembered because Redis
   * was unavailable (02 §14, D6-8): the page is still delivered, but without a next cursor
   * (has_more keeps the union's value).
   */
  readonly cursorUnsaved?: boolean;
  /**
   * B1-17c: true only when this page is a fresh union return (set by the union side the module
   * wires under the cache; a cache hit or a stale entry never carries it). Only such a page is
   * handed to the price history recorder (BR-WATCH-19 (1)).
   */
  readonly fresh?: boolean;
}

/** Adapter/cache seam: B1-05g owns caching, not this use case. No product-pool fallback. */
export interface SearchUpstream {
  search(input: SearchUpstreamRequest): Promise<SearchUpstreamPage>;
  materialFeed(input: {
    readonly appId: string;
    readonly platform: Platform;
    readonly channelId: string;
    readonly limit: number;
    readonly promotionSlot: string;
  }): Promise<SearchUpstreamPage>;
}

export interface SearchSession {
  readonly appId: string;
  readonly requester: string;
  readonly query: SearchProductsQuery;
  readonly touchedAtMs: number;
  /** Issued product keys of the session, oldest first (BR-PROD-08 ②, at most 500). */
  readonly seen: readonly string[];
  /**
   * Parallel to `seen`: the cursor page (start page of the request) that first issued each key.
   * A request for page N excludes only keys issued by earlier pages, so retrying the same cursor
   * returns that page again instead of treating it as already seen (B1-05j followup ⑤).
   */
  readonly seenPages?: readonly number[];
  readonly dedupDisabled: boolean;
}

/** Redis-backed in the application; tests supply storage only, never dedup/expiry policy. */
export interface SearchSessionStore {
  read(appId: string, sessionId: string): Promise<SearchSession | null>;
  write(
    appId: string,
    sessionId: string,
    session: SearchSession,
    ttlSeconds: number,
  ): Promise<void>;
}

export interface SearchProductsOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly config: CatalogConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly catalog: Pick<Catalog, 'requirePlatform' | 'resolveProductKey'>;
  readonly cards: CatalogCardEntry;
  readonly upstream: SearchUpstream;
  readonly sessions: SearchSessionStore;
  readonly cursors: SearchCursorCodec;
  readonly newSessionId: () => string;
  readonly logger: Pick<Logger, 'warn'>;
  /**
   * B1-17c: the price history hook (BR-WATCH-19 (1), source_kind search). Absent, search behaves
   * exactly as before. Present, every candidate of a page with fresh === true is handed to
   * record() once (not awaited; a throw is swallowed; the response never changes).
   */
  readonly priceHistory?: PriceSnapshotRecorder;
  /**
   * B1-04zzx (FU-CATEGORY-BLOCKLIST step 3, D10-860): the category blocklist of the search tab.
   * Optional because frozen fixtures hand-write these options; CatalogModule passes its Catalog.
   * Absent, search behaves exactly as before. Present, the main results and the fallback feed pass
   * through filterCategories on every request (after the cache), with the
   * catalog_category_missing / catalog_category_blocked alerts.
   */
  readonly categoryFilter?: Pick<Catalog, 'filterCategories'>;
}

/** BR-PRICE-15: price bounds in fen, both ends inclusive. */
const PRICE_MIN_FEN = 1;
const PRICE_MAX_FEN = 10_000_000;
/** Contract Limit parameter: default 20, 1..50. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** BR-PROD-08 ②: a query session expires after 30 minutes without a request. */
export const SEARCH_SESSION_TTL_SECONDS = 1800;
/** BR-PROD-08 ②: at most 500 issued product keys; beyond that the session stops deduplicating. */
export const SEARCH_SEEN_LIMIT = 500;
/**
 * Highest cursor page_no (B1-05g, D6-2). 08 未定，技术取值: with limit ≤ 50 at most 5000 results;
 * it bounds walking back page by page through union calls. A larger page_no is 20001.
 */
export const SEARCH_MAX_PAGE_NO = 100;
/** TRADE-20: with no result, the platform's first 10 feed items. */
const FALLBACK_LIMIT = 10;

type SortCode = components['schemas']['SortCode'];

/** The query parameters that define a session (BR-PROD-07 cache parameters without page_no). */
interface SessionQuery {
  readonly platform: Platform;
  readonly q: string;
  readonly sort: SortCode;
  readonly has_coupon: boolean;
  readonly price_min_fen?: number;
  readonly price_max_fen?: number;
  readonly limit: number;
}

function invalid(message: string): never {
  throw new CatalogError(20001, `search: ${message}`);
}

function unavailable(platform: Platform, message: string, cause?: unknown): never {
  throw new CatalogError(
    50304,
    `search: ${message}`,
    { platform },
    cause === undefined ? undefined : { cause },
  );
}

/** Flat diagnostic fields of a swallowed error for the alert (no stack, no object dump). */
function errorFields(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      error_name: error.name,
      error_message: error.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { error_code: String(code) } : {}),
    };
  }
  return { error_name: typeof error, error_message: String(error) };
}

/**
 * In-process serialization of requests continuing the same search session, so two concurrent
 * requests with one cursor cannot both read the old session and drop each other's issued keys
 * (BR-PROD-08 ②, B1-05j followup ⑤). Entries are removed once their chain drains.
 */
const sessionLocks = new Map<string, Promise<void>>();

async function withSessionLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  sessionLocks.set(key, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (sessionLocks.get(key) === chained) sessionLocks.delete(key);
  }
}

function priceBound(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < PRICE_MIN_FEN ||
    value > PRICE_MAX_FEN
  ) {
    invalid(`${name} out of range`);
  }
  return value;
}

/** Validates and normalizes the query; any violation is 20001 before any upstream call. */
function normalizeQuery(query: SearchProductsQuery): SessionQuery {
  const min = priceBound(query.price_min_fen, 'price_min_fen');
  const max = priceBound(query.price_max_fen, 'price_max_fen');
  if (min !== undefined && max !== undefined && min > max) invalid('price_min_fen > price_max_fen');
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    invalid('limit out of range');
  }
  if (typeof query.q !== 'string' || query.q.length === 0) invalid('q is required');
  return {
    platform: query.platform,
    q: query.q,
    sort: query.sort ?? 'relevance',
    has_coupon: query.has_coupon === true,
    ...(min === undefined ? {} : { price_min_fen: min }),
    ...(max === undefined ? {} : { price_max_fen: max }),
    limit,
  };
}

function sameQuery(a: SearchProductsQuery, b: SessionQuery): boolean {
  return (
    a.platform === b.platform &&
    a.q === b.q &&
    a.sort === b.sort &&
    a.has_coupon === b.has_coupon &&
    a.price_min_fen === b.price_min_fen &&
    a.price_max_fen === b.price_max_fen &&
    a.limit === b.limit
  );
}

/** A cursor payload is exactly { search_session_id, page_no }; anything else is 20001. */
function parseCursor(payload: unknown): SearchCursor {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    invalid('malformed cursor');
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== 'page_no' || keys[1] !== 'search_session_id') {
    invalid('malformed cursor');
  }
  const { search_session_id: id, page_no: pageNo } = payload as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) invalid('malformed cursor');
  if (typeof pageNo !== 'number' || !Number.isSafeInteger(pageNo) || pageNo < 1) {
    invalid('malformed cursor');
  }
  if (pageNo > SEARCH_MAX_PAGE_NO) invalid('cursor page_no beyond the page cap');
  return { search_session_id: id, page_no: pageNo };
}

/** BR-PROD-08 ②: logged-in viewers by user_id, guests by device_id. */
function requesterOf(viewer: Viewer): string {
  if (viewer.userId !== null) return `user:${viewer.userId}`;
  return viewer.deviceId !== null ? `device:${viewer.deviceId}` : 'guest';
}

/**
 * Classifies an error thrown by the union upstream call (after the governed adapter's retries).
 * Business rejections keep their identity: an explicit `invalid_policy` from governance, a
 * UnionError with a business code (invalid DTO/identity, item unavailable, upstream_rejected …),
 * a DemoUnionError, or a CatalogError. Everything else is a dependency failure → 50304, never the
 * pool: governance timeout / circuit_open / quota_exceeded, UnionError upstream_unavailable /
 * rate_limited, and any other throw (network error, unknown error) so it never surfaces as 500.
 */
function isUnionOutage(error: unknown): boolean {
  if (error instanceof GovernanceError) return error.code !== 'invalid_policy';
  if (error instanceof UnionError) {
    return error.code === 'upstream_unavailable' || error.code === 'rate_limited';
  }
  if (error instanceof DemoUnionError || error instanceof CatalogError) return false;
  return true;
}

/** Errors the fallback feed may degrade on: the union side or a catalog refusal, nothing else. */
export function isFeedFailure(error: unknown): boolean {
  return (
    error instanceof GovernanceError ||
    error instanceof UnionError ||
    error instanceof DemoUnionError ||
    error instanceof CatalogError
  );
}

interface Issued {
  /** Priced card without a link; `commit` registers the link once the card is delivered. */
  readonly card: UnlinkedCard;
  readonly commit: () => Promise<ProductCard>;
  readonly item: UnionItem;
  /** resolveProductKey of the ref's key; null keys take no part in deduplication. */
  readonly key: string | null;
  /** Upstream (relevance) order across the fetched pages. */
  readonly order: number;
}

/** BR-PROD-08 ①: lowest final price, then highest rebate_max_fen, then earlier position. */
function better(a: Issued, b: Issued): boolean {
  if (a.item.final_price_fen !== b.item.final_price_fen) {
    return a.item.final_price_fen < b.item.final_price_fen;
  }
  const ar = a.card.rebate_max_fen ?? 0;
  const br = b.card.rebate_max_fen ?? 0;
  if (ar !== br) return ar > br;
  return a.order < b.order;
}

function dedupeSamePage(issued: readonly Issued[]): Issued[] {
  const winners = new Map<string, Issued>();
  for (const entry of issued) {
    if (entry.key === null) continue;
    const current = winners.get(entry.key);
    if (current === undefined || better(entry, current)) winners.set(entry.key, entry);
  }
  return issued.filter((entry) => entry.key === null || winners.get(entry.key) === entry);
}

/** TRADE-20: price and rebate sorts reorder only this response; ties keep upstream order. */
function sortPage(issued: Issued[], sort: SortCode): Issued[] {
  const byOrder = (a: Issued, b: Issued): number => a.order - b.order;
  if (sort === 'final_price_asc') {
    return issued.sort((a, b) =>
      a.item.final_price_fen === b.item.final_price_fen
        ? byOrder(a, b)
        : a.item.final_price_fen < b.item.final_price_fen
          ? -1
          : 1,
    );
  }
  if (sort === 'rebate_desc') {
    return issued.sort((a, b) => {
      const am = a.card.rebate_min_fen ?? 0;
      const bm = b.card.rebate_min_fen ?? 0;
      return am === bm ? byOrder(a, b) : bm - am;
    });
  }
  return issued.sort(byOrder);
}

/**
 * BR-PROD-07/08/10, BR-PRICE-08/15 and the B1-05d brief. Return the contract data body;
 * failures expose code and data for the HTTP envelope. Missing query PID defaults to 50304
 * plus an alert, as the task's replaceable policy pending owner confirmation specifies.
 *
 * Order: query validation (20001) → platform capability (30131) → search switch (50304
 * search_disabled, re-read every request) → cursor (20001) → session → query PID → upstream page,
 * at most one refill page → per-candidate filtering through the single card entry → same-page
 * dedupe → page sort → slice → session write → fallback feed on an empty first page.
 */
export async function searchProducts(
  query: SearchProductsQuery,
  options: SearchProductsOptions,
): Promise<SearchProductsData> {
  const { config, catalog, cursors } = options;
  const normalized = normalizeQuery(query);
  const { platform } = normalized;

  const viewer = await options.viewerContext.current();
  const { appId } = viewer;
  await catalog.requirePlatform(platform, { parseEnabled: false, searchEnabled: true });

  // BR-PROD-10 细则: only a boolean true opens search; anything else is off.
  const switchEntry = await config.configValue(appId, `search.enabled.${platform}`);
  if (switchEntry?.value !== true) {
    throw new CatalogError(50304, 'search: platform search switch is off', {
      platform,
      reason: 'search_disabled',
    });
  }

  const claims = query.cursor === undefined ? null : parseCursor(cursors.decode(query.cursor));
  const run = (): Promise<Continued> => searchPages(normalized, viewer, claims, options);
  const continued =
    claims === null
      ? await run()
      : await withSessionLock(JSON.stringify([appId, claims.search_session_id]), run);

  const fallbackItems =
    continued.firstPage && continued.items.length === 0
      ? await fallback(platform, appId, continued.promotionSlot, options)
      : [];

  return {
    items: continued.items,
    next_cursor: continued.nextCursor,
    has_more: continued.hasMore,
    fallback_items: fallbackItems,
  };
}

interface Continued {
  readonly firstPage: boolean;
  readonly items: ProductCard[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly promotionSlot: string;
}

/** Observe the entire fresh page, before delivery filters; alias lookup is also best effort. */
function recordSearchPage(
  page: SearchUpstreamPage,
  appId: string,
  options: SearchProductsOptions,
): void {
  const recorder = options.priceHistory;
  if (recorder === undefined || page.fresh !== true || page.stale === true) return;
  for (const { item, ref } of page.items) {
    const key = ref.productKey;
    if (key === null) continue;
    // Do not wait for history-only alias reads, or let a failed read affect the search.
    void Promise.resolve()
      .then(() => options.catalog.resolveProductKey(key))
      .then((productKey) =>
        recorder.record({
          appId,
          platform: item.platform,
          productKey,
          skuKey: item.skuId ?? null,
          sourceKind: 'search',
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
      )
      .catch(() => undefined);
  }
}

/**
 * B1-04zzx (D10-860): the category blocklist over one batch of candidates (one filterCategories
 * call, after the cache, so a changed list applies to the next request). Returns the blocked
 * candidates; without a categoryFilter port nothing is blocked and nothing is logged. Per platform,
 * items without a category are counted under catalog_category_missing (blocked ones included) and
 * blocked items under catalog_category_blocked (only when there are any); the alerts carry the
 * event code, the platform and the count only.
 */
async function blockedByCategory(
  candidates: readonly SearchCandidate[],
  appId: string,
  options: SearchProductsOptions,
): Promise<ReadonlySet<SearchCandidate>> {
  const filter = options.categoryFilter;
  if (filter === undefined || candidates.length === 0) return new Set();
  const judged = candidates.map((candidate) => ({
    platform: candidate.item.platform,
    categoryId: candidate.item.category_l1_id ?? null,
    title: candidate.item.title,
    candidate,
  }));
  const kept = new Set(await filter.filterCategories(appId, judged));
  const blocked = new Set<SearchCandidate>();
  const missing = new Map<Platform, number>();
  const blockedCount = new Map<Platform, number>();
  for (const entry of judged) {
    if (categoryMissing(entry.categoryId)) {
      missing.set(entry.platform, (missing.get(entry.platform) ?? 0) + 1);
    }
    if (kept.has(entry)) continue;
    blocked.add(entry.candidate);
    blockedCount.set(entry.platform, (blockedCount.get(entry.platform) ?? 0) + 1);
  }
  for (const [platform, count] of missing) {
    options.logger.warn(
      { event: 'catalog_category_missing', platform, count },
      'search: items without a category, judged by keyword rows only',
    );
  }
  for (const [platform, count] of blockedCount) {
    options.logger.warn(
      { event: 'catalog_category_blocked', platform, count },
      'search: items dropped by the category blocklist',
    );
  }
  return blocked;
}

/** Session read → upstream page(s) → cards → link registration of delivered cards → session write. */
async function searchPages(
  normalized: SessionQuery,
  viewer: Viewer,
  claims: SearchCursor | null,
  options: SearchProductsOptions,
): Promise<Continued> {
  const { clock, catalog, cards, upstream, sessions, cursors, logger } = options;
  const { platform, limit } = normalized;
  const { appId } = viewer;
  const nowMs = clock.now().getTime();
  const requester = requesterOf(viewer);

  // A continuation needs a live session of the same requester and the same query. An expired,
  // cleared or foreign session starts a new one at the cursor's page, its issued set empty
  // (BR-PROD-07 细则「会话异常」, D10-485); changed filters or sort start from page 1 only while the
  // session row still exists: an evicted row cannot be compared, so clients drop the cursor then.
  let sessionId: string | null = null;
  let session: SearchSession | null = null;
  let startPage = 1;
  if (claims !== null) {
    let stored: SearchSession | null;
    try {
      stored = await sessions.read(appId, claims.search_session_id);
    } catch (error: unknown) {
      // D6-8: a continuation cannot be deduplicated against an unreadable session; it fails as a
      // search dependency outage (50304 { platform }) instead of a 500 or a silent restart.
      if (!(error instanceof RedisUnavailableError)) throw error;
      logger.warn(
        { event: 'search_session_unavailable', platform, op: 'read', ...errorFields(error) },
        'search: session store unavailable, continuation refused',
      );
      unavailable(platform, 'search session store unavailable', error);
    }
    const querySame = stored === null || sameQuery(stored.query, normalized);
    if (querySame) startPage = claims.page_no;
    if (
      stored !== null &&
      querySame &&
      stored.appId === appId &&
      stored.requester === requester &&
      nowMs - stored.touchedAtMs <= SEARCH_SESSION_TTL_SECONDS * 1000
    ) {
      sessionId = claims.search_session_id;
      session = stored;
    }
  }
  const firstPage = session === null && startPage === 1;
  if (sessionId === null) sessionId = options.newSessionId();
  const seenList = [...(session?.seen ?? [])];
  // Sessions written before seenPages existed count every key as issued by an earlier page.
  const seenPages = seenList.map((_key, index) => session?.seenPages?.[index] ?? 0);
  const seenAt = new Map<string, number>(seenList.map((key, index) => [key, seenPages[index]!]));
  let dedupDisabled = session?.dedupDisabled ?? false;
  /** BR-PROD-08 ②: excluded only when an earlier page issued it (a retried page is not "later"). */
  const excluded = (key: string): boolean => {
    const page = seenAt.get(key);
    return page !== undefined && page < startPage;
  };

  // BR-PROD-07: fixed query-only promotion slot, no relation_id; missing → 50304 + alert.
  const pid = await options.pids.getActivePid({
    appId,
    platform,
    pidScene: 'query',
    purpose: 'query',
  });
  if (pid === null) {
    logger.warn(
      { event: 'search_query_pid_missing', platform },
      'search: no active query promotion slot, treated as union unavailable',
    );
    unavailable(platform, 'no active query promotion slot');
  }

  const request = (pageNo: number): SearchUpstreamRequest => ({
    appId,
    platform,
    keyword: normalized.q,
    pageNo,
    pageSize: limit,
    sort: normalized.sort === 'sales_desc' ? 'sales_desc' : 'relevance',
    ...(normalized.has_coupon ? { hasCoupon: true } : {}),
    ...(normalized.price_min_fen === undefined ? {} : { priceMinFen: normalized.price_min_fen }),
    promotionSlot: pid.pid,
  });

  const issued: Issued[] = [];
  let order = 0;
  const take = async (candidates: readonly SearchCandidate[], stale: boolean): Promise<void> => {
    // B1-04zzx: one blocklist call per page; blocked items are skipped like price-filtered ones
    // (never issued, never in the session), and the existing refill covers a short page.
    const blocked = await blockedByCategory(candidates, appId, options);
    for (const candidate of candidates) {
      const { item, ref } = candidate;
      const position = order++;
      // Anomalies go to the card entry, which logs PRICE_ANOMALY and skips them before any price
      // filter, quote or link registration (B1-05i).
      if (isPriceAnomaly(item)) {
        await cards.assemble({
          item,
          ref,
          entrySource: 'search',
          stale,
          scene: 'retrieval',
        });
        continue;
      }
      if (blocked.has(candidate)) continue;
      const final = item.final_price_fen;
      if (normalized.price_min_fen !== undefined && final < BigInt(normalized.price_min_fen)) {
        continue;
      }
      if (normalized.price_max_fen !== undefined && final > BigInt(normalized.price_max_fen)) {
        continue;
      }
      if (normalized.has_coupon && item.coupon_fen <= 0n) continue;
      const key = ref.productKey === null ? null : await catalog.resolveProductKey(ref.productKey);
      if (key !== null && !dedupDisabled && excluded(key)) continue;
      // The link is registered only for delivered cards (B1-05j followup ⑥), after the slice.
      const result = await cards.assemble({
        item,
        ref,
        entrySource: 'search',
        stale,
        scene: 'retrieval',
        deferLink: true,
      });
      if (result.kind !== 'prepared') continue;
      // BR-PRICE-08: search never shows no_rebate cards.
      if (result.card.rebate_basis === 'no_rebate') continue;
      issued.push({ card: result.card, commit: result.commit, item, key, order: position });
    }
  };

  let page: SearchUpstreamPage;
  try {
    page = await upstream.search(request(startPage));
  } catch (error: unknown) {
    if (!isUnionOutage(error)) throw error;
    // Followup ①/③: whatever was swallowed (exhausted network retries, a timeout, an adapter
    // defect) stays on the 50304 as its cause and reaches the alert with its message.
    logger.warn(
      { event: 'search_union_unavailable', platform, page_no: startPage, ...errorFields(error) },
      'search: union search unavailable',
    );
    unavailable(platform, 'union search unavailable', error);
  }
  let lastPage = startPage;
  let hasMore = page.hasMore;
  // D6-8: a page whose union cursor could not be remembered gets no next_cursor in this response.
  let cursorLost = page.cursorUnsaved === true;
  recordSearchPage(page, appId, options);
  await take(page.items, page.stale === true);

  // BR-PRICE-08: at most one refill page; has_more follows the last upstream page. The refill
  // never asks the union for a page beyond SEARCH_MAX_PAGE_NO (checked before the request).
  if (
    dedupeSamePage(issued).length < limit &&
    page.hasMore &&
    startPage + 1 <= SEARCH_MAX_PAGE_NO
  ) {
    let refill: SearchUpstreamPage | null = null;
    try {
      refill = await upstream.search(request(startPage + 1));
    } catch (error: unknown) {
      if (!isUnionOutage(error)) throw error;
      // A refill outage must not pass for "no result": with nothing deliverable from the first
      // page this is the same 50304 { platform } as a first-page outage (no fallback feed);
      // otherwise degrade to the first page's cards and its upstream has_more, with an alert.
      const empty = dedupeSamePage(issued).length === 0;
      logger.warn(
        {
          event: 'search_refill_unavailable',
          platform,
          page_no: startPage + 1,
          ...errorFields(error),
        },
        empty
          ? 'search: refill page unavailable and nothing deliverable'
          : 'search: refill page unavailable, returning the first page only',
      );
      if (empty) unavailable(platform, 'union search unavailable on the refill page', error);
    }
    if (refill !== null) {
      lastPage = startPage + 1;
      hasMore = refill.hasMore;
      if (refill.cursorUnsaved === true) cursorLost = true;
      recordSearchPage(refill, appId, options);
      await take(refill.items, refill.stale === true);
    }
  }

  const delivered = sortPage(dedupeSamePage(issued), normalized.sort).slice(0, limit);

  // Followup ⑥: only delivered cards register a link (in delivery order); candidates that passed
  // the filters but lost a duplicate or fell beyond the limit write nothing.
  const items: ProductCard[] = [];
  for (const entry of delivered) items.push(await entry.commit());

  // BR-PROD-08 ②: only issued keys enter the seen set; beyond 500 the session stops deduping,
  // keeping the older keys and dropping the new ones.
  for (const entry of delivered) {
    if (entry.key === null || seenAt.has(entry.key)) continue;
    if (seenList.length >= SEARCH_SEEN_LIMIT) {
      dedupDisabled = true;
      continue;
    }
    seenAt.set(entry.key, startPage);
    seenList.push(entry.key);
    seenPages.push(startPage);
  }
  let continuable = true;
  if (cursorLost) {
    logger.warn(
      { event: 'search_cursor_ledger_unavailable', platform, page_no: lastPage },
      'search: union cursor ledger unavailable, returning this page without a next cursor',
    );
    continuable = false;
  }
  try {
    await sessions.write(
      appId,
      sessionId,
      {
        appId,
        requester,
        query: normalized,
        touchedAtMs: nowMs,
        seen: seenList,
        seenPages,
        dedupDisabled,
      },
      SEARCH_SESSION_TTL_SECONDS,
    );
  } catch (error: unknown) {
    // D6-8 (02 §14): with Redis unavailable the priced and registered page is still delivered,
    // but no next cursor is issued — cross-page deduplication cannot be guaranteed. Only the
    // platform/redis unavailability is degraded; CAS contention (50304) and defects propagate.
    if (!(error instanceof RedisUnavailableError)) throw error;
    logger.warn(
      { event: 'search_session_unavailable', platform, op: 'write', ...errorFields(error) },
      'search: session store unavailable, returning this page without a next cursor',
    );
    continuable = false;
  }
  // The page cap and D6-8 only withhold next_cursor: no cursor is issued beyond
  // SEARCH_MAX_PAGE_NO or without a stored session / cursor ledger. has_more stays as the union
  // reported it (SearchProductsData.has_more, BR-PRICE-08), never rewritten by our own limits.
  const more = continuable && hasMore && lastPage + 1 <= SEARCH_MAX_PAGE_NO;
  return {
    firstPage,
    items,
    nextCursor: more
      ? cursors.encode({ search_session_id: sessionId, page_no: lastPage + 1 })
      : null,
    hasMore,
    promotionSlot: pid.pid,
  };
}

/**
 * TRADE-20: an empty first page shows the platform's first 10 feed items from the selectable
 * whitelisted channel (CT-15m; an empty whitelist gives an empty list). Search filters do not
 * apply, except the category blocklist (04「检索与物料流过滤」, B1-04zzx); anomalies and no_rebate
 * items are still dropped through the single card entry.
 */
async function fallback(
  platform: Platform,
  appId: string,
  promotionSlot: string,
  options: SearchProductsOptions,
): Promise<ProductCard[]> {
  const channel = getMaterialChannels().channels.find(
    (entry) => entry.platform === platform && entry.selectable === true,
  );
  if (channel === undefined) return [];
  let page: SearchUpstreamPage;
  try {
    page = await options.upstream.materialFeed({
      appId,
      platform,
      channelId: channel.channel_id,
      limit: FALLBACK_LIMIT,
      promotionSlot,
    });
  } catch (error: unknown) {
    // Followup ②: the fallback is a courtesy list; an outage or a business refusal of the feed
    // (rejected, item unavailable, invalid policy, unsupported) degrades to an empty list with an
    // alert instead of failing the whole search. B1-05g ③: only union, governance, demo and
    // catalog errors are swallowed; a programming defect (TypeError …) fails the search.
    if (!isFeedFailure(error)) throw error;
    options.logger.warn(
      {
        event: isUnionOutage(error) ? 'search_fallback_unavailable' : 'search_fallback_rejected',
        platform,
        channel_id: channel.channel_id,
        ...errorFields(error),
      },
      'search: fallback feed failed, returning no fallback items',
    );
    return [];
  }
  const cardsOut: ProductCard[] = [];
  recordSearchPage(page, appId, options);
  const keys = new Set<string>();
  const blocked = await blockedByCategory(page.items, appId, options);
  for (const candidate of page.items) {
    const { item, ref } = candidate;
    if (cardsOut.length >= FALLBACK_LIMIT) break;
    if (blocked.has(candidate)) continue;
    const key =
      isPriceAnomaly(item) || ref.productKey === null
        ? null
        : await options.catalog.resolveProductKey(ref.productKey);
    if (key !== null && keys.has(key)) continue;
    const result = await options.cards.assemble({
      item,
      ref,
      entrySource: 'search',
      stale: false,
      scene: 'retrieval',
      deferLink: true,
    });
    if (result.kind !== 'prepared' || result.card.rebate_basis === 'no_rebate') continue;
    if (key !== null) keys.add(key);
    // Delivered: register its link now (a dropped no_rebate item registers nothing).
    cardsOut.push(await result.commit());
  }
  return cardsOut;
}
