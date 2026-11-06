// B1-28o rule-test kit: the hot list leaves out no_rebate cards (08 BR-PRICE-08, 热销榜 2026-11-05
// 补入; D10-691 S-11). Built on the frozen B1-28h kit's union side, candidates and memory Redis
// (synthetic data only). Cards come from the real single card entry over a quoter that answers per
// viewer: a title listed as without rebate for the current viewer quotes 0, which the card entry
// turns into rebate_basis = no_rebate (BR-PRICE-08: rebate_max_fen = 0 is no_rebate). Nothing here
// builds a vi.fn (B1-28h: a fixture per property run ran the worker out of heap).
import {
  createCatalogCardEntry,
  type CardQuoteContext,
  type RebateQuote,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  getHotRank,
  type HotRankCandidate,
  type HotRankData,
  type HotRankOptions,
  type HotRankPageRequest,
  type HotRankQuery,
  type HotRankUpstream,
  type HotRankUpstreamPage,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { cacheHotRankUpstream } from '../../../../apps/api/src/modules/catalog/infra/hot-rank-cache.ts';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/ports.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import { APP, NOW, TB_CHANNEL, channel, memoryRedis, unionSide } from '../hot-rank/kit.ts';

/** Rebate of every card not listed as without rebate (fen; min = max, a normal quote). */
const REBATE_FEN = 20n;

export const GUEST: Viewer = { appId: APP, userId: null, deviceId: 'synthetic-device' };

export function user(name: string): Viewer {
  return { appId: APP, userId: `synthetic-user-${name}`, deviceId: `synthetic-device-${name}` };
}

/** What the use case received from the (cached) upstream for one page call. */
export interface SeenPage {
  readonly input: HotRankPageRequest;
  readonly page: HotRankUpstreamPage;
  /** Card titles of the page as they were when it was handed over. */
  readonly titlesAtReturn: readonly string[];
}

export interface NoRebateSetup {
  /** Wrap the union side in cacheHotRankUpstream (memory Redis, the fixture's clock and config). */
  readonly cached?: boolean;
}

/** Only taobao's channel TB_CHANNEL, the whole list (no category). */
export function noRebateFixture(setup: NoRebateSetup = {}) {
  const clock = new FixedClock(NOW);
  let viewer: Viewer = GUEST;
  const viewerContext = { current: async (): Promise<Viewer> => viewer };
  const union = unionSide();
  const memory = memoryRedis();
  const config: CatalogConfigReader = { configValue: async () => null };

  /** Titles without rebate for every viewer. */
  const withoutRebate = new Set<string>();
  /** Titles without rebate for one user only, by user id. */
  const withoutRebateFor = new Map<string, Set<string>>();
  const quote = async (
    item: UnionItem,
    who: Viewer,
    context?: CardQuoteContext,
  ): Promise<RebateQuote> => {
    const own = who.userId === null ? undefined : withoutRebateFor.get(who.userId);
    const none = withoutRebate.has(item.title) || own?.has(item.title) === true;
    const fen = none ? 0n : REBATE_FEN;
    return {
      rebateMinFen: fen,
      rebateMaxFen: fen,
      estNetPriceFen: null,
      rebateBasis: context?.rebateBasis ?? 'normal',
    };
  };
  let registered = 0;
  const entry = createCatalogCardEntry({
    clock,
    viewerContext,
    quoter: { quote },
    registrar: {
      register: async () => ({
        linkId: `00000000-0000-7000-8000-${String(++registered).padStart(12, '0')}`,
      }),
    },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: () => undefined },
  });

  /** Channel positions per page number, for pages that lost positions upstream. */
  const positions = new Map<number, readonly number[]>();
  const side: HotRankUpstream = {
    categories: (input) => union.upstream.categories(input),
    async page(input) {
      const page = await union.upstream.page(input);
      const kept = positions.get(input.pageNo);
      return kept === undefined ? page : { ...page, positions: kept };
    },
  };
  const below =
    setup.cached === true
      ? cacheHotRankUpstream(side, { redis: memory.redis, clock, config })
      : side;
  const seen: SeenPage[] = [];
  const upstream: HotRankUpstream = {
    categories: (input) => below.categories(input),
    async page(input) {
      const page = await below.page(input);
      seen.push({ input, page, titlesAtReturn: titlesOf(page) });
      return page;
    },
  };
  const options: HotRankOptions = {
    clock,
    viewerContext,
    cards: entry,
    channels: () => ({ version: 'synthetic-1', channels: [channel('taobao', TB_CHANNEL)] }),
    upstream,
    logger: { warn: () => undefined },
  };

  return {
    memory,
    /** Every page call as the use case made it and what it got back. */
    seen,
    /** Stores channel page `pageNo`; `kept` is its positions (null: a page without the key). */
    setPage(
      pageNo: number,
      items: readonly HotRankCandidate[],
      hasMore = false,
      kept: readonly number[] | null = null,
    ) {
      union.setPage('taobao', TB_CHANNEL, null, pageNo, items, hasMore);
      if (kept === null) positions.delete(pageNo);
      else positions.set(pageNo, kept);
    },
    /** The candidates named here (`candidate(name)`) quote 0 for every viewer. */
    noRebate(...names: readonly string[]) {
      for (const name of names) withoutRebate.add(`synthetic-${name}`);
    },
    /** The candidates named here quote 0 for this viewer only. */
    noRebateFor(who: Viewer, ...names: readonly string[]) {
      const userId = who.userId ?? 'synthetic-missing-user';
      const own = withoutRebateFor.get(userId) ?? new Set<string>();
      for (const name of names) own.add(`synthetic-${name}`);
      withoutRebateFor.set(userId, own);
    },
    /** The viewer of the following runs. */
    as(next: Viewer) {
      viewer = next;
    },
    /** Page numbers the union side was asked for, in order. */
    pageNos(): number[] {
      return union.page.mock.calls.map(([input]) => input.pageNo);
    },
    /** Page requests that reached the union side, in order. */
    unionRequests(): HotRankPageRequest[] {
      return union.page.mock.calls.map(([input]) => input);
    },
    run(query: Partial<HotRankQuery> = {}) {
      return getHotRank({ platform: 'taobao', ...query }, options);
    },
  };
}

export function titlesOf(page: HotRankUpstreamPage): string[] {
  return page.items.map((entry) => entry.item.title);
}

/** [rank, title, sales_text] of every delivered item. */
export function rows(data: HotRankData): [number, string | null, string | null][] {
  return data.items.map((item) => [item.rank, item.product_card.title, item.sales_text]);
}

/**
 * Rows of `series(prefix, …)` candidates kept on a page whose positions are not dropped: the
 * channel position of `<prefix>-<n>` is n − 1 overall, so its rank is n and its sales `<n>件`.
 */
export function listed(prefix: string, numbers: readonly number[]): [number, string, string][] {
  return numbers.map((n) => [n, `synthetic-${prefix}-${String(n)}`, `${String(n)}件`]);
}

/** n = from .. to. */
export function span(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
}

export interface RankCursorClaims {
  readonly platform: string;
  readonly channel_id: string;
  readonly category_id: string | null;
  readonly page_no: number;
}

/** A cursor of the whole taobao list at `pageNo`, in the use case's wire form. */
export function cursorFor(pageNo: number): string {
  const claims: RankCursorClaims = {
    platform: 'taobao',
    channel_id: TB_CHANNEL,
    category_id: null,
    page_no: pageNo,
  };
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

/** The claims of an issued next_cursor; null stays null. */
export function claimsOf(cursor: string | null): RankCursorClaims | null {
  if (cursor === null) return null;
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as RankCursorClaims;
}

/** The claims a next_cursor to upstream page `pageNo` of the whole taobao list carries. */
export function claimsFor(pageNo: number): RankCursorClaims {
  return { platform: 'taobao', channel_id: TB_CHANNEL, category_id: null, page_no: pageNo };
}
