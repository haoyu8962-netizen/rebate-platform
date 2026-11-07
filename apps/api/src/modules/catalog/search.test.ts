// B1-04zzx: unit tests of the search tab's category blocklist hook (no database, fake ports).
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../platform/index.ts';
import type { Platform, UnionItem } from '../union/index.ts';
import { createCatalogCardEntry } from './application/card-entry.ts';
import { filterByRules } from './domain/rules.ts';
import type { Catalog, CategoryCandidate, CategoryRule } from './domain/types.ts';
import {
  searchProducts,
  type SearchCandidate,
  type SearchProductsOptions,
  type SearchSession,
  type SearchUpstreamPage,
} from './search.ts';

const AT = '2026-10-06T10:00:00+08:00';
const APP = 'unit-app';

function goods(
  name: string,
  category: string | undefined,
  title = `unit-${name}`,
): SearchCandidate {
  const item: UnionItem = {
    platform: 'taobao',
    item_id: `unit-${name}`,
    title,
    price_fen: 1000n,
    coupon_fen: 0n,
    final_price_fen: 1000n,
    commission_rate_bp: 1000n,
    quoted_at: AT,
    ...(category === undefined ? {} : { category_l1_id: category }),
  };
  return {
    item,
    ref: {
      appId: APP,
      platform: 'taobao',
      productKey: `tb:unit-${name}`,
      rawItemId: `unit-${name}`,
      rawFetchedAt: AT,
      receivedAt: AT,
      canonicalUrl: null,
      title,
      shopId: null,
      shopType: null,
      source: 'search',
    },
  };
}

function setup(page: SearchUpstreamPage, rules: readonly CategoryRule[] | null) {
  const clock = new FixedClock(AT);
  const current = vi.fn(async () => ({ appId: APP, userId: 'unit-user', deviceId: null }));
  const warn = vi.fn();
  const filterCalls: string[] = [];
  const port: Pick<Catalog, 'filterCategories'> = {
    async filterCategories<T extends CategoryCandidate>(
      appId: string,
      items: readonly T[],
    ): Promise<T[]> {
      filterCalls.push(appId);
      return filterByRules(items, rules ?? []);
    },
  };
  const sessions = new Map<string, SearchSession>();
  const options: SearchProductsOptions = {
    clock,
    viewerContext: { current },
    config: { configValue: vi.fn(async () => ({ value: true, version: 1 })) },
    pids: {
      getActivePid: vi.fn(async (input) => ({
        id: 'unit-pid-row',
        app_id: input.appId,
        platform: input.platform,
        union_account_id: 'unit-account',
        site_id: null,
        pid: 'unit-pid',
        pid_scene: 'query' as const,
        status: 'active' as const,
        created_at: clock.now(),
        updated_at: clock.now(),
        row_version: 0,
        hjy_ignore_confirmed_at: clock.now(),
        hjy_ignore_evidence_path: 'unit-evidence',
      })),
    },
    catalog: {
      requirePlatform: vi.fn(async (code: string) => ({
        code,
        key_prefix: 'tb',
        key_stability: 'stable_7d' as const,
        search_support: 'supported',
        convert_support: 'supported',
        order_sync_support: 'supported',
        stage: 'launched',
      })),
      resolveProductKey: vi.fn(async (key: string) => key),
    },
    cards: createCatalogCardEntry({
      clock,
      viewerContext: { current },
      quoter: {
        quote: vi.fn(async () => ({
          rebateMinFen: 20n,
          rebateMaxFen: 20n,
          estNetPriceFen: null,
          rebateBasis: 'normal' as const,
        })),
      },
      registrar: { register: vi.fn(async () => ({ linkId: 'unit-link' })) },
      sourceLinks: { entrySource: vi.fn(async () => null) },
      itemRefs: { issue: vi.fn(() => 'unit-item-ref') },
      logger: { warn },
    }),
    upstream: {
      search: vi.fn(async () => page),
      materialFeed: vi.fn(async () => ({ items: [], hasMore: false })),
    },
    sessions: {
      read: vi.fn(async (_app: string, id: string) => sessions.get(id) ?? null),
      write: vi.fn(async (_app: string, id: string, value: SearchSession) => {
        sessions.set(id, value);
      }),
    },
    cursors: { encode: vi.fn(() => 'unit-cursor'), decode: vi.fn(() => null) },
    newSessionId: () => 'unit-session',
    logger: { warn },
    ...(rules === null ? {} : { categoryFilter: port }),
  };
  return {
    warn,
    filterCalls,
    run: () => searchProducts({ platform: 'taobao' as Platform, q: 'unit', limit: 10 }, options),
  };
}

function alertsOf(warn: ReturnType<typeof vi.fn>, event: string): unknown[] {
  return warn.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((fields) => fields['event'] === event);
}

const PAGE: SearchUpstreamPage = {
  items: [
    goods('a', '50'),
    goods('b', undefined, 'unit-b-banned'),
    goods('c', ''),
    goods('d', undefined),
    goods('e', '60'),
  ],
  hasMore: false,
};
const RULES: CategoryRule[] = [
  { platform: 'taobao', categoryId: '50', keyword: null },
  { platform: 'taobao', categoryId: '70', keyword: 'banned' },
];

describe('[AC-B1-04zzx] search tab category blocklist', () => {
  it('drops blocked items with one call per page and counts both alerts per platform', async () => {
    const f = setup(PAGE, RULES);
    const result = await f.run();
    expect(result.items.map((card) => card.title)).toEqual(['unit-c', 'unit-d', 'unit-e']);
    expect(f.filterCalls).toEqual([APP]);
    expect(alertsOf(f.warn, 'catalog_category_missing')).toEqual([
      { event: 'catalog_category_missing', platform: 'taobao', count: 3 },
    ]);
    expect(alertsOf(f.warn, 'catalog_category_blocked')).toEqual([
      { event: 'catalog_category_blocked', platform: 'taobao', count: 2 },
    ]);
  });

  it('logs no blocked alert when nothing is dropped', async () => {
    const f = setup(PAGE, []);
    const result = await f.run();
    expect(result.items).toHaveLength(5);
    expect(alertsOf(f.warn, 'catalog_category_blocked')).toEqual([]);
    expect(alertsOf(f.warn, 'catalog_category_missing')).toEqual([
      { event: 'catalog_category_missing', platform: 'taobao', count: 3 },
    ]);
  });

  it('does not filter or alert when no categoryFilter port is wired', async () => {
    const f = setup(PAGE, null);
    const result = await f.run();
    expect(result.items.map((card) => card.title)).toEqual([
      'unit-a',
      'unit-b-banned',
      'unit-c',
      'unit-d',
      'unit-e',
    ]);
    expect(f.filterCalls).toEqual([]);
    expect(alertsOf(f.warn, 'catalog_category_missing')).toEqual([]);
    expect(alertsOf(f.warn, 'catalog_category_blocked')).toEqual([]);
  });
});
