// B1-04zzx (D10-860 ①②③⑤): the search tab's main results pass through the category blocklist.
// The blocklist port is the in-memory model of kit.ts; the use case, the card entry and the session
// rules are the real ones (frozen search kit). All values are synthetic.
import { expect, it } from 'vitest';
import { claims } from '../search/kit.ts';
import { APP, goods, setup, titles } from './kit.ts';

it('[AC-B1-04zzx#1] 有类目商品：同平台且类目 ID 字符串全等，规则无关键词或标题字面包含关键词即滤掉，顺序不变，被滤商品不登记链接', async () => {
  const f = setup();
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁A+B' },
    { platform: 'jd', categoryId: '60', keyword: null },
  ]);
  f.pages.set(1, {
    items: [
      goods('a', '50'),
      goods('b', '500'),
      goods('c', '050'),
      goods('d', '70', { title: 'synthetic-d-禁A+B' }),
      goods('e', '70', { title: 'synthetic-e-禁AAB' }),
      goods('f', '60'),
    ],
    hasMore: false,
  });
  const result = await f.run({ limit: 10 });
  const kept = ['synthetic-b', 'synthetic-c', 'synthetic-e-禁AAB', 'synthetic-f'];
  expect(titles(result.items)).toEqual(kept);
  expect(f.register.mock.calls.map(([input]) => input.item.title)).toEqual(kept);
  expect(result.fallback_items).toEqual([]);
});

it('[AC-B1-04zzx#2] 无类目商品（category_l1_id 缺失或空串）：不按类目判，同平台带关键词的行按标题字面包含命中即滤；纯类目行与他平台的行不适用，放行', async () => {
  const f = setup();
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
    { platform: 'jd', categoryId: '80', keyword: '跨平台词' },
  ]);
  f.pages.set(1, {
    items: [
      goods('g', undefined, { title: 'synthetic-g-禁售词' }),
      goods('h', '', { title: 'synthetic-h-禁售词' }),
      goods('i', undefined),
      goods('j', '', { title: 'synthetic-j-跨平台词' }),
      goods('k', undefined, { title: 'synthetic-k-禁售' }),
    ],
    hasMore: false,
  });
  const result = await f.run({ limit: 10 });
  expect(titles(result.items)).toEqual(['synthetic-i', 'synthetic-j-跨平台词', 'synthetic-k-禁售']);
});

it('[AC-B1-04zzx#3] 名单按请求的应用与搜索平台取：他应用的行、他平台的行都不生效', async () => {
  const f = setup();
  f.block('synthetic-other-app', [{ platform: 'jd', categoryId: '50', keyword: null }]);
  f.block(APP, [
    { platform: 'taobao', categoryId: '60', keyword: null },
    { platform: 'jd', categoryId: '61', keyword: null },
  ]);
  f.pages.set(1, {
    items: [
      goods('jd-a', '50', { platform: 'jd' }),
      goods('jd-b', '60', { platform: 'jd' }),
      goods('jd-c', '61', { platform: 'jd' }),
    ],
    hasMore: false,
  });
  const result = await f.run({ platform: 'jd', limit: 10 });
  expect(titles(result.items)).toEqual(['synthetic-jd-a', 'synthetic-jd-b']);
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every((call) => call.appId === APP)).toBe(true);
  expect(f.calls.flatMap((call) => call.items).every((item) => item.platform === 'jd')).toBe(true);
});

it.each([true, false])(
  '[AC-B1-04zzx#4] 被滤后不足 limit 由现有补页兜底（至多一页），has_more=%s 与游标照末次上游页',
  async (hasMore) => {
    const f = setup();
    f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
    f.pages.set(1, {
      items: [goods('a', '50'), goods('b', '50'), goods('c', '60')],
      hasMore: true,
    });
    f.pages.set(2, { items: [goods('d', '60'), goods('e', undefined)], hasMore });
    f.pages.set(3, { items: [goods('must-not-fetch', '60')], hasMore: false });
    const result = await f.run();
    expect(titles(result.items)).toEqual(['synthetic-c', 'synthetic-d', 'synthetic-e']);
    expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
    expect(result.has_more).toBe(hasMore);
    if (hasMore)
      expect(claims(f, result.next_cursor)).toEqual({
        search_session_id: expect.any(String),
        page_no: 3,
      });
    else expect(result.next_cursor).toBeNull();
  },
);

it('[AC-B1-04zzx#5] 过滤在缓存之后：缓存页（stale）同样过滤，名单改动在下一次同参请求即生效', async () => {
  const f = setup();
  f.pages.set(1, {
    items: [
      goods('a', '50'),
      goods('b', undefined, { title: 'synthetic-b-禁售词' }),
      goods('c', '60'),
    ],
    hasMore: false,
    stale: true,
  });
  const all = ['synthetic-a', 'synthetic-b-禁售词', 'synthetic-c'];
  const before = await f.run({ limit: 10 });
  expect(titles(before.items)).toEqual(all);
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
  ]);
  const blocked = await f.run({ limit: 10 });
  expect(titles(blocked.items)).toEqual(['synthetic-c']);
  f.block(APP, []);
  const after = await f.run({ limit: 10 });
  expect(titles(after.items)).toEqual(all);
});
