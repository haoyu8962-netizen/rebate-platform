// B1-04zzzza (FU-SEARCH-QUERY-BLOCKWORDS, D10-860 ⑥ / D10-1064 口径 A): the search tab refuses a
// prohibited query word with an empty result. Order: query validation (20001) → platform (30131) →
// search switch (50304 search_disabled) → prohibited query word → cursor → session → query PID →
// union. A hit answers 200 with { items: [], next_cursor: null, has_more: false,
// fallback_items: [] }: no union search, no material feed, no PID, no session, no card, no link;
// one warn { event: 'search_query_prohibited', platform } without the query text.
// The port is wired as production wires it (harness.ts). All values are synthetic.
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { SearchProductsQuery } from '../../../../apps/api/src/modules/catalog/search.ts';
import { feedChannels } from '../category-blocklist-search/kit.ts';
import { candidate, fixture } from '../search/kit.ts';
import {
  EMPTY,
  EVENT,
  IDEO_SPACE,
  NB_SPACE,
  NONE,
  normalizeForKeywords,
  setup,
  sideEffects,
  specProhibited,
  warnsOf,
} from './harness.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

it('[AC-B1-04zzzza#5] yaml 的每个 prohibited 词（原词、前后带普通词）作查询词：200 空结果，联盟搜索、物料流、推广位、会话、卡片与链接登记都为 0 次', async () => {
  feedChannels();
  const words = specProhibited();
  expect(words.length).toBeGreaterThan(0);
  for (const word of words) {
    for (const q of [word, `正品${word}推荐`]) {
      const f = setup();
      const outcome = await f.attempt({ q });
      expect(outcome, q).toStrictEqual({ kind: 'returned', value: EMPTY });
      expect(sideEffects(f), q).toStrictEqual(NONE);
    }
  }
});

it.each([
  'ＵＳＤＴ',
  'Usdt',
  '电 子 烟',
  '电子\t烟',
  `${IDEO_SPACE}香烟${NB_SPACE}`,
  '刀具架',
  '厨房刀具',
])(
  '[AC-B1-04zzzza#6] 全角、大小写、夹空白或制表符的写法同样命中：%j → 空结果、不调联盟',
  async (q) => {
    feedChannels();
    const f = setup();
    expect(await f.attempt({ q })).toStrictEqual({ kind: 'returned', value: EMPTY });
    expect(sideEffects(f)).toStrictEqual(NONE);
  },
);

it.each(['非处方药', '烟灰缸', '合成纸巾'])(
  '[AC-B1-04zzzza#7] 不误伤：%j 不命中，结果、联盟调用参数与会话写入都与未接端口时相同；同一端口下命中词不调联盟',
  async (q) => {
    const wired = setup();
    const bare = fixture();
    bare.pages.set(1, { items: [candidate('main-a'), candidate('main-b')], hasMore: false });
    const withPort = await wired.attempt({ q });
    const withoutPort = await bare.run({ q });
    expect(withPort).toStrictEqual({ kind: 'returned', value: withoutPort });
    expect(withoutPort.items).toHaveLength(2);
    expect(wired.search.mock.calls).toEqual(bare.search.mock.calls);
    expect(wired.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ keyword: q }));
    expect(wired.sessions.write.mock.calls).toEqual(bare.sessions.write.mock.calls);
    expect(wired.register).toHaveBeenCalledTimes(2);
    expect(warnsOf(wired.warn, EVENT)).toEqual([]);

    const before = sideEffects(wired);
    const hit = await wired.attempt({ q: `${q}处方药` });
    expect(hit).toStrictEqual({ kind: 'returned', value: EMPTY });
    expect(sideEffects(wired)).toStrictEqual(before);
  },
);

it.each<Partial<SearchProductsQuery>>([
  { q: '' },
  { q: '电子烟', limit: 0 },
  { q: '电子烟', limit: 51 },
  { q: '电子烟', price_min_fen: 0 },
  { q: '电子烟', price_min_fen: 500, price_max_fen: 100 },
])(
  '[AC-B1-04zzzza#8] 优先级：参数非法 %j 仍是 20001（禁词不盖掉），不记禁词日志；改成合法参数后命中即空结果',
  async (query) => {
    feedChannels();
    const f = setup();
    const refused = await f.attempt(query);
    expect(refused).toMatchObject({ kind: 'rejected', error: { code: 20001 } });
    expect(warnsOf(f.warn, EVENT)).toEqual([]);
    expect(sideEffects(f)).toStrictEqual(NONE);

    expect(await f.attempt({ q: '电子烟' })).toStrictEqual({ kind: 'returned', value: EMPTY });
    expect(sideEffects(f)).toStrictEqual(NONE);
  },
);

it('[AC-B1-04zzzza#9] 优先级：平台不支持搜索仍是 30131，不记禁词日志；平台恢复后命中即空结果', async () => {
  feedChannels();
  const f = setup();
  f.requirePlatform.mockRejectedValueOnce(new CatalogError(30131, 'synthetic unsupported'));
  const refused = await f.attempt({ q: '电子烟' });
  expect(refused).toMatchObject({ kind: 'rejected', error: { code: 30131 } });
  expect(warnsOf(f.warn, EVENT)).toEqual([]);
  expect(sideEffects(f)).toStrictEqual(NONE);

  expect(await f.attempt({ q: '电子烟' })).toStrictEqual({ kind: 'returned', value: EMPTY });
  expect(sideEffects(f)).toStrictEqual(NONE);
});

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-04zzzza#10] 优先级：%s 搜索开关关闭仍是 50304 search_disabled，不记禁词日志；开关打开后命中即空结果，且开关与平台能力照常先判',
  async (platform) => {
    feedChannels();
    const f = setup(platform);
    f.enabled.set(platform, false);
    const refused = await f.attempt({ platform, q: '电子烟' });
    expect(refused).toMatchObject({
      kind: 'rejected',
      error: { code: 50304, data: { platform, reason: 'search_disabled' } },
    });
    expect(warnsOf(f.warn, EVENT)).toEqual([]);

    f.enabled.set(platform, true);
    f.configValue.mockClear();
    f.requirePlatform.mockClear();
    expect(await f.attempt({ platform, q: '电子烟' })).toStrictEqual({
      kind: 'returned',
      value: EMPTY,
    });
    expect(f.requirePlatform).toHaveBeenCalledExactlyOnceWith(platform, {
      parseEnabled: false,
      searchEnabled: true,
    });
    expect(f.configValue).toHaveBeenCalledWith('synthetic-app', `search.enabled.${platform}`);
    expect(sideEffects(f)).toStrictEqual(NONE);
  },
);

it('[AC-B1-04zzzza#11] 续页：带合法 cursor 且查询词命中同样返回空结果，不读会话、不写会话、不调联盟；判定在解析游标之前，坏游标加命中词也是空结果', async () => {
  feedChannels();
  const f = setup();
  f.pages.set(1, { items: [candidate('page-1')], hasMore: true });
  f.pages.set(2, { items: [candidate('page-2')], hasMore: true });
  const first = await f.run({ q: '合成纸巾', limit: 1 });
  expect(first.next_cursor).toEqual(expect.any(String));
  const before = sideEffects(f);

  const continued = await f.attempt({ q: '电子烟', limit: 1, cursor: first.next_cursor! });
  expect(continued).toStrictEqual({ kind: 'returned', value: EMPTY });
  expect(sideEffects(f)).toStrictEqual(before);

  const malformed = await f.attempt({ q: '电子烟', cursor: 'synthetic-unknown-cursor' });
  expect(malformed).toStrictEqual({ kind: 'returned', value: EMPTY });
  expect(sideEffects(f)).toStrictEqual(before);
});

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-04zzzza#12] 日志：%s 命中只记恰好一条 warn，字段严格为 { event: search_query_prohibited, platform }，日志里不出现查询词原文或归一化后的写法',
  async (platform) => {
    feedChannels();
    const f = setup(platform);
    const q = '正品 电子烟 推荐';
    expect(await f.attempt({ platform, q })).toStrictEqual({ kind: 'returned', value: EMPTY });
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn.mock.calls[0]?.[0]).toStrictEqual({ event: EVENT, platform });
    const logged = JSON.stringify(f.warn.mock.calls);
    for (const text of [q, normalizeForKeywords(q), '电子烟', '正品']) {
      expect(logged).not.toContain(text);
    }
  },
);
