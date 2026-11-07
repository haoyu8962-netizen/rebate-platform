// B1-04zzx (D10-860 ③, 04「检索与物料流过滤」): the no-result fallback feed of the search tab passes
// through the same category blocklist as the main results. All values are synthetic.
import { afterEach, expect, it, vi } from 'vitest';
import { APP, feedChannels, goods, setup, titles } from './kit.ts';

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-04zzx#6] 无结果兜底物料同样过滤：有类目按类目（含关键词），无类目只按同平台带关键词的行，顺序不变，被滤商品不登记链接', async () => {
  feedChannels();
  const f = setup();
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
  ]);
  f.materialFeed.mockResolvedValue({
    items: [
      goods('feed-a', '50'),
      goods('feed-b', '60'),
      goods('feed-c', undefined, { title: 'synthetic-feed-c-禁售词' }),
      goods('feed-d', ''),
      goods('feed-e', '70', { title: 'synthetic-feed-e-禁售词' }),
      goods('feed-f', '70'),
    ],
    hasMore: false,
  });
  const result = await f.run();
  const kept = ['synthetic-feed-b', 'synthetic-feed-d', 'synthetic-feed-f'];
  expect(result.items).toEqual([]);
  expect(titles(result.fallback_items)).toEqual(kept);
  expect(f.register.mock.calls.map(([input]) => input.item.title)).toEqual(kept);
  expect(f.calls.every((call) => call.appId === APP)).toBe(true);
});

it('[AC-B1-04zzx#7] 首页主结果全被滤掉即视为无结果：给出兜底物料（兜底同样过滤），has_more 照上游', async () => {
  feedChannels();
  const f = setup();
  f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
  f.pages.set(1, { items: [goods('main-a', '50')], hasMore: false });
  f.materialFeed.mockResolvedValue({
    items: [goods('feed-a', '50'), goods('feed-b', '60')],
    hasMore: false,
  });
  const result = await f.run();
  expect(result).toMatchObject({ items: [], has_more: false, next_cursor: null });
  expect(titles(result.fallback_items)).toEqual(['synthetic-feed-b']);
  expect(f.materialFeed).toHaveBeenCalledTimes(1);
});
