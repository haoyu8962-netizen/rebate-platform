// B1-04zzx (D10-860 ④): alerts of the search tab's category blocklist. Items without a category are
// counted per platform under catalog_category_missing; filtered items per platform under
// catalog_category_blocked, only when something was filtered. An alert carries the event code, the
// platform and the count, nothing else (no product key, no title). Counts are summed over the
// request's warn calls, so one alert per page or one per request are both accepted.
import { afterEach, expect, it, vi } from 'vitest';
import {
  APP,
  BLOCKED_EVENT,
  MISSING_EVENT,
  alerts,
  feedChannels,
  goods,
  setup,
  total,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

function expectShape(list: readonly Record<string, unknown>[], platform: string): void {
  for (const fields of list) {
    expect(Object.keys(fields).sort()).toEqual(['count', 'event', 'platform']);
    expect(fields['platform']).toBe(platform);
  }
  const text = JSON.stringify(list, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  expect(text).not.toContain('synthetic');
}

it('[AC-B1-04zzx#8] 无类目商品计 catalog_category_missing、被滤商品计 catalog_category_blocked，按平台计数，只带事件码、平台与计数', async () => {
  const f = setup();
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
  ]);
  f.pages.set(1, {
    items: [
      goods('a', '50'),
      goods('b', undefined, { title: 'synthetic-b-禁售词' }),
      goods('c', ''),
      goods('d', undefined),
      goods('e', '60'),
    ],
    hasMore: false,
  });
  const result = await f.run({ limit: 10 });
  expect(result.items.map((card) => card.title)).toEqual([
    'synthetic-c',
    'synthetic-d',
    'synthetic-e',
  ]);
  const missing = alerts(f.warn, MISSING_EVENT);
  const blocked = alerts(f.warn, BLOCKED_EVENT);
  expect(total(missing)).toBe(3);
  expect(total(blocked)).toBe(2);
  expectShape(missing, 'taobao');
  expectShape(blocked, 'taobao');
});

it('[AC-B1-04zzx#9] 没有被滤商品时不记 catalog_category_blocked；类目齐全时无类目计数为 0；名单一生效即记', async () => {
  const f = setup();
  f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
  f.pages.set(1, { items: [goods('a', '60'), goods('b', '61')], hasMore: false });
  await f.run({ limit: 10 });
  expect(alerts(f.warn, BLOCKED_EVENT)).toEqual([]);
  expect(total(alerts(f.warn, MISSING_EVENT))).toBe(0);
  f.block(APP, [{ platform: 'taobao', categoryId: '61', keyword: null }]);
  const result = await f.run({ limit: 10 });
  expect(result.items.map((card) => card.title)).toEqual(['synthetic-a']);
  const blocked = alerts(f.warn, BLOCKED_EVENT);
  expect(total(blocked)).toBe(1);
  expectShape(blocked, 'taobao');
});

it('[AC-B1-04zzx#10] 兜底物料的无类目与被滤商品同样按平台计数（平台取搜索平台）', async () => {
  feedChannels();
  const f = setup();
  f.block(APP, [
    { platform: 'jd', categoryId: '50', keyword: null },
    { platform: 'jd', categoryId: '70', keyword: '禁售词' },
  ]);
  f.materialFeed.mockResolvedValue({
    items: [
      goods('jd-feed-a', undefined, { platform: 'jd' }),
      goods('jd-feed-b', '50', { platform: 'jd' }),
      goods('jd-feed-c', '', { platform: 'jd', title: 'synthetic-jd-feed-c-禁售词' }),
      goods('jd-feed-d', '60', { platform: 'jd' }),
    ],
    hasMore: false,
  });
  const result = await f.run({ platform: 'jd' });
  expect(result.items).toEqual([]);
  expect(result.fallback_items.map((card) => card.title)).toEqual([
    'synthetic-jd-feed-a',
    'synthetic-jd-feed-d',
  ]);
  const missing = alerts(f.warn, MISSING_EVENT);
  const blocked = alerts(f.warn, BLOCKED_EVENT);
  expect(total(missing)).toBe(2);
  expect(total(blocked)).toBe(2);
  expectShape(missing, 'jd');
  expectShape(blocked, 'jd');
});
