import { expect, it } from 'vitest';
import type { CallCtx } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ADZONE,
  businessFields,
  ctx,
  DETAIL,
  detailIdLists,
  endpoint,
  expectNothingSent,
  formOf,
  KEYWORD,
  OFFICIAL_SEARCH,
  query,
  requestsOf,
  search,
  searchRequests,
  setup,
  SLOT_PID,
  unionFailure,
} from './official-harness.ts';

// 官方搜索请求（D10-582）：POST 淘宝网关，业务参数只有 q 原样 / page_no / page_size 20 / adzone_id，
// 不传 sort；adzone_id 取该 App query 场景 active 推广位 PID 的第 3 段（BR-PROD-07）；没有这样的推广位
// 不发请求。推广位本身怎么选见 slot-reader.test.ts。

it('[AC-B1-04zx#1] 首页：POST 淘宝网关调官方搜索，业务参数只有 q 原样 / page_no 1 / page_size 20 / adzone_id，不传 sort；归档 kind = query', async () => {
  const h = setup();
  await search(h);
  const requests = searchRequests(h);
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.platform).toBe('taobao');
  expect(request.method).toBe('POST');
  expect(request.url).toBe(endpoint.baseUrl);
  expect(formOf(request)['method']).toBe(OFFICIAL_SEARCH);
  expect(businessFields(request)).toEqual({
    q: KEYWORD,
    page_no: '1',
    page_size: '20',
    adzone_id: ADZONE,
  });
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'query' });
});

it.each(['  合成 抽纸  ', '合成&抽纸=100抽', '+合成%20抽纸'])(
  '[AC-B1-04zx#2] 关键词 %j 原样进 q（不修剪、不改写）',
  async (keyword) => {
    const h = setup();
    await search(h, { keyword });
    expect(businessFields(searchRequests(h)[0]!)['q']).toBe(keyword);
  },
);

it('[AC-B1-04zx#3] adzone_id 按调用方 App 读：读者收到本次 CallCtx，每次调用重读，取 PID 第 3 段', async () => {
  const h = setup();
  const other: CallCtx = { ...ctx, appId: 'fake-other-search-app' };
  h.searchSlot.mockImplementation(async (context) =>
    context.appId === other.appId ? 'mm_1000000002_3000000002_111222333' : SLOT_PID,
  );
  await search(h);
  await search(h, query, other);
  expect(h.searchSlot).toHaveBeenCalledTimes(2);
  expect(h.searchSlot.mock.calls[0]![0]).toBe(ctx);
  expect(h.searchSlot.mock.calls[1]![0]).toBe(other);
  expect(searchRequests(h).map((request) => businessFields(request)['adzone_id'])).toEqual([
    ADZONE,
    '111222333',
  ]);
});

it('[AC-B1-04zx#4] 该 App 没有 query 场景 active 推广位 → adapter_unimplemented，不取凭据、不发请求；有了才搜索', async () => {
  const none = setup({ slot: null });
  await unionFailure(() => none.adapter.searchItems(query, ctx), 'adapter_unimplemented');
  expect(none.searchSlot).toHaveBeenCalledTimes(1);
  expect(none.searchSlot.mock.calls[0]![0]).toBe(ctx);
  expectNothingSent(none);

  const wired = setup({ slot: SLOT_PID });
  await search(wired);
  expect(searchRequests(wired)).toHaveLength(1);
});

it.each(['', '   ', '\t\n'])(
  '[AC-B1-04zx#5] 空白关键词 %j → invalid_dto，不取凭据、不发请求',
  async (keyword) => {
    const h = setup();
    await unionFailure(() => h.adapter.searchItems({ keyword }, ctx), 'invalid_dto');
    expectNothingSent(h);
  },
);

it('[AC-B1-04zx#6] 调用方 AbortSignal 原样挂在搜索请求与换算请求上，两者都归档 kind = query', async () => {
  const controller = new AbortController();
  const withSignal: CallCtx = { ...ctx, signal: controller.signal };
  const h = setup();
  await search(h, query, withSignal);
  const requests = [...searchRequests(h), ...requestsOf(h, DETAIL)];
  expect(detailIdLists(h)).toHaveLength(1);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.signal).toBe(controller.signal);
    expect(request.archive).toEqual({ appId: ctx.appId, kind: 'query' });
  }
});
