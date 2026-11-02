import { expect, it } from 'vitest';
import { unionPolicy } from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/application/governed-adapter.ts';
import type {
  CallCtx,
  Page,
  UnionItem,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { createTaobaoSearchCounter } from '../../../../apps/api/src/modules/union/infra/taobao/search-counter.ts';
import { flush, observe } from '../../platform/http/kit.ts';
import {
  convertToDetail,
  ctx,
  endpoint,
  formOf,
  identities,
  KEYWORD,
  query,
  rowsFrom,
  searchBody,
  searchNumber,
  searchRequests,
  unionFailure,
} from '../taobao-official-search/official-harness.ts';
import { expectTrueIdentities, response } from '../taobao-search/kit.ts';
import {
  convertedBy,
  dataokeDefault,
  detailIds,
  expectFallsBack,
  hang,
  OFFICIAL_EMPTIES,
  OFFICIAL_FAILURES,
  officialCount,
  officialDefault,
  officialDetailFails,
  officialRateLimited,
  officialSignal,
  officialUnconverted,
  recorded,
  search,
  setup,
  transportDown,
} from './fallback-harness.ts';

// 第 10 条：官方这一步单独限时，为总预算（union 治理的一次调用：在线 3 秒、离线 10 秒）的一半；挂住时到点
// 放弃并回落，大淘客还能用剩余时间；调用方取消时不再回落。回落在适配器内，熔断器看不到官方失败，所以这样限时。
// 第 11 条：官方失败（第 2 条，含超时、换算失败）后 60 秒内本实例直接走大淘客，不发官方请求；59 999 毫秒仍冷却，
// 60 000 恢复；官方 0 条（含全部换不到 ID）不触发冷却；时间读注入 Clock。挂住的请求都用 observe 看结果，现实现不回落
// 时红在断言。

const COOLDOWN_MS = 60_000;
const OFFLINE: CallCtx = { ...ctx, purpose: 'pool_refresh' };

it.each([
  ['在线', ctx, unionPolicy('online').timeoutMs / 2],
  ['离线', OFFLINE, unionPolicy('offline').timeoutMs / 2],
] as [string, CallCtx, number][])(
  '[AC-B1-04zy#31] %s调用：官方挂住，到总预算一半才放弃并回落，放弃时官方请求被取消，大淘客的请求不受影响',
  async (_label, context, limit) => {
    const h = setup({ official: hang });
    const run = observe(h.adapter.searchItems(query, context));
    await h.scheduler.advance(limit - 1);
    expect(officialSignal(h).aborted).toBe(false);
    expect(run.settled).toBe('pending');
    expect(h.dataokeTransport).not.toHaveBeenCalled();

    await h.scheduler.advance(1);
    expect(officialSignal(h).aborted).toBe(true);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    expect(h.dataokeTransport.mock.calls[0]![0].signal?.aborted).not.toBe(true);
    expect(run.settled).toBe('resolved');
    expect(expectTrueIdentities(run.value as Page<UnionItem>)).toEqual([1, 2]);
  },
);

it('[AC-B1-04zy#32] 限时盖住官方整步：搜索回来了但换算 ID 挂住，到点同样放弃并回落', async () => {
  const converted = convertedBy(convertToDetail);
  const h = setup({
    detail: (request, wire) =>
      searchNumber(detailIds(request)[0] ?? '') === undefined
        ? converted(request, wire)
        : hang(request),
  });
  const limit = unionPolicy('online').timeoutMs / 2;
  const run = observe(h.adapter.searchItems(query, ctx));
  await h.scheduler.advance(limit);
  expect(run.settled).toBe('resolved');
  expect(expectTrueIdentities(run.value as Page<UnionItem>)).toEqual([1, 2]);
});

it('[AC-B1-04zy#33] 官方在限时内答完：不回落，限时的等待随之释放，不留定时器', async () => {
  await expectFallsBack();
  const limit = unionPolicy('online').timeoutMs / 2;
  const h = setup({
    official: async (_request, wire) => {
      await wire.scheduler.sleep(limit - 1);
      return officialDefault();
    },
  });
  const run = observe(h.adapter.searchItems(query, ctx));
  await h.scheduler.advance(limit - 1);
  expect(run.settled).toBe('resolved');
  expect(identities(run.value as Page<UnionItem>)).toEqual([1, 2, 3]);
  expect(h.dataokeTransport).not.toHaveBeenCalled();
  expect(h.scheduler.pending).toBe(0);
});

it('[AC-B1-04zy#34] 经真实治理层：官方挂住时到点放弃，大淘客用剩下的时间答完，整次调用不超时、不重试', async () => {
  const limit = unionPolicy('online').timeoutMs / 2;
  const rest = limit - 100;
  const h = setup({
    official: hang,
    dataoke: async (_request, wire) => {
      await wire.scheduler.sleep(rest);
      return dataokeDefault();
    },
  });
  const governed = createGovernedAdapter(h.adapter, {
    endpoint,
    scheduler: h.scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  const run = observe(governed.searchItems(query, ctx));
  await h.scheduler.advance(limit);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  await h.scheduler.advance(rest);
  expect(run.settled).toBe('resolved');
  expect(expectTrueIdentities(run.value as Page<UnionItem>)).toEqual([1, 2]);
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(h.scheduler.pending).toBe(0);
});

it('[AC-B1-04zy#35] 调用方取消时不再回落：官方在途被取消 → 原样抛，大淘客没被问，也不进冷却', async () => {
  await expectFallsBack();
  const h = setup({ official: hang });
  const controller = new AbortController();
  const run = observe(h.adapter.searchItems(query, { ...ctx, signal: controller.signal }));
  await flush();
  expect(officialCount(h)).toBe(1);
  controller.abort();
  await flush();
  expect(run.settled).toBe('rejected');
  expect(h.dataokeTransport).not.toHaveBeenCalled();

  h.upstreams.official = officialDefault;
  await search(h);
  expect(officialCount(h)).toBe(2);
});

it('[AC-B1-04zy#36] 调用方已取消时官方恰好失败：同样不回落；调用前就取消的也不回落', async () => {
  await expectFallsBack();
  const racing = new AbortController();
  const h = setup({
    official: () => {
      racing.abort();
      return transportDown();
    },
  });
  const run = observe(h.adapter.searchItems(query, { ...ctx, signal: racing.signal }));
  await flush();
  expect(run.settled).toBe('rejected');
  expect(h.dataokeTransport).not.toHaveBeenCalled();

  const before = setup({ official: hang });
  const cancelled = AbortSignal.abort();
  const early = observe(before.adapter.searchItems(query, { ...ctx, signal: cancelled }));
  await flush();
  expect(early.settled).toBe('rejected');
  expect(before.dataokeTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04zy#37] 回落后调用方取消：大淘客请求带着调用方的信号，被一起取消', async () => {
  await expectFallsBack();
  const controller = new AbortController();
  const h = setup({ official: officialRateLimited, dataoke: hang });
  const run = observe(h.adapter.searchItems(query, { ...ctx, signal: controller.signal }));
  await flush();
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  controller.abort();
  await flush();
  expect(run.settled).toBe('rejected');
});

it('[AC-B1-04zy#38] 冷却边界：官方失败时刻起 59 999 毫秒仍直接走大淘客、不发官方请求，60 000 毫秒整恢复；从失败时刻算，不从发出请求算', async () => {
  const h = setup({
    official: (_request, wire) => {
      wire.clock.advanceMs(1000);
      return officialRateLimited();
    },
  });
  await search(h);
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);

  h.upstreams.official = officialDefault;
  h.clock.advanceMs(COOLDOWN_MS - 1);
  const cooling = await search(h);
  expect(expectTrueIdentities(cooling)).toEqual([1, 2]);
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);

  h.clock.advanceMs(1);
  const recovered = await search(h);
  expect(identities(recovered)).toEqual([1, 2, 3]);
  expect(officialCount(h)).toBe(2);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
});

it.each(OFFICIAL_FAILURES)(
  '[AC-B1-04zy#39] 官方失败（%s）都进冷却：紧接着的第 1 页不发官方请求',
  async (_label, official) => {
    const h = setup({ official });
    await search(h);
    await search(h);
    expect(officialCount(h)).toBe(1);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
  },
);

it('[AC-B1-04zy#40] 超时也进冷却', async () => {
  const h = setup({ official: hang });
  const run = observe(h.adapter.searchItems(query, ctx));
  await h.scheduler.advance(unionPolicy('online').timeoutMs / 2);
  expect(run.settled).toBe('resolved');
  await search(h);
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04zy#65] 官方挂住超时这条路径计数：官方那次只记 official/fallback（不重复记 error），大淘客那次记 dataoke/ok', async () => {
  const searchCounter = createTaobaoSearchCounter();
  const h = setup({ official: hang, searchCounter });
  const run = observe(h.adapter.searchItems(query, ctx));
  await h.scheduler.advance(unionPolicy('online').timeoutMs / 2);
  expect(run.settled).toBe('resolved');
  expect(recorded(searchCounter)).toEqual({ 'official/fallback': 1, 'dataoke/ok': 1 });
});

it('[AC-B1-04zy#66] 搜索成功但换算失败（TOP code 7）也进冷却：紧接着的第 1 页不发官方请求', async () => {
  const h = setup({ detail: officialDetailFails(officialRateLimited) });
  await search(h);
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);

  await search(h);
  expect(officialCount(h)).toBe(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
});

it.each(OFFICIAL_EMPTIES)(
  '[AC-B1-04zy#41] 官方 0 条（%s）不触发冷却：下一次第 1 页照常先问官方',
  async (_label, official) => {
    const h = setup({ official });
    await search(h);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    await search(h);
    expect(officialCount(h)).toBe(2);
    expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
  },
);

it('[AC-B1-04zy#67] 官方全部换不到 ID（业务上是 0 条）不触发冷却：下一次第 1 页照常先问官方', async () => {
  const h = setup({ available: officialUnconverted });
  await search(h);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);

  await search(h);
  expect(officialCount(h)).toBe(2);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04zy#42] 不回落的失败不进冷却：空关键词、没有 query 推广位之后官方照常被问', async () => {
  await expectFallsBack();
  const blank = setup();
  await unionFailure(() => blank.adapter.searchItems({ keyword: ' ' }, ctx), 'invalid_dto');
  await search(blank);
  expect(officialCount(blank)).toBe(1);

  const noSlot = setup({ slot: null });
  await unionFailure(() => noSlot.adapter.searchItems(query, ctx), 'adapter_unimplemented');
  expect(noSlot.dataokeTransport).not.toHaveBeenCalled();
  await unionFailure(() => noSlot.adapter.searchItems(query, ctx), 'adapter_unimplemented');
  expect(noSlot.searchSlot).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04zy#43] 冷却按实例：别的适配器实例不受影响，照常先问官方', async () => {
  const cooling = setup({ official: officialRateLimited });
  await search(cooling);
  const other = setup();
  expect(identities(await search(other))).toEqual([1, 2, 3]);
  expect(officialCount(other)).toBe(1);
});

it('[AC-B1-04zy#44] 冷却中大淘客失败：抛大淘客的错，仍不发官方请求', async () => {
  const h = setup({ official: officialRateLimited });
  await search(h);
  h.upstreams.dataoke = transportDown;
  const failure = await unionFailure(
    () => h.adapter.searchItems(query, ctx),
    'upstream_unavailable',
  );
  expect(failure.message).toContain('dataoke');
  expect(officialCount(h)).toBe(1);
});

it('[AC-B1-04zy#45] 冷却中空关键词仍是 invalid_dto，不发大淘客请求', async () => {
  const h = setup({ official: officialRateLimited });
  await search(h);
  await unionFailure(() => h.adapter.searchItems({ keyword: ' ' }, ctx), 'invalid_dto');
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zy#46] 冷却不改续页：官方游标仍发官方请求、取到第 2 页，不因冷却报错、不换到大淘客；大淘客翻页照常', async () => {
  const h = setup({ official: officialRateLimited });
  await search(h);
  expect(officialCount(h)).toBe(1);

  h.upstreams.official = () => response(searchBody(rowsFrom(21, 3), 23));
  const second = await search(h, { keyword: KEYWORD, cursor: 'taobao-search:2' });
  expect(identities(second)).toEqual([21, 22, 23]);
  expect(officialCount(h)).toBe(2);
  expect(formOf(searchRequests(h)[1]!)['page_no']).toBe('2');
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);

  await search(h, { keyword: KEYWORD, cursor: 'tb-dtk-search:2' });
  expect(officialCount(h)).toBe(2);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
});
