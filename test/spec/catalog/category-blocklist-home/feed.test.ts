// B1-04zzzz (D10-860 ⑦ / D10-1045 Q1 Q2): the home feed's union_material sections (getSectionItems)
// pass every channel page through the category blocklist (same rules as the search tab, B1-04zzx).
// A dropped item gets no card, no link (never committed) and takes no dedup key; the other items
// keep their relative order. A short page uses the existing single refill round; the cursor records
// upstream pages only. An all-dropped page is empty and never turns to the union fall-back pool. The
// product_pool data source and the fall-back pool are not filtered in this step (Q2). Blocked items
// are placed so that dropping them before or after the merge gives the same order. The use case,
// the card entry and the cursor are the real ones (frozen section kit); the blocklist is the
// in-memory port. All values are synthetic.
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  BLOCKED_EVENT,
  JD,
  MISSING_EVENT,
  OTHER_APP,
  POOL_ID,
  TB,
  eventsOf,
  expectPages,
  feedTitles,
  poolCandidate,
  poolSide,
  ranked,
  rankedSeries,
  refsOf,
  sectionHome,
  titleOf,
  total,
} from './home-kit.ts';

const PAGE = 20;

it('[AC-B1-04zzzz#9] 物料流多频道：被滤项不出卡、不 commit（不登记链接），交错顺序与剩余项相对顺序不变；他应用的行不生效', async () => {
  const f = sectionHome({ channels: [TB, JD] });
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
    { platform: 'jd', categoryId: '61', keyword: null },
  ]);
  f.block(OTHER_APP, [{ platform: 'jd', categoryId: '60', keyword: null }]);
  f.answer(TB, 1, [
    ranked('t1', '60'),
    ranked('t2', '50'),
    ranked('t3', '60'),
    ranked('t4', undefined, { title: 'synthetic-t4-禁售词' }),
  ]);
  f.answer(JD, 1, [
    ranked('j1', '60', { platform: 'jd' }),
    ranked('j2', '61', { platform: 'jd' }),
    ranked('j3', '60', { platform: 'jd' }),
    ranked('j4', '61', { platform: 'jd' }),
  ]);

  const result = await f.run();

  const kept = [titleOf('t1'), titleOf('j1'), titleOf('t3'), titleOf('j3')];
  expect(feedTitles(result)).toEqual(kept);
  expect(f.registered()).toEqual(kept);
  expect(result.items.every((card) => card.ad_label === null)).toBe(true);
  expect(result.has_more).toBe(false);
  expect(result.next_cursor).toBeNull();
  expect(f.filterCalls.length).toBeGreaterThan(0);
  expect(f.filterCalls.every((call) => call.appId === APP)).toBe(true);
});

it('[AC-B1-04zzzz#10] 物料流被滤项不占去重 key：同一商品在一个频道被滤（标题含禁售词）、在另一频道未被滤 → 未被滤的那张照常出卡', async () => {
  const refs = refsOf(2);
  const first = refs[0]!;
  const second = refs[1]!;
  const f = sectionHome({ channels: [first, second] });
  f.block(APP, [{ platform: 'taobao', categoryId: '70', keyword: '禁售词' }]);
  f.answer(first, 1, [ranked('a1', '60'), ranked('dup', '70', { title: 'synthetic-dup-禁售词' })]);
  f.answer(second, 1, [ranked('b1', '60'), ranked('dup', '70')]);

  const result = await f.run();

  expect(feedTitles(result)).toEqual([titleOf('a1'), titleOf('b1'), titleOf('dup')]);
  expect(f.registered()).toEqual([titleOf('a1'), titleOf('b1'), titleOf('dup')]);
});

it.each([true, false])(
  '[AC-B1-04zzzz#11] 物料流被滤后不足 20 → 走现有一轮补取（至多一次），补取页同样过滤；游标只记各频道上游页码、不记过滤偏移，has_more 照上游（第 2 页 hasMore=%s）',
  async (hasMore) => {
    const f = sectionHome({ channels: [TB] });
    f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
    const dropped = new Set([2, 5, 9]);
    f.answer(
      TB,
      1,
      rankedSeries('p', PAGE, 1, (n) => (dropped.has(n) ? '50' : '60')),
      true,
    );
    f.answer(
      TB,
      2,
      rankedSeries('p', 10, 21, (n) => (n === 21 ? '50' : '60')),
      hasMore,
    );
    f.answer(TB, 3, [ranked('must-not-fetch', '60')]);

    const result = await f.run();

    const firstPage = Array.from({ length: PAGE }, (_unused, index) => index + 1)
      .filter((n) => !dropped.has(n))
      .map((n) => titleOf(`p-${n}`));
    const expected = [...firstPage, titleOf('p-22'), titleOf('p-23'), titleOf('p-24')];
    expect(feedTitles(result)).toEqual(expected);
    expect(f.registered()).toEqual(expected);
    expect(f.pageNos(TB)).toEqual([1, 2]);
    if (hasMore) expectPages(result, [3]);
    else {
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
    }
  },
);

it.each([true, false])(
  '[AC-B1-04zzzz#12] 物料流全被滤：items 为空；上游有更多带游标、否则 next_cursor 为 null；不走联盟兜底池（第 2 页 hasMore=%s）',
  async (hasMore) => {
    const pool = poolSide([poolCandidate(ranked('pool-a', '60'))]);
    const f = sectionHome({ channels: [TB], poolReader: pool.reader });
    f.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
    f.answer(
      TB,
      1,
      rankedSeries('p', PAGE, 1, () => '50'),
      true,
    );
    f.answer(
      TB,
      2,
      rankedSeries('p', PAGE, 21, () => '50'),
      hasMore,
    );
    f.answer(TB, 3, [ranked('must-not-fetch', '60')]);

    const result = await f.run();

    expect(result.items).toEqual([]);
    expect(f.pageNos(TB)).toEqual([1, 2]);
    if (hasMore) expectPages(result, [3]);
    else expect(result).toEqual({ items: [], next_cursor: null, has_more: false });
    expect(pool.fallbackCalls).toEqual([]);
    expect(pool.pageCalls).toEqual([]);
    expect(f.registered()).toEqual([]);
  },
);

it('[AC-B1-04zzzz#13] 物料流过滤在缓存之后：缓存命中的同参请求不再取联盟，名单改动即生效；联盟故障答的 stale 旧页同样过滤，名单清空后旧页原样恢复', async () => {
  const f = sectionHome({ channels: [TB, JD], cached: true });
  f.answer(TB, 1, [
    ranked('a', '60'),
    ranked('b', '50'),
    ranked('c', undefined, { title: 'synthetic-c-禁售词' }),
  ]);
  f.answer(JD, 1, [
    ranked('d', '60', { platform: 'jd' }),
    ranked('e', '61', { platform: 'jd' }),
    ranked('f', '60', { platform: 'jd' }),
  ]);
  const all = [
    titleOf('a'),
    titleOf('d'),
    titleOf('b'),
    titleOf('e'),
    'synthetic-c-禁售词',
    titleOf('f'),
  ];

  expect(feedTitles(await f.run())).toEqual(all);
  const fetched = f.calls.length;

  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
    { platform: 'jd', categoryId: '61', keyword: null },
  ]);
  f.clock.advanceMs(60_000);
  const hit = await f.run();
  expect(f.calls.length).toBe(fetched);
  expect(feedTitles(hit)).toEqual([titleOf('a'), titleOf('d'), titleOf('f')]);

  f.clock.advanceMs(700_000);
  f.failChannel(TB, new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));
  f.failChannel(JD, new UnionError('upstream_unavailable', 'synthetic unavailable', 'jd'));
  const stale = await f.run();
  expect(feedTitles(stale)).toEqual([titleOf('a'), titleOf('d'), titleOf('f')]);
  expect(stale.items.map((card) => card.stale)).toEqual([true, true, true]);

  f.block(APP, []);
  expect(feedTitles(await f.run())).toEqual(all);
});

it('[AC-B1-04zzzz#14] 物料流告警：无类目与被滤项按平台分别计数，键恰为 event / platform / count；没有被滤项时不记 catalog_category_blocked', async () => {
  const f = sectionHome({ channels: [TB, JD] });
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'jd', categoryId: '61', keyword: null },
    { platform: 'jd', categoryId: '70', keyword: '禁售词' },
  ]);
  f.answer(TB, 1, [ranked('a', '50'), ranked('b', undefined), ranked('c', '')]);
  f.answer(JD, 1, [
    ranked('d', undefined, { platform: 'jd', title: 'synthetic-d-禁售词' }),
    ranked('e', '61', { platform: 'jd' }),
    ranked('f', undefined, { platform: 'jd' }),
  ]);

  const result = await f.run();

  expect([...feedTitles(result)].sort()).toEqual([titleOf('b'), titleOf('c'), titleOf('f')]);
  const warnings = f.warnings();
  const missing = eventsOf(warnings, MISSING_EVENT);
  const blocked = eventsOf(warnings, BLOCKED_EVENT);
  for (const fields of [...missing, ...blocked]) {
    expect(Object.keys(fields).sort()).toEqual(['count', 'event', 'platform']);
  }
  const of = (list: readonly Record<string, unknown>[], platform: string) =>
    total(list.filter((fields) => fields['platform'] === platform));
  expect(of(missing, 'taobao')).toBe(2);
  expect(of(missing, 'jd')).toBe(2);
  expect(of(blocked, 'taobao')).toBe(1);
  expect(of(blocked, 'jd')).toBe(2);
  expect(total(missing)).toBe(4);
  expect(total(blocked)).toBe(3);

  // Nothing dropped: no blocked alert at all.
  const clean = sectionHome({ channels: [TB] });
  clean.block(APP, [{ platform: 'taobao', categoryId: '50', keyword: null }]);
  clean.answer(TB, 1, [ranked('g', '60'), ranked('h', '61')]);
  expect(feedTitles(await clean.run())).toEqual([titleOf('g'), titleOf('h')]);
  expect(eventsOf(clean.warnings(), BLOCKED_EVENT)).toEqual([]);
  expect(total(eventsOf(clean.warnings(), MISSING_EVENT))).toBe(0);
});

it('[AC-B1-04zzzz#15] 商品池不滤（D10-1045 Q2）：union_material 照滤；product_pool 数据源与联盟故障时的兜底池照常出卡，不交给 filterCategories、不出类目告警', async () => {
  const poolA = ranked('pool-a', '50');
  const poolB = ranked('pool-b', undefined, { title: 'synthetic-pool-b-禁售词' });
  const pool = poolSide([poolCandidate(poolA), poolCandidate(poolB)]);
  const f = sectionHome({ channels: [TB], poolReader: pool.reader });
  f.block(APP, [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
  ]);
  f.answer(TB, 1, [ranked('u1', '50'), ranked('u2', '60')]);

  expect(feedTitles(await f.run())).toEqual([titleOf('u2')]);
  const alertsBefore = f
    .warnings()
    .filter(
      (fields) => fields['event'] === MISSING_EVENT || fields['event'] === BLOCKED_EVENT,
    ).length;
  const poolTitles = [titleOf('pool-a'), 'synthetic-pool-b-禁售词'];

  f.setSection({ dataSource: { kind: 'product_pool', pool_id: POOL_ID, limit: 10 } });
  const section = await f.run();
  expect(feedTitles(section)).toEqual(poolTitles);
  expect(section.items.every((card) => card.ad_label === '推广')).toBe(true);

  f.setSection({ dataSource: { kind: 'union_material', channels: [TB] } });
  f.failChannel(TB, new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));
  const fallback = await f.run();
  expect(pool.fallbackCalls).toEqual([APP]);
  expect(feedTitles(fallback)).toEqual(poolTitles);
  expect(fallback.items.every((card) => card.stale)).toBe(true);

  for (const title of poolTitles) expect(f.judgedTitles()).not.toContain(title);
  expect(
    f
      .warnings()
      .filter((fields) => fields['event'] === MISSING_EVENT || fields['event'] === BLOCKED_EVENT),
  ).toHaveLength(alertsBefore);
});
