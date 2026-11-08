// B1-04zzzz (D10-860 ⑦ / D10-1045 Q1): the hot-sales list (getHotRank) passes every channel page
// through the category blocklist, with the search tab's rules (B1-04zzx): an item with a category is
// dropped by a row of its app and platform with the same category id whose keyword is empty or
// occurs in the title; an item without one (absent or '') only by its platform's keyword rows. A
// dropped position gets no card, no link and no quote, and leaves its rank unused (ranks are the
// channel's own positions, never renumbered). The use case, the card entry and the cursor are the
// real ones (frozen hot list kit); the blocklist is the in-memory port. All values are synthetic.
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  OTHER_APP,
  PAGE_SIZE,
  TB_CHANNEL,
  anomalous,
  hotFixture,
  rankCursor,
  rankTitles,
  ranked,
  rankedSeries,
  titleOf,
} from './home-kit.ts';

it('[AC-B1-04zzzz#1] 热销榜有类目商品：同应用同平台类目全等且关键词空或标题字面包含即滤——不出卡、不组卡、不报价、不登记链接，其余名次照频道原位次（被滤名次空缺不重编号）', async () => {
  const f = hotFixture();
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁A+B' },
    { platform: 'jd', categoryId: '60', keyword: null },
  ]);
  f.block(OTHER_APP, [{ platform: 'taobao', categoryId: '80', keyword: null }]);
  f.setPage('taobao', TB_CHANNEL, null, 1, [
    ranked('a', '50'),
    ranked('b', '500'),
    ranked('c', '050'),
    ranked('d', '70', { title: 'synthetic-d-禁A+B' }),
    ranked('e', '70', { title: 'synthetic-e-禁AAB' }),
    ranked('f', '60'),
    ranked('g', '80'),
  ]);

  const result = await f.run();

  const blocked = [titleOf('a'), 'synthetic-d-禁A+B'];
  expect(rankTitles(result)).toEqual([
    [2, titleOf('b')],
    [3, titleOf('c')],
    [5, 'synthetic-e-禁AAB'],
    [6, titleOf('f')],
    [7, titleOf('g')],
  ]);
  expect(f.registered()).toEqual([
    titleOf('b'),
    titleOf('c'),
    'synthetic-e-禁AAB',
    titleOf('f'),
    titleOf('g'),
  ]);
  for (const title of blocked) {
    expect(f.assembled()).not.toContain(title);
    expect(f.quoted()).not.toContain(title);
  }
  expect(f.filterCalls.length).toBeGreaterThan(0);
  expect(f.filterCalls.every((call) => call.appId === APP)).toBe(true);
  expect(result.next_cursor).toBeNull();
});

it('[AC-B1-04zzzz#2] 热销榜无类目商品（category_l1_id 缺失或空串）：只按同平台带关键词的行字面匹配；纯类目行、他平台行、他应用行都不适用，放行', async () => {
  const f = hotFixture();
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
    { platform: 'jd', categoryId: '80', keyword: '跨平台词' },
  ]);
  f.block(OTHER_APP, [{ platform: 'taobao', categoryId: '90', keyword: '他应用词' }]);
  f.setPage('taobao', TB_CHANNEL, null, 1, [
    ranked('g', undefined, { title: 'synthetic-g-禁售词' }),
    ranked('h', '', { title: 'synthetic-h-禁售词' }),
    ranked('i', undefined),
    ranked('j', '', { title: 'synthetic-j-跨平台词' }),
    ranked('k', undefined, { title: 'synthetic-k-禁售' }),
    ranked('m', undefined, { title: 'synthetic-m-他应用词' }),
  ]);

  const result = await f.run();

  expect(rankTitles(result)).toEqual([
    [3, titleOf('i')],
    [4, 'synthetic-j-跨平台词'],
    [5, 'synthetic-k-禁售'],
    [6, 'synthetic-m-他应用词'],
  ]);
  expect(f.registered()).not.toContain('synthetic-g-禁售词');
  expect(f.registered()).not.toContain('synthetic-h-禁售词');
});

it('[AC-B1-04zzzz#3] 热销榜过滤在缓存之后：缓存命中的同参请求不再取联盟，名单改动即生效；联盟故障答的 stale 旧页同样过滤，名单清空后旧页原样恢复', async () => {
  const f = hotFixture({ cached: true });
  f.setPage('taobao', TB_CHANNEL, null, 1, [
    ranked('a', '50'),
    ranked('b', undefined, { title: 'synthetic-b-禁售词' }),
    ranked('c', '60'),
  ]);
  const all: [number, string][] = [
    [1, titleOf('a')],
    [2, 'synthetic-b-禁售词'],
    [3, titleOf('c')],
  ];

  expect(rankTitles(await f.run())).toEqual(all);
  const fetched = f.page.mock.calls.length;

  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
  ]);
  f.clock.advanceMs(60_000);
  const hit = await f.run();
  expect(f.page.mock.calls.length).toBe(fetched);
  expect(rankTitles(hit)).toEqual([[3, titleOf('c')]]);

  f.clock.advanceMs(700_000);
  f.fail(new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));
  const stale = await f.run();
  expect(rankTitles(stale)).toEqual([[3, titleOf('c')]]);
  expect(stale.items.map((entry) => entry.product_card.stale)).toEqual([true]);

  f.block(APP, []);
  expect(rankTitles(await f.run())).toEqual(all);
});

it('[AC-B1-04zzzz#4] 热销榜补拉（D10-1045 Q3）：第 1 页被滤 ≥1 且上游有更多 → 只补拉第 2 页一次，补拉页同样过滤、按自身位次排名，游标 page_no=3；没被滤或上游没有更多 → 不补拉', async () => {
  const f = hotFixture();
  f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
  f.setPage(
    'taobao',
    TB_CHANNEL,
    null,
    1,
    rankedSeries('p', PAGE_SIZE, 1, (n) => (n === 3 || n === 7 ? '50' : '60')),
    true,
  );
  f.setPage(
    'taobao',
    TB_CHANNEL,
    null,
    2,
    rankedSeries('p', PAGE_SIZE, 21, (n) => (n === 21 ? '50' : '60')),
    true,
  );
  f.setPage('taobao', TB_CHANNEL, null, 3, [ranked('must-not-fetch', '60')]);

  const result = await f.run();

  const firstPage = Array.from({ length: PAGE_SIZE }, (_unused, index) => index + 1)
    .filter((n) => n !== 3 && n !== 7)
    .map((n): [number, string] => [n, titleOf(`p-${n}`)]);
  expect(rankTitles(result)).toEqual([...firstPage, [22, titleOf('p-22')], [23, titleOf('p-23')]]);
  expect(f.page.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
  expect(rankCursor(result.next_cursor)).toEqual({
    platform: 'taobao',
    channel_id: TB_CHANNEL,
    category_id: null,
    page_no: 3,
  });

  // Nothing blocked on a full page with more: no refill, the cursor points at page 2.
  const clean = hotFixture();
  clean.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
  clean.setPage(
    'taobao',
    TB_CHANNEL,
    null,
    1,
    rankedSeries('q', PAGE_SIZE, 1, (n) => (n % 2 === 0 ? undefined : '60')),
    true,
  );
  clean.setPage('taobao', TB_CHANNEL, null, 2, [ranked('must-not-fetch', '60')]);
  const kept = await clean.run();
  expect(kept.items).toHaveLength(PAGE_SIZE);
  expect(clean.page.mock.calls.map(([input]) => input.pageNo)).toEqual([1]);
  expect(rankCursor(kept.next_cursor)).toMatchObject({ page_no: 2 });

  // Blocked but the upstream has no more: nothing to refill from, no cursor.
  const last = hotFixture();
  last.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
  last.setPage('taobao', TB_CHANNEL, null, 1, [ranked('x', '50'), ranked('y', '60')], false);
  const short = await last.run();
  expect(rankTitles(short)).toEqual([[2, titleOf('y')]]);
  expect(last.page.mock.calls.map(([input]) => input.pageNo)).toEqual([1]);
  expect(short.next_cursor).toBeNull();
});

it.each([true, false])(
  '[AC-B1-04zzzz#5] 热销榜全被滤：items 为空，频道与类目照常；补拉页也全被滤时 next_cursor 照末次上游页（第 2 页 hasMore=%s）',
  async (hasMore) => {
    const f = hotFixture();
    f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
    f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);
    f.setPage(
      'taobao',
      TB_CHANNEL,
      null,
      1,
      rankedSeries('p', PAGE_SIZE, 1, () => '50'),
      true,
    );
    f.setPage(
      'taobao',
      TB_CHANNEL,
      null,
      2,
      rankedSeries('p', PAGE_SIZE, 21, () => '50'),
      hasMore,
    );
    f.setPage('taobao', TB_CHANNEL, null, 3, [ranked('must-not-fetch', '60')]);

    const result = await f.run();

    expect(result.items).toEqual([]);
    expect(result.channel).toBe(TB_CHANNEL);
    expect(result.categories).toEqual([{ category_id: 'synthetic-digital', name: '合成数码' }]);
    expect(f.page.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
    if (hasMore) expect(rankCursor(result.next_cursor)).toMatchObject({ page_no: 3 });
    else expect(result.next_cursor).toBeNull();
    expect(f.register).not.toHaveBeenCalled();

    // A single page, all blocked, nothing more upstream: empty and no cursor.
    const one = hotFixture();
    one.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
    one.setPage('taobao', TB_CHANNEL, null, 1, [ranked('z', '50')], false);
    const empty = await one.run();
    expect(empty.items).toEqual([]);
    expect(empty.next_cursor).toBeNull();
  },
);

it('[AC-B1-04zzzz#8] 价格异常项仍由卡片入口记 PRICE_ANOMALY（先于名单判定），记录与不接名单时一致；被滤的正常项不出卡、不报价', async () => {
  const page = [
    anomalous(ranked('x', '50')),
    anomalous(ranked('y', undefined)),
    ranked('z', '50'),
    ranked('w', '60'),
  ];
  const plain = hotFixture();
  plain.setPage('taobao', TB_CHANNEL, null, 1, page);
  await plain.run();
  const expected = plain.anomalies();
  expect(expected).toHaveLength(2);

  const f = hotFixture();
  f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
  f.setPage('taobao', TB_CHANNEL, null, 1, page);

  const result = await f.run();

  expect(f.anomalies()).toEqual(expected);
  expect(rankTitles(result)).toEqual([[4, titleOf('w')]]);
  expect(f.registered()).toEqual([titleOf('w')]);
  for (const name of ['x', 'y', 'z']) expect(f.quoted()).not.toContain(titleOf(name));
});
