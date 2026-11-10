// B3-04b: the shared search pipeline behind search_products and the keyword fallback.
// BR-PROD-10 (only switched-on platforms, re-read every call), BR-AI-08 (closed final-price range
// re-checked after the upstream answer), BR-AI-09 (upstream rank interleave, no commission or
// rebate weight, fixed tie order), BR-AI-04 (required fields, cache age), BR-AI-11 (no
// pre-conversion: only delivered cards register a link; guest login_to_view), BR-AI-18 (prohibited
// keyword / category blocklist).
import type { SearchProductsQuery } from '../../../catalog/index.ts';
import type { ToolCallContext } from '../registry/index.ts';
import type { AgentSearchCandidate, SearchProductsDeps } from './types.ts';
import {
  maskLoginToView,
  normalizeCard,
  type AgentProductCard,
  type AgentUnlinkedCard,
} from './card.ts';
import type { SearchBenefit, SearchSort } from './schema.ts';

export type Platform = SearchProductsQuery['platform'];

export interface SearchRequest {
  readonly q: string;
  /** Requested platforms; undefined means every switched-on platform. */
  readonly platforms?: readonly string[];
  readonly sort: SearchSort;
  readonly priceMinFen?: number;
  readonly priceMaxFen?: number;
  readonly pageSize: number;
  /** B3-04e · BR-AI-05: 1-based page, the same for every platform. */
  readonly page: number;
  /**
   * B3-04e · BR-AI-08: the model's spec word, kept verbatim. It is not part of the upstream q
   * and filters nothing here; the spec judgement on the card belongs to B3-04d.
   */
  readonly spec?: string;
  /**
   * B3-04k · 04 §8.5: benefit conditions re-checked on the server (coupon ⇔ coupon_fen > 0).
   * taolijin never reaches this pipeline (BR-AI-17, handled by the handler). Never relaxed.
   */
  readonly benefits?: readonly SearchBenefit[];
  /** B3-04k: joined into the upstream search words only (brand, q, category_hint). */
  readonly brand?: string;
  readonly categoryHint?: string;
  /** B3-04k: a card whose title contains any of these (NFKC, case-insensitive) is dropped. */
  readonly excludeKeywords?: readonly string[];
}

export type PlatformStatus = 'ok' | 'failed' | 'disabled';

export interface SearchRun {
  readonly prohibited: boolean;
  /** At least one platform was searched and every searched platform failed. */
  readonly allFailed: boolean;
  readonly status: ReadonlyMap<Platform, PlatformStatus>;
  readonly cards: readonly AgentProductCard[];
}

interface Ranked {
  readonly candidate: AgentSearchCandidate;
  readonly rank: number;
}

interface Prepared {
  readonly ranked: Ranked;
  readonly card: AgentUnlinkedCard;
  /** BR-AI-11 guest switch: hide the rebate only after sorting and selection. */
  readonly hideRebate: boolean;
  readonly commit: () => Promise<{ readonly link_id: string }>;
}

async function configValue(deps: SearchProductsDeps, appId: string, key: string): Promise<unknown> {
  try {
    return (await deps.config.configValue(appId, key))?.value ?? null;
  } catch {
    // Unreadable setting: fail closed to the default.
    return null;
  }
}

/** BR-PROD-10: a platform searches only on an explicit true; missing or unreadable is off. */
export async function enabledPlatforms(
  deps: SearchProductsDeps,
  appId: string,
): Promise<Platform[]> {
  const flags = await Promise.all(
    deps.platforms.map(
      async (platform) => (await configValue(deps, appId, `search.enabled.${platform}`)) === true,
    ),
  );
  return deps.platforms.filter((_, index) => flags[index]);
}

/** BR-AI-04: search cache age cap, default 300 s; configuration may only lower it. */
async function maxAgeSec(deps: SearchProductsDeps, appId: string): Promise<number> {
  const cap = 300;
  const value = await configValue(deps, appId, 'agent.search_cache_ttl_s');
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), cap)
    : cap;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Descending with null last. */
function compareDesc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** BR-AI-09: every sort ends with final_price_fen ascending, then product_key ascending. */
function tieBreak(a: Prepared, b: Prepared): number {
  return (
    a.card.final_price_fen - b.card.final_price_fen ||
    compareText(a.card.product_key, b.card.product_key)
  );
}

/** BR-AI-09: no comparator reads commission, and relevance reads no rebate either. */
function comparator(sort: SearchSort): (a: Prepared, b: Prepared) => number {
  switch (sort) {
    case 'relevance':
      return (a, b) => a.ranked.rank - b.ranked.rank || tieBreak(a, b);
    case 'final_price_asc':
      return tieBreak;
    case 'rebate_desc':
      return (a, b) =>
        compareDesc(a.card.rebate_min_fen, b.card.rebate_min_fen) ||
        compareDesc(a.card.rebate_max_fen, b.card.rebate_max_fen) ||
        tieBreak(a, b);
    case 'sales_desc':
      return (a, b) =>
        compareDesc(a.ranked.candidate.sales, b.ranked.candidate.sales) || tieBreak(a, b);
  }
}

function inPriceRange(card: AgentUnlinkedCard, request: SearchRequest): boolean {
  const price = card.final_price_fen;
  if (request.priceMinFen !== undefined && price < request.priceMinFen) return false;
  if (request.priceMaxFen !== undefined && price > request.priceMaxFen) return false;
  return true;
}

/** B3-04k: brand / category_hint only narrow the search words, in the order brand, q, hint. */
export function upstreamKeyword(request: SearchRequest): string {
  return [request.brand, request.q, request.categoryHint]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ');
}

/** B3-04k: NFKC then lower case, for exclude-keyword matching. */
function foldText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * B3-04k: the server-side benefit and exclude-word conditions, applied in the same step as the
 * price range. coupon reads the final card's coupon_fen, the same judgement as the 有券 tag.
 */
function meetsConditions(
  card: AgentUnlinkedCard,
  candidate: AgentSearchCandidate,
  request: SearchRequest,
): boolean {
  if (request.benefits?.includes('coupon') === true && !(card.coupon_fen > 0)) return false;
  const words = (request.excludeKeywords ?? []).map(foldText).filter((word) => word !== '');
  if (words.length === 0) return true;
  const titles = [card.title, candidate.item.title]
    .filter((title): title is string => typeof title === 'string')
    .map(foldText);
  return !titles.some((title) => words.some((word) => title.includes(word)));
}

function upstreamQuery(platform: Platform, request: SearchRequest): SearchProductsQuery {
  return {
    platform,
    q: upstreamKeyword(request),
    // BR-AI-09: the upstream is asked for an order without commission weight; final-price and
    // rebate orders are computed here over the relevance candidates.
    sort: request.sort === 'sales_desc' ? 'sales_desc' : 'relevance',
    limit: request.pageSize,
    ...(request.priceMinFen === undefined ? {} : { price_min_fen: request.priceMinFen }),
    ...(request.priceMaxFen === undefined ? {} : { price_max_fen: request.priceMaxFen }),
  };
}

async function allowedByCategory(
  deps: SearchProductsDeps,
  appId: string,
  row: AgentSearchCandidate,
): Promise<boolean> {
  try {
    return (await deps.categoryAllowed(appId, row)) === true;
  } catch {
    return false;
  }
}

export async function runSearch(
  deps: SearchProductsDeps,
  request: SearchRequest,
  ctx: ToolCallContext,
): Promise<SearchRun> {
  const { appId } = ctx;
  const status = new Map<Platform, PlatformStatus>();

  // BR-AI-18: a prohibited model keyword never reaches the upstream (brand and hint included).
  if (await deps.prohibited(appId, upstreamKeyword(request))) {
    return { prohibited: true, allFailed: false, status, cards: [] };
  }

  const enabled = await enabledPlatforms(deps, appId);
  const requested =
    request.platforms === undefined
      ? enabled
      : enabled.filter((platform) => request.platforms!.includes(platform));
  for (const platform of deps.platforms) status.set(platform, 'disabled');
  const allFailed = () =>
    requested.length > 0 && requested.every((platform) => status.get(platform) === 'failed');

  // All platforms start before any answer returns; one failure leaves the others intact.
  const answers = await Promise.allSettled(
    requested.map((platform) =>
      deps.searchProducts(upstreamQuery(platform, request), ctx, request.page),
    ),
  );
  const ranked: Ranked[] = [];
  const seen = new Set<string>();
  answers.forEach((answer, index) => {
    const platform = requested[index]!;
    if (answer.status === 'rejected' || !Array.isArray(answer.value)) {
      status.set(platform, 'failed');
      return;
    }
    status.set(platform, 'ok');
    // BR-AI-09: only the first K by upstream rank; the rank survives later filtering.
    answer.value.slice(0, request.pageSize).forEach((candidate, rank) => {
      const key = candidate.ref.productKey;
      if (candidate.item.platform !== platform || seen.has(key)) return;
      seen.add(key);
      ranked.push({ candidate, rank });
    });
  });
  if (ranked.length === 0) return { prohibited: false, allFailed: allFailed(), status, cards: [] };

  // BR-AI-18: category blocklist; emptied by it means prohibited, never relaxed.
  const allowedFlags = await Promise.all(
    ranked.map((row) => allowedByCategory(deps, appId, row.candidate)),
  );
  const allowed = ranked.filter((_, index) => allowedFlags[index]);
  if (allowed.length === 0) return { prohibited: true, allFailed: false, status, cards: [] };

  const [ageCap, loginToView] = await Promise.all([
    maxAgeSec(deps, appId),
    guestLoginToView(deps, ctx, allowed),
  ]);
  const nowMs = deps.clock.now().getTime();
  const entry = deps.cardEntry(ctx);
  // A quote / item_ref failure drops only that item (allSettled), never the other platforms.
  const settled = await Promise.allSettled(
    allowed.map(async (row): Promise<Prepared | null> => {
      const { candidate } = row;
      const result = await entry.assemble({
        item: candidate.item,
        ref: candidate.ref,
        entrySource: 'agent',
        stale: false,
        scene: 'retrieval',
        deferLink: true,
      });
      if (result.kind !== 'prepared' && result.kind !== 'card') return null;
      const card = normalizeCard(result.card, {
        productKey: candidate.ref.productKey,
        nowMs,
        maxAgeSec: ageCap,
        loginToView: loginToView.has(candidate.item.platform),
      });
      const hideRebate = loginToView.has(candidate.item.platform);
      if (
        card === null ||
        !inPriceRange(card, request) ||
        !meetsConditions(card, candidate, request)
      ) {
        return null;
      }
      const linked = result.kind === 'card' ? result.card : null;
      const commit =
        linked === null && result.kind === 'prepared'
          ? result.commit
          : async () => ({ link_id: linked!.link_id });
      return { ranked: row, card, hideRebate, commit };
    }),
  );
  // A platform whose every item failed to assemble counts as a failed platform (BR-AI-09
  // platform failure), so the degraded path never reports it as an empty success.
  const tried = new Map<Platform, { total: number; thrown: number }>();
  settled.forEach((outcome, index) => {
    const platform = allowed[index]!.candidate.item.platform;
    const count = tried.get(platform) ?? { total: 0, thrown: 0 };
    count.total += 1;
    if (outcome.status === 'rejected') count.thrown += 1;
    tried.set(platform, count);
  });
  for (const [platform, count] of tried) {
    if (count.total > 0 && count.thrown === count.total) status.set(platform, 'failed');
  }
  const prepared = settled.map((outcome) =>
    outcome.status === 'fulfilled' ? outcome.value : null,
  );

  const chosen = prepared
    .filter((row): row is Prepared => row !== null)
    .toSorted(comparator(request.sort))
    .slice(0, request.pageSize);

  // BR-AI-11 / B1-05j: register links only for the cards actually delivered.
  const committed = await Promise.allSettled(chosen.map((row) => row.commit()));
  const cards: AgentProductCard[] = [];
  const registered = new Map<Platform, { total: number; ok: number }>();
  committed.forEach((outcome, index) => {
    const row = chosen[index]!;
    const count = registered.get(row.card.platform) ?? { total: 0, ok: 0 };
    count.total += 1;
    registered.set(row.card.platform, count);
    if (outcome.status !== 'fulfilled') return;
    const linkId = outcome.value.link_id;
    if (typeof linkId !== 'string' || linkId === '') return;
    count.ok += 1;
    const card = row.hideRebate ? maskLoginToView(row.card) : row.card;
    cards.push({ ...card, link_id: linkId });
  });
  // Same platform-failure rule as assembly: every registration of a platform failing makes the
  // platform failed, so the degraded path reports a failure (50302), not an empty result.
  for (const [platform, count] of registered) {
    if (count.total > 0 && count.ok === 0) status.set(platform, 'failed');
  }
  return { prohibited: false, allFailed: allFailed(), status, cards };
}

/** BR-AI-11: guests only; the per-platform switch defaults to off. */
async function guestLoginToView(
  deps: SearchProductsDeps,
  ctx: ToolCallContext,
  rows: readonly Ranked[],
): Promise<ReadonlySet<Platform>> {
  if (ctx.userId !== null) return new Set();
  const platforms = [...new Set(rows.map((row) => row.candidate.item.platform))];
  const flags = await Promise.all(
    platforms.map(
      async (platform) =>
        (await configValue(deps, ctx.appId, `agent.guest_login_to_view.${platform}`)) === true,
    ),
  );
  return new Set(platforms.filter((_, index) => flags[index]));
}
