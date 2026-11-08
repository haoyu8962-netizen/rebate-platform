import { expect, it } from 'vitest';
import type {
  ItemRef,
  UnionErrorCode,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/index.ts';
import { endpoint, formFields, response, sent, unionFailure } from '../jd-core/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  ctx,
  failure,
  invoke,
  itemRef,
  listing,
  listOf,
  method,
  mode,
  ports,
  reply,
  row,
  skuId,
  success,
  title,
  wholeItemId,
  wire,
  withPrice,
  type Answer,
} from './kit.ts';

/** Upstream holding `count(pageSize)` goods, cut by the pageIndex and pageSize of each request. */
function upstream(count: (size: number) => number): Answer {
  return (body) => {
    const size = Number(body.pageSize);
    const index = Number(body.pageIndex);
    const all = listOf(count(size));
    return listing(all.slice((index - 1) * size, index * size), all.length);
  };
}

const innerFailures = [
  ['429', 'rate_limited'],
  ['410', 'link_unrecognized'],
  ['411', 'link_unrecognized'],
  ['999', 'upstream_rejected'],
] as const;

const notArrays: readonly (readonly [string, unknown])[] = [
  ['对象', { note: 'x' }],
  ['字符串', 'x'],
  ['数字', num('1')],
  ['null', null],
];

const skuRefs: readonly (readonly [string, ItemRef])[] = [
  ['item_id', { platform: 'jd', item_id: skuId }],
  ['skuId', { platform: 'jd', skuId }],
  // 链接复核的 itemRefOf（linking）在任何模式都把存下的原串放在 itemId。
  ['itemId', { platform: 'jd', itemId: skuId }],
];

const skuAnswers: readonly (readonly [string, () => UnionTransportResponse])[] = [
  ['410', () => reply(failure('410'))],
  ['411', () => reply(failure('411'))],
  ['data 缺失', () => reply(success())],
  ['空数组', () => listing([])],
  ['返回的行没有 skuId', () => listing([row({ skuId: undefined })])],
];

it('[AC-B1-04zc#1] searchItems 走 goods.query：goodsReqDTO 带 keyword、pageIndex、pageSize、sceneId', async () => {
  const { adapter, requests, transport } = wire(() => listing([row()]));
  const page = await adapter.searchItems({ keyword: '合成 茶具 & 杯' }, ctx);
  expect(page.items).toHaveLength(1);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(sent(transport).url).toBe(endpoint.baseUrl);
  expect(formFields(sent(transport)).method).toBe(method);
  expect(requests[0]).toMatchObject({ keyword: '合成 茶具 & 杯', pageIndex: 1, sceneId: 1 });
  expect(requests[0]).not.toHaveProperty('itemIds');
  const size = requests[0]!.pageSize;
  expect(Number.isInteger(size)).toBe(true);
  expect(size).toBeGreaterThanOrEqual(1);
  expect(size).toBeLessThanOrEqual(30);
});

it.each(ports)(
  '[AC-B1-04zc#2] %s 把取消信号与归档上下文（kind=query）挂在传输请求上',
  async (port) => {
    const { adapter, transport } = wire(() => listing([row()]));
    const controller = new AbortController();
    await invoke(adapter, port, { ...ctx, signal: controller.signal });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sent(transport).signal).toBe(controller.signal);
    expect(sent(transport).archive).toEqual({ appId: ctx.appId, kind: 'query' });
  },
);

const innerCases = ports.flatMap((port) =>
  innerFailures.map(([code, expected]) => [port, code, expected] as const),
);

it.each(innerCases)('[AC-B1-04zc#3] %s 内层 %s → %s，只发一次', async (port, code, expected) => {
  const { adapter, requests } = wire(() => reply(failure(code)));
  await unionFailure(() => invoke(adapter, port), expected);
  expect(requests).toHaveLength(1);
});

it.each(ports)('[AC-B1-04zc#4] %s 内层 403 按底座告警一次（没有商品权限）', async (port) => {
  const { adapter, warn } = wire(() => reply(failure('403')));
  await unionFailure(() => invoke(adapter, port), 'upstream_misconfigured');
  expect(warn.mock.calls).toEqual([[{ method, code: '403' }]]);
});

const baseFailures: readonly (readonly [string, Answer, UnionErrorCode])[] = [
  ['HTTP 503', () => response({}, 503), 'upstream_unavailable'],
  ['网关 code 2', () => response({ error_response: { code: '2' } }), 'rate_limited'],
  ['网关 code 7', () => response({ error_response: { code: '7' } }), 'upstream_rejected'],
];
const baseCases = ports.flatMap((port) =>
  baseFailures.map(([name, answer, expected]) => [port, name, answer, expected] as const),
);

it.each(baseCases)('[AC-B1-04zc#5] %s 遇 %s 按底座分类', async (port, _name, answer, expected) => {
  const { adapter } = wire(answer);
  await unionFailure(() => invoke(adapter, port), expected);
});

it('[AC-B1-04zc#6] 不透明游标翻页：续传同一关键词，按 totalCount 与已取条数判定，到尾为 null', async () => {
  const { adapter, requests } = wire(upstream((size) => size + 1));
  const first = await adapter.searchItems({ keyword: '合成分页' }, ctx);
  const size = Number(requests[0]!.pageSize);
  expect(first.items).toHaveLength(size);
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = await adapter.searchItems({ keyword: '合成分页', cursor: first.nextCursor! }, ctx);
  expect(requests[1]).toMatchObject({
    keyword: '合成分页',
    pageIndex: 2,
    pageSize: size,
    sceneId: 1,
  });
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(requests).toHaveLength(2);
  const ids = [...first.items, ...second.items].map((item) => item.item_id);
  expect(new Set(ids).size).toBe(size + 1);
});

it('[AC-B1-04zc#7] 总数恰为一页：第一页就结束，不多发一次', async () => {
  const { adapter, requests } = wire(upstream((size) => size));
  const page = await adapter.searchItems({ keyword: '合成分页' }, ctx);
  expect(page.nextCursor).toBeNull();
  expect(requests).toHaveLength(1);
});

it('[AC-B1-04zc#8] 总数恰为两页：第二页的游标为 null', async () => {
  const { adapter, requests } = wire(upstream((size) => size * 2));
  const first = await adapter.searchItems({ keyword: '合成分页' }, ctx);
  const second = await adapter.searchItems({ keyword: '合成分页', cursor: first.nextCursor! }, ctx);
  expect(second.items).toHaveLength(Number(requests[0]!.pageSize));
  expect(second.nextCursor).toBeNull();
  expect(requests).toHaveLength(2);
});

it('[AC-B1-04zc#9] 已取条数按上游行数算：不出卡的异常商品不让翻页提前结束', async () => {
  const rows = (size: number) => [withPrice(num('39.905')), ...listOf(size)];
  const { adapter, requests } = wire((body) => {
    const size = Number(body.pageSize);
    const index = Number(body.pageIndex);
    return listing(rows(size).slice((index - 1) * size, index * size), size + 1);
  });
  const first = await adapter.searchItems({ keyword: '合成分页' }, ctx);
  const size = Number(requests[0]!.pageSize);
  expect(first.items).toHaveLength(size - 1);
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = await adapter.searchItems({ keyword: '合成分页', cursor: first.nextCursor! }, ctx);
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
});

it('[AC-B1-04zc#10] 一页全是异常商品：items 为空，游标仍指下一页', async () => {
  const { adapter, requests } = wire((body) => {
    const size = Number(body.pageSize);
    const rows = Array.from({ length: size }, () => withPrice(undefined));
    return listing(rows, size + 1);
  });
  const page = await adapter.searchItems({ keyword: '合成分页' }, ctx);
  expect(requests).toHaveLength(1);
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toEqual(expect.any(String));
});

it('[AC-B1-04zc#92] 总数恰为一页且含不出卡的异常商品：已取条数按上游行数算，第一页就结束', async () => {
  const { adapter, requests } = wire((body) => {
    const size = Number(body.pageSize);
    return listing([withPrice(num('39.905')), ...listOf(size - 1)], size);
  });
  const page = await adapter.searchItems({ keyword: '合成分页' }, ctx);
  expect(requests).toHaveLength(1);
  expect(page.items).toHaveLength(Number(requests[0]!.pageSize) - 1);
  expect(page.nextCursor).toBeNull();
});

it.each<[string, () => UnionTransportResponse]>([
  ['内层 200 而 data 缺失', () => reply(success())],
  ['data 为空数组', () => listing([])],
  ['data 为空但 totalCount 还有', () => listing([], 5)],
])('[AC-B1-04zc#11] 搜索 %s → 空页，翻页结束', async (_name, answer) => {
  const { adapter } = wire(answer);
  expect(await adapter.searchItems({ keyword: '合成无结果' }, ctx)).toEqual({
    items: [],
    nextCursor: null,
  });
});

it.each(ports.flatMap((port) => notArrays.map(([name, data]) => [port, name, data] as const)))(
  '[AC-B1-04zc#12] %s 的 data 是%s → invalid_dto，不当空结果',
  async (port, _name, data) => {
    const { adapter } = wire(() => reply(success({ data })));
    await unionFailure(() => invoke(adapter, port), 'invalid_dto');
  },
);

it.each(['not-a-cursor', '', 'jd-order:2', 'jd-goods:0', 'jd-goods:-1'])(
  '[AC-B1-04zc#13] 损坏游标 %j → invalid_dto，不取凭据、不发请求、不从首页重来',
  async (cursor) => {
    const { adapter, credentials, transport } = wire(() => listing([row()]));
    await unionFailure(
      () => adapter.searchItems({ keyword: '合成分页', cursor }, ctx),
      'invalid_dto',
    );
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zc#14] getItem 用 itemIds 传 item_id，一次一个，sceneId=1，不带 keyword', async () => {
  const { adapter, requests, transport } = wire(() => listing([row()]));
  const item = await adapter.getItem(itemRef, ctx);
  expect(item).toMatchObject({ platform: 'jd', item_id: wholeItemId, title });
  expect(requests).toHaveLength(1);
  expect(formFields(sent(transport)).method).toBe(method);
  expect(requests[0]).toMatchObject({ itemIds: [wholeItemId], sceneId: 1 });
  expect(requests[0]).not.toHaveProperty('keyword');
});

it('[AC-B1-04zc#15] getItem 也收 catalog 给的 { itemId } 引用（BR-PROD-05 的 ItemRef 字段）', async () => {
  const { adapter, requests } = wire(() => listing([row()]));
  const item = await adapter.getItem({ platform: 'jd', itemId: wholeItemId }, ctx);
  expect(item).toMatchObject({ platform: 'jd', item_id: wholeItemId });
  expect(requests[0]).toMatchObject({ itemIds: [wholeItemId], sceneId: 1 });
});

it.each<[string, () => UnionTransportResponse]>([
  ['内层 200 而 data 缺失', () => reply(success())],
  ['data 为空数组', () => listing([])],
])('[AC-B1-04zc#16] getItem %s → item_unavailable，不伪造 0 元商品', async (_name, answer) => {
  const { adapter } = wire(answer);
  await unionFailure(() => adapter.getItem(itemRef, ctx), 'item_unavailable');
});

it.each<[string, ItemRef]>([
  ['不是京东商品', { platform: 'pdd', item_id: wholeItemId }],
  ['没有商品标识', { platform: 'jd' }],
  ['空串', { platform: 'jd', item_id: '' }],
  ['空白', { platform: 'jd', item_id: '   ' }],
])('[AC-B1-04zc#17] getItem 引用%s → invalid_dto，不取凭据、不发请求', async (_name, ref) => {
  const { adapter, credentials, transport } = wire(() => listing([row()]));
  await unionFailure(() => adapter.getItem(ref, ctx), 'invalid_dto');
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it.each(
  skuRefs.flatMap(([field, ref]) =>
    skuAnswers.map(([name, answer]) => [field, name, ref, answer] as const),
  ),
)(
  '[AC-B1-04zc#18] sku 模式 getItem（引用字段 %s，上游 %s）→ item_unavailable，不用 sceneId=2、不传 skuIds',
  async (_field, _name, ref, answer) => {
    const { adapter, requests } = wire(answer, mode('sku'));
    await unionFailure(() => adapter.getItem(ref, ctx), 'item_unavailable');
    expect(requests.length).toBeLessThanOrEqual(1);
    for (const body of requests) {
      expect(body).toMatchObject({ sceneId: 1 });
      expect(body).not.toHaveProperty('skuIds');
    }
  },
);
