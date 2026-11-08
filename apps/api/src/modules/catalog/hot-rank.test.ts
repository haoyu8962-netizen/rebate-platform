import { expect, it, vi } from 'vitest';
import { FixedClock } from '../platform/index.ts';
import type { Platform, UnionItem } from '../union/index.ts';
import type { CatalogCardEntry, CatalogCardInput } from './application/card-entry.ts';
import type { Catalog, CategoryCandidate, ProductRef } from './domain/types.ts';
import {
  getHotRank,
  type HotRankOptions,
  type HotRankUpstream,
  type HotRankUpstreamPage,
} from './hot-rank.ts';
import { createGuestViewerContext } from './ports.ts';

const CHANNEL = 'synthetic_tb_sales';

function cards(): CatalogCardEntry & { assemble: ReturnType<typeof vi.fn> } {
  return {
    assemble: vi.fn(async (input: CatalogCardInput) => ({
      kind: 'card',
      card: { rebate_basis: 'estimated', title: input.item.title },
    })),
  } as unknown as CatalogCardEntry & { assemble: ReturnType<typeof vi.fn> };
}

function candidate(name: string, category: string) {
  return {
    item: {
      platform: 'taobao' as Platform,
      title: `synthetic-${name}`,
      category_l1_id: category,
      price_fen: 1000n,
      coupon_fen: 0n,
      final_price_fen: 1000n,
    } as unknown as UnionItem,
    ref: { productKey: `tb:${name}` } as unknown as ProductRef,
    salesText: null,
  };
}

/** Blocks every item of category '50'. */
const filter: Pick<Catalog, 'filterCategories'> = {
  filterCategories: async <T extends CategoryCandidate>(_appId: string, items: readonly T[]) =>
    items.filter((item) => item.categoryId !== '50'),
};

function optionsOf(
  entry: CatalogCardEntry,
  pages: Readonly<Record<number, HotRankUpstreamPage>>,
): HotRankOptions & { warn: ReturnType<typeof vi.fn> } {
  const upstream: HotRankUpstream = {
    categories: async () => [],
    page: async ({ pageNo }) => pages[pageNo] ?? { items: [], hasMore: false },
  };
  const warn = vi.fn();
  return {
    clock: new FixedClock('2031-05-06T15:08:09+08:00'),
    viewerContext: createGuestViewerContext({ appId: 'synthetic', deviceId: null }),
    cards: entry,
    channels: () => ({
      version: 'synthetic',
      channels: [
        {
          platform: 'taobao',
          channel_id: CHANNEL,
          name: '合成',
          sort_basis: 'sales',
          selectable: true,
          source: 'synthetic',
        },
      ],
    }),
    upstream,
    logger: { warn },
    categoryFilter: filter,
    warn,
  };
}

it('[AC-B1-04zzzz] 上游丢位（positions 不连续）且有一项被滤：名次照上游 positions，不按过滤前或过滤后的数组下标', async () => {
  const entry = cards();
  const options = optionsOf(entry, {
    1: {
      items: [
        candidate('a', '60'),
        candidate('b', '50'),
        candidate('c', '60'),
        candidate('d', '60'),
      ],
      positions: [0, 2, 5, 9],
      hasMore: false,
    },
  });

  const data = await getHotRank({ platform: 'taobao' }, options);

  expect(data.items.map((item) => [item.rank, item.product_card.title])).toEqual([
    [1, 'synthetic-a'],
    [6, 'synthetic-c'],
    [10, 'synthetic-d'],
  ]);
  expect(entry.assemble.mock.calls.map(([input]) => input.item.title)).not.toContain('synthetic-b');
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-04zzzz] 补拉页带 positions 且有一项被滤：补拉页名次照自身 positions 跨页计', async () => {
  const entry = cards();
  const first = Array.from({ length: 20 }, (_unused, index) =>
    candidate(`p${index + 1}`, index === 0 ? '50' : '60'),
  );
  const options = optionsOf(entry, {
    1: { items: first, hasMore: true },
    2: {
      items: [candidate('q1', '50'), candidate('q2', '60'), candidate('q3', '60')],
      positions: [1, 4, 7],
      hasMore: true,
    },
  });

  const data = await getHotRank({ platform: 'taobao' }, options);

  const ranks = data.items.map((item) => item.rank);
  expect(ranks.slice(0, 19)).toEqual(Array.from({ length: 19 }, (_unused, index) => index + 2));
  expect(ranks.slice(19)).toEqual([25]);
  expect(data.items).toHaveLength(20);
  const blocked = options.warn.mock.calls
    .map(([fields]) => fields as Record<string, unknown>)
    .filter((fields) => fields['event'] === 'catalog_category_blocked');
  expect(blocked.map((fields) => fields['count'])).toEqual([1, 1]);
});

it('[AC-B1-04zzzz] 不接名单端口时不调过滤、不出类目告警，名次照旧', async () => {
  const entry = cards();
  const warn = vi.fn();
  const wired = optionsOf(entry, {
    1: { items: [candidate('a', '50'), candidate('b', '60')], positions: [1, 3], hasMore: false },
  });
  const plain: HotRankOptions = {
    clock: wired.clock,
    viewerContext: wired.viewerContext,
    cards: wired.cards,
    channels: wired.channels,
    upstream: wired.upstream,
    logger: { warn },
  };

  const data = await getHotRank({ platform: 'taobao' }, plain);

  expect(data.items.map((item) => item.rank)).toEqual([2, 4]);
  expect(warn).not.toHaveBeenCalled();
});
