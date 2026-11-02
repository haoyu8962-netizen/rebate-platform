import { expect, it } from 'vitest';
import {
  convertToDetail,
  ctx,
  detailItemId,
  identities,
  instant,
  KEYWORD,
  rowsFrom,
  searchBody,
  searchNumber,
  topBody,
  topRow,
  unionFailure,
} from '../taobao-official-search/official-harness.ts';
import {
  dtkGoodsId,
  expectTrueIdentities,
  goodsNumber,
  queryFields,
  response,
  sent,
} from '../taobao-search/kit.ts';
import {
  convertedBy,
  dataokeDefault,
  dataokeEmpty,
  dataokeFullPage,
  detailIds,
  detailLists,
  expectFallsBack,
  officialCount,
  officialDefault,
  officialDetailFails,
  officialFullPage,
  officialRateLimited,
  officialUnconverted,
  search,
  setup,
  transportDown,
  type SetupOptions,
  type Upstream,
} from './fallback-harness.ts';

// 第 6–9 条：一次搜索只有一个来源。结果不合并；游标带来源，续页按前缀走，不回落、不换源，失败就抛错；
// official_first 下两种游标都接受（official、dataoke 下只接受自己的，冻结用例已钉）。商品 ID：回落走 D10-504
// 大淘客换算（按位置），官方走最后一段，结果都是详情口径。quoted_at 是实际来源收到响应的时刻（BR-PRICE-11）。

const OFFICIAL_CURSOR = 'taobao-search:2';
const DATAOKE_CURSOR = 'tb-dtk-search:2';

/** `answer`, given `ms` later on the injected clock. */
function after(ms: number, answer: Upstream): Upstream {
  return (request, wire) => {
    wire.clock.advanceMs(ms);
    return answer(request, wire);
  };
}

it('[AC-B1-04zy#19] 结果不合并：官方第 1 批已换到、第 2 批失败时整步作废，回落的 items 全来自大淘客，不混官方已换到的行', async () => {
  const converted = convertedBy(convertToDetail);
  const h = setup({
    official: () => response(searchBody(rowsFrom(1, 25), 25)),
    detail: (request, wire) =>
      (searchNumber(detailIds(request)[0] ?? '') ?? 0) > 20
        ? transportDown()
        : converted(request, wire),
  });
  const page = await search(h);
  expect(expectTrueIdentities(page)).toEqual([1, 2]);
});

it('[AC-B1-04zy#20] 官方部分行换不到但还有结果：不回落、不补大淘客，只返回官方换到的行', async () => {
  await expectFallsBack();
  const h = setup({
    available: (id) => (searchNumber(id) === 2 ? undefined : convertToDetail(id)),
  });
  const page = await search(h);
  expect(identities(page)).toEqual([1, 3]);
  expect(h.dataokeTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04zy#21] 游标带来源：官方第 1 页给 taobao-search:2，回落第 1 页给大淘客自己的前缀', async () => {
  const official = setup({ official: officialFullPage });
  expect((await search(official)).nextCursor).toBe(OFFICIAL_CURSOR);

  const fallback = setup({ official: officialRateLimited, dataoke: dataokeFullPage });
  expect((await search(fallback)).nextCursor).toBe(DATAOKE_CURSOR);
});

it('[AC-B1-04zy#22] official_first 下两种游标都接受：taobao-search:2 走官方第 2 页不碰大淘客，tb-dtk-search:2 走大淘客第 2 页不碰官方', async () => {
  const official = setup({ official: officialFullPage });
  await search(official, { keyword: KEYWORD, cursor: OFFICIAL_CURSOR });
  expect(officialCount(official)).toBe(1);
  expect(official.dataokeTransport).not.toHaveBeenCalled();

  const dataoke = setup();
  await search(dataoke, { keyword: KEYWORD, cursor: DATAOKE_CURSOR });
  expect(officialCount(dataoke)).toBe(0);
  expect(dataoke.searchSlot).not.toHaveBeenCalled();
  expect(queryFields(sent(dataoke.dataokeTransport))['pageId']).toBe('2');
});

it('[AC-B1-04zy#23] 回落的第 1 页之后接着翻：官方恢复了也留在大淘客，翻页路上不再问官方', async () => {
  const h = setup({ official: officialRateLimited, dataoke: dataokeFullPage });
  const first = await search(h);
  expect(first.nextCursor).toBe(DATAOKE_CURSOR);
  h.upstreams.official = officialFullPage;
  await search(h, { keyword: KEYWORD, cursor: first.nextCursor! });
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04zy#24] 续页不回落、不换源：官方续页失败抛官方的错，大淘客续页失败抛大淘客的错，都不问另一边', async () => {
  await expectFallsBack();
  const official = setup({ official: officialRateLimited });
  await unionFailure(
    () => official.adapter.searchItems({ keyword: KEYWORD, cursor: OFFICIAL_CURSOR }, ctx),
    'rate_limited',
  );
  expect(official.dataokeTransport).not.toHaveBeenCalled();

  const dataoke = setup({ dataoke: transportDown });
  await unionFailure(
    () => dataoke.adapter.searchItems({ keyword: KEYWORD, cursor: DATAOKE_CURSOR }, ctx),
    'upstream_unavailable',
  );
  expect(officialCount(dataoke)).toBe(0);
});

it('[AC-B1-04zy#25] 续页 0 条是空页，不回落、不换源', async () => {
  await expectFallsBack();
  const official = setup({ official: () => response(searchBody([], 0)) });
  const empty = await search(official, { keyword: KEYWORD, cursor: OFFICIAL_CURSOR });
  expect(empty).toEqual({ items: [], nextCursor: null });
  expect(official.dataokeTransport).not.toHaveBeenCalled();

  const dataoke = setup({ dataoke: dataokeEmpty });
  const nothing = await search(dataoke, { keyword: KEYWORD, cursor: DATAOKE_CURSOR });
  expect(nothing).toEqual({ items: [], nextCursor: null });
  expect(officialCount(dataoke)).toBe(0);
});

it('[AC-B1-04zy#26] official_first 下非法或别的接口的游标 → invalid_dto，不读推广位、不取凭据、不发请求', async () => {
  const accepted = setup();
  await search(accepted, { keyword: KEYWORD, cursor: DATAOKE_CURSOR });
  for (const cursor of [
    'garbage',
    '',
    '2',
    'pdd-search:2:',
    'pdd-feed:20',
    'taobao-search:',
    'taobao-search:0',
    'tb-dtk-search:',
    'tb-dtk-search:0',
    ' taobao-search:2',
    ' tb-dtk-search:2',
  ]) {
    const h = setup();
    const q = { keyword: KEYWORD, cursor };
    await unionFailure(() => h.adapter.searchItems(q, ctx), 'invalid_dto');
    expect(h.searchSlot, cursor).not.toHaveBeenCalled();
    expect(h.credentials, cursor).not.toHaveBeenCalled();
    expect(h.transport, cursor).not.toHaveBeenCalled();
    expect(h.dataokeTransport, cursor).not.toHaveBeenCalled();
  }
});

it('[AC-B1-04zy#27] 回落结果走 D10-504 大淘客换算，按位置对应；官方走最后一段，乱序也各得其所', async () => {
  const fallback = setup({ official: officialRateLimited });
  const page = await search(fallback);
  expect(detailLists(fallback)).toEqual([[dtkGoodsId(1), dtkGoodsId(2)]]);
  expect(expectTrueIdentities(page)).toEqual([1, 2]);

  // 换算结果倒序返回：按最后一段对应时每条商品仍拿到自己的 ID。
  const official = setup({
    detail: (request) => {
      const reversed = detailIds(request).reverse();
      return response(topBody(reversed.map((id) => topRow(convertToDetail(id)!))));
    },
  });
  expect(identities(await search(official))).toEqual([1, 2, 3]);
});

it('[AC-B1-04zy#28] 同一商品走官方或回落，item_id 都是同一个详情口径 ID', async () => {
  const available = (id: string): string | undefined => {
    const n = searchNumber(id) ?? goodsNumber(id);
    return n === undefined ? undefined : detailItemId(n);
  };
  const official = await search(
    setup({ available, official: () => response(searchBody(rowsFrom(1, 2), 2)) }),
  );
  const fallback = await search(setup({ available, official: officialRateLimited }));
  const expected = [1, 2].map(detailItemId);
  expect(official.items.map((item) => item.item_id)).toEqual(expected);
  expect(fallback.items.map((item) => item.item_id)).toEqual(expected);
});

it('[AC-B1-04zy#29] quoted_at 是实际来源收到搜索响应的时刻：官方失败耗时 T 后回落，取大淘客响应时刻，不是官方失败时刻也不是换算响应时刻', async () => {
  const start = Date.parse(instant);
  const h = setup({
    official: (_request, wire) => {
      wire.clock.advanceMs(700);
      return officialRateLimited();
    },
    dataoke: (_request, wire) => {
      wire.clock.advanceMs(300);
      return dataokeDefault();
    },
    detail: (request, wire) => {
      wire.clock.advanceMs(250);
      return response(topBody(detailIds(request).map((id) => topRow(convertToDetail(id)!))));
    },
  });
  const page = await search(h);
  expect(page.items.length).toBeGreaterThan(0);
  const dataokeAnswered = new Date(start + 1000).toISOString();
  for (const item of page.items) expect(item.quoted_at).toBe(dataokeAnswered);
  expect(h.clock.now().getTime()).toBe(start + 1250);
});

it('[AC-B1-04zy#30] 没回落时 quoted_at 仍是官方收到搜索响应的时刻，不是换算响应时刻', async () => {
  await expectFallsBack();
  const start = Date.parse(instant);
  const h = setup({
    official: after(400, officialFullPage),
    detail: after(250, convertedBy(convertToDetail)),
  });
  const page = await search(h);
  expect(page.items.length).toBeGreaterThan(0);
  const officialAnswered = new Date(start + 400).toISOString();
  for (const item of page.items) expect(item.quoted_at).toBe(officialAnswered);
  expect(h.clock.now().getTime()).toBe(start + 650);
});

// 官方有回应（不是抛错）后才回落时，手上已有官方的收到时刻，最容易把它带进大淘客的结果。
it.each([
  ['官方 0 条', { official: after(400, () => response(searchBody([], 0))) }],
  ['官方全部换不到 ID', { official: after(400, officialDefault), available: officialUnconverted }],
  [
    '官方换算失败（TOP code 7）',
    { official: after(400, officialDefault), detail: officialDetailFails(officialRateLimited) },
  ],
] as [string, SetupOptions][])(
  '[AC-B1-04zy#64] quoted_at：%s，官方在 start+400 有回应后回落，大淘客 start+700 响应 → 取 start+700，不是官方收到响应的时刻',
  async (_label, options) => {
    const start = Date.parse(instant);
    const h = setup({ ...options, dataoke: after(300, dataokeDefault) });
    const page = await search(h);
    expect(expectTrueIdentities(page)).toEqual([1, 2]);
    const dataokeAnswered = new Date(start + 700).toISOString();
    for (const item of page.items) expect(item.quoted_at).toBe(dataokeAnswered);
  },
);
