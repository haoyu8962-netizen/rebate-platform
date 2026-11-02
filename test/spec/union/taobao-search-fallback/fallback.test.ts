import { expect, it } from 'vitest';
import { outcome } from '../taobao-dataoke-switches/kit.ts';
import {
  ctx,
  identities,
  query,
  rowsFrom,
  SEARCH_ENVELOPE,
  searchBody,
  unionFailure,
} from '../taobao-official-search/official-harness.ts';
import { expectTrueIdentities, response } from '../taobao-search/kit.ts';
import {
  dataokeEmpty,
  dataokeFullPage,
  expectFallsBack,
  OFFICIAL_EMPTIES,
  OFFICIAL_FAILURES,
  officialCount,
  officialDetailFails,
  officialInvalidRows,
  officialRateLimited,
  officialUnconverted,
  search,
  setup,
  transportDown,
  type Upstream,
} from './fallback-harness.ts';

// 第 2–5 条：回落只看 cursor 为空的第 1 页。官方抛 upstream_unavailable、rate_limited、upstream_rejected
// （含 code 11）、超时，或成功但 0 条、全部换不到 ID，才回落；invalid_dto、配置错误、调用方取消不回落
// （超时与取消见 timing.test.ts）。大淘客也失败抛大淘客的错误，两边都 0 条是空页。

it.each(OFFICIAL_FAILURES)(
  '[AC-B1-04zy#6] 官方失败：%s → 回落到大淘客，返回大淘客结果',
  async (_label, official) => {
    const h = setup({ official });
    const page = await search(h);
    expect(expectTrueIdentities(page)).toEqual([1, 2]);
    expect(officialCount(h)).toBe(1);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['code 7（rate_limited）', officialRateLimited],
  ['传输抛错（upstream_unavailable）', transportDown],
] as [string, Upstream][])(
  '[AC-B1-04zy#7] 官方搜索成功但换算 ID 失败：%s → 也算官方这一步失败，回落，不混官方的行',
  async (_label, failure) => {
    const h = setup({ detail: officialDetailFails(failure) });
    const page = await search(h);
    expect(expectTrueIdentities(page)).toEqual([1, 2]);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);

it.each(OFFICIAL_EMPTIES)('[AC-B1-04zy#8] 官方成功但 0 条：%s → 回落', async (_label, official) => {
  const h = setup({ official });
  const page = await search(h);
  expect(expectTrueIdentities(page)).toEqual([1, 2]);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zy#9] 官方有结果但全部换不到 ID 被丢掉、items 为空 → 回落', async () => {
  const h = setup({ available: officialUnconverted });
  const page = await search(h);
  expect(expectTrueIdentities(page)).toEqual([1, 2]);
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zy#10] 官方满页但全部换不到：回落后的 nextCursor 是大淘客自己的，不是官方的 taobao-search:2', async () => {
  const h = setup({
    available: officialUnconverted,
    official: () => response(searchBody(rowsFrom(1, 20), 165)),
    dataoke: dataokeFullPage,
  });
  const page = await search(h);
  expect(expectTrueIdentities(page)).toHaveLength(20);
  expect(page.nextCursor).toBe('tb-dtk-search:2');
});

it.each(OFFICIAL_FAILURES)(
  '[AC-B1-04zy#11] 官方失败（%s）、大淘客也失败 → 抛大淘客的错误，不是官方的',
  async (_label, official) => {
    const h = setup({ official, dataoke: transportDown });
    const failure = await unionFailure(
      () => h.adapter.searchItems(query, ctx),
      'upstream_unavailable',
    );
    expect(failure.message).toContain('dataoke');
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04zy#12] 官方 0 条、大淘客失败 → 抛大淘客的错误，不当成空页', async () => {
  const h = setup({ official: OFFICIAL_EMPTIES[0]![1], dataoke: transportDown });
  const failure = await unionFailure(
    () => h.adapter.searchItems(query, ctx),
    'upstream_unavailable',
  );
  expect(failure.message).toContain('dataoke');
});

it.each(OFFICIAL_EMPTIES)(
  '[AC-B1-04zy#13] 官方 0 条（%s）、大淘客也 0 条 → 空页不报错，且大淘客确实问过',
  async (_label, official) => {
    const h = setup({ official, dataoke: dataokeEmpty });
    const page = await search(h);
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);

it.each(['', '   '])(
  '[AC-B1-04zy#14] 空关键词 %j → invalid_dto 原样抛，不回落、不发请求',
  async (keyword) => {
    await expectFallsBack();
    const h = setup();
    await unionFailure(() => h.adapter.searchItems({ keyword }, ctx), 'invalid_dto');
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.dataokeTransport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zy#15] 配置错误（没有 query 推广位）→ adapter_unimplemented 原样抛，不回落', async () => {
  await expectFallsBack();
  const h = setup({ slot: null });
  await unionFailure(() => h.adapter.searchItems(query, ctx), 'adapter_unimplemented');
  expect(h.dataokeTransport).not.toHaveBeenCalled();
});

it.each([
  ['result_list 损坏', () => response({ [SEARCH_ENVELOPE]: { result_list: 'synthetic-broken' } })],
  ['每行都缺标题', officialInvalidRows],
] as [string, Upstream][])(
  '[AC-B1-04zy#16] 官方响应判 invalid_dto（%s）→ 原样抛，不回落',
  async (_label, official) => {
    await expectFallsBack();
    const h = setup({ official });
    await unionFailure(() => h.adapter.searchItems(query, ctx), 'invalid_dto');
    expect(h.dataokeTransport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zy#17] 回落清单之外的失败（读推广位抛错）→ 原样抛，不回落', async () => {
  await expectFallsBack();
  const readFailure = new Error('synthetic slot read failed');
  const h = setup({
    slotReader: async () => {
      throw readFailure;
    },
  });
  const failure = await outcome(() => h.adapter.searchItems(query, ctx));
  expect(failure).toBe(readFailure);
  expect(h.dataokeTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04zy#18] 官方有结果就不回落：结果照官方口径返回，不问大淘客', async () => {
  await expectFallsBack();
  const h = setup();
  const page = await search(h);
  expect(identities(page)).toEqual([1, 2, 3]);
  expect(h.dataokeTransport).not.toHaveBeenCalled();
});
