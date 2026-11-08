// B1-04zzzz (FU-CATEGORY-BLOCKLIST-HOME, step 4; D10-860 ⑦ / D10-961 / D10-1045): the category
// blocklist of the hot-sales list (getHotRank) and of the home feed's union_material sections
// (getSectionItems). Frozen kits are reused read-only: the hot list kit (storage-only union side,
// memory Redis, real card entry over fake quoter and registrar), the section kit, and the search
// tab's blocklist model (category-blocklist-search/kit.ts: an in-memory filterCategories port over
// active rows per app, same D10-860 rules). The port is the optional `categoryFilter` option of both
// use cases; frozen fixtures leave it out. No vi.fn here: property runs build a fixture per sample.
// All values are synthetic.
import {
  getHotRank,
  type HotRankCandidate,
  type HotRankData,
  type HotRankOptions,
  type HotRankQuery,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import type {
  PoolCandidate,
  PoolPageRequest,
  PoolReader,
} from '../../../../apps/api/src/modules/catalog/application/pool-read.ts';
import { cacheHotRankUpstream } from '../../../../apps/api/src/modules/catalog/infra/hot-rank-cache.ts';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  getSectionItems,
  type PageSectionItemsData,
  type SectionItemsOptions,
  type SectionItemsQuery,
} from '../../../../apps/api/src/modules/catalog/section-items.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { Platform } from '../../../../apps/api/src/modules/union/index.ts';
import { blocklist } from '../category-blocklist-search/kit.ts';
import { NOW, candidate, fixture, memoryRedis } from '../hot-rank/kit.ts';
import { PAGE_KEY, SECTION_ID, sectionFixture, type SectionSetup } from '../section-items/kit.ts';

export { APP, DEFAULT_TTL_SECONDS, PAGE_SIZE, TB_CHANNEL, channel } from '../hot-rank/kit.ts';
export {
  BLOCKED_EVENT,
  MISSING_EVENT,
  alerts,
  isBlocked,
  total,
  type BlockRow,
} from '../category-blocklist-search/kit.ts';
export { JD, PDD, TB, anomalous, expectPages, refsOf } from '../section-items/kit.ts';

export const OTHER_APP = 'synthetic-other-app';
export const JD_CHANNEL = 'synthetic_jd_sales';

export interface GoodsOptions {
  readonly title?: string;
  readonly platform?: Platform;
}

/**
 * One channel position named `name`: item and product_refs title are both `title` (default
 * `synthetic-<name>`), product key `<prefix>:synthetic-<name>`. `category` undefined leaves
 * category_l1_id absent; '' sets an empty string.
 */
export function ranked(
  name: string,
  category: string | undefined,
  options: GoodsOptions = {},
): HotRankCandidate {
  const base = candidate(name, { platform: options.platform ?? 'taobao' });
  const title = options.title ?? base.item.title;
  return {
    ...base,
    item: {
      ...base.item,
      title,
      ...(category === undefined ? {} : { category_l1_id: category }),
    },
    ref: { ...base.ref, title },
  };
}

/** `count` positions `<prefix>-<n>` for n = start .. start + count − 1, category by n. */
export function rankedSeries(
  prefix: string,
  count: number,
  start: number,
  categoryOf: (n: number) => string | undefined,
  platform: Platform = 'taobao',
): HotRankCandidate[] {
  return Array.from({ length: count }, (_unused, index) =>
    ranked(`${prefix}-${start + index}`, categoryOf(start + index), { platform }),
  );
}

/** The card title of `ranked(name, …)` without a title option. */
export function titleOf(name: string): string {
  return `synthetic-${name}`;
}

/** The hot list cursor's claims. */
export function rankCursor(cursor: string | null): unknown {
  if (cursor === null) return null;
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

/** [rank, title] of every hot list item, in order. */
export function rankTitles(data: HotRankData): [number, string | null][] {
  return data.items.map((entry) => [entry.rank, entry.product_card.title ?? null]);
}

export function feedTitles(data: PageSectionItemsData): (string | null)[] {
  return data.items.map((card) => card.title ?? null);
}

/** The warnings carrying `event` among already flattened warn fields. */
export function eventsOf(
  list: readonly Record<string, unknown>[],
  event: string,
): Record<string, unknown>[] {
  return list.filter((fields) => fields['event'] === event);
}

/** First arguments of the warn calls, as records (non-objects are dropped). */
export function warnFields(calls: readonly (readonly unknown[])[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of calls) {
    const fields = call[0];
    if (typeof fields === 'object' && fields !== null) out.push(fields as Record<string, unknown>);
  }
  return out;
}

/** The hot list fixture (optionally behind the memory Redis cache) with the blocklist port. */
export function hotFixture(setup: { readonly cached?: boolean } = {}) {
  const f = fixture(setup);
  const list = blocklist();
  const options: HotRankOptions = { ...f.options, categoryFilter: list.port };
  return {
    ...f,
    options,
    rows: list.rows,
    filterCalls: list.calls,
    block: list.block,
    /** Titles handed to the single card entry, in order. */
    assembled(): string[] {
      return f.assemble.mock.calls.map(([input]) => input.item.title);
    },
    /** Titles whose link was registered, in order. */
    registered(): string[] {
      return f.register.mock.calls.map(([input]) => input.item.title);
    },
    /** Titles the quoter was asked about. */
    quoted(): string[] {
      return f.quote.mock.calls.map(([item]) => item.title);
    },
    warnings(): Record<string, unknown>[] {
      return warnFields(f.warn.mock.calls);
    },
    /** product_key of every PRICE_ANOMALY line of the card entry, in order. */
    anomalies(): unknown[] {
      return warnFields(f.warn.mock.calls)
        .filter((fields) => fields['code'] === 'PRICE_ANOMALY')
        .map((fields) => fields['product_key']);
    },
    run(query: Partial<HotRankQuery> = {}): Promise<HotRankData> {
      return getHotRank({ platform: 'taobao', ...query }, options);
    },
  };
}

export const POOL_ID = 'synthetic-home-pool';
export const FALLBACK_POOL_ID = 'synthetic-home-fallback-pool';

/** A pool reader double: the same rows for any pool id; every call recorded. */
export function poolSide(candidates: readonly PoolCandidate[]) {
  const pageCalls: PoolPageRequest[] = [];
  const fallbackCalls: string[] = [];
  const reader: PoolReader = {
    async page(request) {
      pageCalls.push(request);
      return {
        candidates: candidates.slice(request.offset, request.offset + request.limit),
        nextOffset: null,
      };
    },
    async fallbackPoolId(appId) {
      fallbackCalls.push(appId);
      return FALLBACK_POOL_ID;
    },
    async detail() {
      return null;
    },
  };
  return { reader, pageCalls, fallbackCalls };
}

export interface HomeSectionSetup extends SectionSetup {
  /** Wrap the section's union side in cacheHotRankUpstream over a memory Redis. */
  readonly cached?: boolean;
  readonly poolReader?: PoolReader;
}

/** The section fixture with the blocklist port (and optionally the cache and a pool reader). */
export function sectionHome(setup: HomeSectionSetup = {}) {
  const s = sectionFixture(setup);
  const list = blocklist();
  const clock = new FixedClock(NOW);
  const memory = memoryRedis();
  const config: CatalogConfigReader = { configValue: async () => null };
  const upstream =
    setup.cached === true
      ? cacheHotRankUpstream(s.options.upstream, { redis: memory.redis, clock, config })
      : s.options.upstream;
  const options: SectionItemsOptions = {
    ...s.options,
    upstream,
    categoryFilter: list.port,
    ...(setup.poolReader === undefined ? {} : { poolReader: setup.poolReader }),
  };
  return {
    ...s,
    options,
    clock,
    memory,
    rows: list.rows,
    filterCalls: list.calls,
    block: list.block,
    /** Titles handed to filterCategories over all calls. */
    judgedTitles(): string[] {
      return list.calls.flatMap((call) => call.items.map((item) => item.title));
    },
    run(query: Partial<SectionItemsQuery> = {}): Promise<PageSectionItemsData> {
      return getSectionItems({ pageKey: PAGE_KEY, sectionId: SECTION_ID, ...query }, options);
    },
  };
}

/** The pool candidate of a synthetic position (same item and ref). */
export function poolCandidate(entry: HotRankCandidate): PoolCandidate {
  return { item: entry.item, ref: entry.ref };
}
