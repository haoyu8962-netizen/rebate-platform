import { deriveProductKey } from '@couli/domain';
import { expect, it } from 'vitest';
import {
  businessFields,
  convertToDetail,
  ctx,
  DETAIL,
  detailIdLists,
  detailItemId,
  endpoint,
  formOf,
  identities,
  one,
  orderItemId,
  requestsOf,
  rowsFrom,
  search,
  searchBody,
  searchItemId,
  searchNumber,
  searchRow,
  searchRows,
  setup,
  sharedTail,
  skipReasons,
  topBody,
  topError,
  topRow,
  visible,
  type Row,
} from './official-harness.ts';

// 商品 ID（D10-504、D10-582）：搜索 item_id 与详情口径整串不同、最后一段相同，经 item.info.upgrade.get 换成
// 详情口径再返回，按最后一段匹配，不按位置；一页一次批量；换不到的不返回，不用搜索 ID 兜底；缓存命中不再调。

const TAOBAO = { platform: 'taobao', keyPrefix: 'tb' } as const;

function rows(...numbers: number[]): Row[] {
  return numbers.map((n) => searchRow(n));
}

function withoutNumbers(...gone: number[]) {
  return (id: string) => {
    const n = searchNumber(id);
    return n !== undefined && gone.includes(n) ? undefined : convertToDetail(id);
  };
}

it('[AC-B1-04zx#24] item_id = 详情口径 ID（按搜索顺序）；一次换算：item_id 逗号连接、biz_scene_id 1，POST 淘宝网关，归档 kind = query', async () => {
  const { h, page } = await searchRows(rows(5, 2, 9));
  expect(page.items.map((item) => item.item_id)).toEqual([
    detailItemId(5),
    detailItemId(2),
    detailItemId(9),
  ]);
  expect(page.items.every((item) => item.platform === 'taobao')).toBe(true);
  const requests = requestsOf(h, DETAIL);
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe('POST');
  expect(request.url).toBe(endpoint.baseUrl);
  expect(formOf(request)['method']).toBe(DETAIL);
  expect(businessFields(request)).toEqual({
    item_id: [searchItemId(5), searchItemId(2), searchItemId(9)].join(','),
    biz_scene_id: '1',
  });
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'query' });
});

it('[AC-B1-04zx#25] 整页 20 条：一页只调一次换算，一批带全部 20 个搜索 ID', async () => {
  const numbers = Array.from({ length: 20 }, (_unused, i) => i + 1);
  const { h, page } = await searchRows(rows(...numbers));
  expect(identities(page)).toEqual(numbers);
  expect(detailIdLists(h)).toEqual([numbers.map(searchItemId)]);
});

it('[AC-B1-04zx#26] 搜索 ID 不出现在结果任何字段里（序列化与打印都看不到），也不带 goods_id / goods_sign / itemId / skuId', async () => {
  const { page } = await searchRows(rows(1, 2, 3));
  expect(page.items).toHaveLength(3);
  const shown = visible(page);
  expect(shown).not.toContain('SrchFront');
  for (const n of [1, 2, 3]) expect(shown).not.toContain(searchItemId(n));
  for (const item of page.items) {
    for (const key of ['goods_id', 'goods_sign', 'itemId', 'skuId']) {
      expect(Object.hasOwn(item, key), key).toBe(false);
    }
  }
});

it('[AC-B1-04zx#27] 换不到的条目不返回、不用搜索 ID 兜底；其余条目 ID 与商品一一对应', async () => {
  const { page } = await searchRows(rows(1, 2, 3), { available: withoutNumbers(2) });
  expect(identities(page)).toEqual([1, 3]);
  expect(visible(page)).not.toContain('SrchFront');
});

it.each([
  ['15 / 50001', topError(15, 50001)],
  ['results 为空', topBody([])],
] as [string, Row][])(
  '[AC-B1-04zx#28] 整批换不到（%s）→ 本页无条目、不报错、不算非法；满页时 nextCursor 照给',
  async (_label, reply) => {
    const h = setup({ page: () => searchBody(rowsFrom(1, 20), 165), detailReply: () => reply });
    const page = await search(h);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe('taobao-search:2');
  },
);

it('[AC-B1-04zx#29] 返回条数与请求相等但某条 item_id 缺失 / 空白：只丢这一条', async () => {
  const detailReply = (ids: readonly string[]) =>
    topBody(
      ids.map((id, i) => {
        const row = topRow(convertToDetail(id) ?? 'unexpected');
        if (i === 1) row['item_id'] = '   ';
        if (i === 3) delete row['item_id'];
        return row;
      }),
    );
  const { page } = await searchRows(rows(11, 12, 13, 14, 15), { detailReply });
  expect(identities(page)).toEqual([11, 13, 15]);
});

it('[AC-B1-04zx#30] 换算条数少于请求（第 1、3 个已下架）：换到的照常返回，不把 ID 安到别的商品上', async () => {
  const { h, page } = await searchRows(rows(21, 22, 23, 24), {
    available: withoutNumbers(21, 23),
  });
  expect(detailIdLists(h)[0]).toEqual([21, 22, 23, 24].map(searchItemId));
  expect(identities(page)).toEqual([22, 24]);
});

it('[AC-B1-04zx#59] 换算响应同条数乱序：按最后一段匹配，每个商品拿到自己的详情 ID，结果保持搜索顺序', async () => {
  const detailReply = (ids: readonly string[]) =>
    topBody([...ids].reverse().map((id) => topRow(convertToDetail(id) ?? 'unexpected')));
  const { h, page } = await searchRows(rows(31, 32, 33, 34), { detailReply });
  expect(identities(page)).toEqual([31, 32, 33, 34]);
  expect(detailIdLists(h)).toHaveLength(1);
});

it('[AC-B1-04zx#60] 换算响应少条且乱序：换到的各得其所，同一批不再逐个重查', async () => {
  const detailReply = (ids: readonly string[]) =>
    topBody(
      [...ids]
        .reverse()
        .filter((id) => searchNumber(id) !== 42)
        .map((id) => topRow(convertToDetail(id) ?? 'unexpected')),
    );
  const { h, page } = await searchRows(rows(41, 42, 43), { detailReply });
  expect(identities(page)).toEqual([41, 43]);
  expect(detailIdLists(h)).toHaveLength(1);
});

it('[AC-B1-04zx#61] 换算响应里最后一段对不上的条目不返回、不写缓存，也不按位置安到别的商品上', async () => {
  const stranger = detailItemId(9999);
  let honest = false;
  const detailReply = (ids: readonly string[]) =>
    topBody(
      ids.map((id) =>
        !honest && searchNumber(id) === 52
          ? topRow(stranger)
          : topRow(convertToDetail(id) ?? 'unexpected'),
      ),
    );
  const h = setup({ page: () => searchBody(rows(51, 52, 53), 3), detailReply });
  const first = await search(h);
  expect(identities(first)).toEqual([51, 53]);
  expect(visible(first)).not.toContain(stranger);
  expect(skipReasons(h)).toEqual(['item_unconverted']);

  honest = true;
  const second = await search(h);
  expect(identities(second)).toEqual([51, 52, 53]);
  expect(detailIdLists(h).at(-1)).toEqual([searchItemId(52)]);
});

it('[AC-B1-04zx#62] 换不到是跳行：发 taobao_search_row_skipped（reason item_unconverted），不走权限告警 warn，不含取值', async () => {
  const { h, page } = await searchRows(rows(61, 62, 63), { available: withoutNumbers(62) });
  expect(identities(page)).toEqual([61, 63]);
  expect(skipReasons(h)).toEqual(['item_unconverted']);
  expect(h.warn).not.toHaveBeenCalled();
  expect(visible(h.searchWarn.mock.calls)).not.toContain('SharedTail');
});

it.each([
  ['缺失', undefined],
  ['空串', ''],
  ['空白', '   '],
  ['含逗号', `${searchItemId(2)},${searchItemId(9)}`],
  ['数字', 12345],
])('[AC-B1-04zx#31] item_id %s 的行不进换算请求、不返回；其余条目照常', async (_label, itemId) => {
  const bad = searchRow(2, { top: { item_id: itemId } });
  const { h, page } = await searchRows([searchRow(1), bad, searchRow(3)]);
  expect(identities(page)).toEqual([1, 3]);
  expect(detailIdLists(h).flat().sort()).toEqual([searchItemId(1), searchItemId(3)].sort());
  expect(skipReasons(h)).toEqual(['item_unconverted']);
});

it('[AC-B1-04zx#32] 缓存命中不再调换算：同一适配器再次搜到同样商品，只调搜索，ID 不变', async () => {
  const h = setup({ page: () => searchBody(rows(1, 2, 3), 3) });
  const first = await search(h);
  expect(identities(first)).toEqual([1, 2, 3]);
  expect(detailIdLists(h)).toHaveLength(1);

  h.clock.advanceMs(60_000);
  const second = await search(h);
  expect(second.items.map((item) => item.item_id)).toEqual(first.items.map((item) => item.item_id));
  expect(detailIdLists(h)).toHaveLength(1);
});

it('[AC-B1-04zx#33] 部分命中：只把未缓存的搜索 ID 送去换算', async () => {
  let round = 0;
  const h = setup({
    page: () => (round === 0 ? searchBody(rows(1, 2), 2) : searchBody(rows(2, 3, 1), 3)),
  });
  await search(h);
  round = 1;
  const page = await search(h);
  expect(identities(page)).toEqual([2, 3, 1]);
  expect(detailIdLists(h)[1]).toEqual([searchItemId(3)]);
});

it('[AC-B1-04zx#34] 换不到不写缓存：先不返回，之后能换到时重新请求并返回', async () => {
  let open = false;
  const h = setup({
    page: () => searchBody(rows(7), 1),
    available: (id) => (open ? convertToDetail(id) : undefined),
  });
  const first = await search(h);
  expect(first.items).toEqual([]);
  open = true;
  const second = await search(h);
  expect(identities(second)).toEqual([7]);
  expect(detailIdLists(h).at(-1)).toEqual([searchItemId(7)]);
});

it('[AC-B1-04zx#35] product_key：同一商品，搜索换算后的 ID 与订单 item_id（整串不同、最后一段相同）经 deriveProductKey 派生出同一个键', async () => {
  const item = await one(searchRow(7));
  expect(item.item_id).toBe(detailItemId(7));
  expect(item.item_id).not.toBe(orderItemId(7));
  const fromSearch = deriveProductKey(TAOBAO, item);
  expect(fromSearch).toBe(deriveProductKey(TAOBAO, { item_id: orderItemId(7) }));
  expect(fromSearch).toBe(`tb:${sharedTail(7)}`);
});
