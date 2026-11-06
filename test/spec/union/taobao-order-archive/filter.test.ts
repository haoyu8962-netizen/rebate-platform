// B1-04zzc（D10-776 方案 A；规划变更 20261031-淘宝订单经大淘客 §3「同步时按凑狸的推广位过滤，不入库别家
// 订单」）：联盟账号与另一家共用，大淘客订单详情接口返回两边全部订单。订单详情请求的归档只存去掉别家行的
// 报文：推广位可读且不在凑狸推广位清单的行不进 payload；自家行（在用与已停用）、读不出推广位的坏行照样在；
// 外层字段与 JSON 数字原文不变。走真实 createArchivingTransport + 淘宝适配器，报文全部合成。
import { expect, it } from 'vitest';
import {
  COLLECT,
  FOREIGN_ADZONE,
  MODES,
  ORDER_PATH,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  PLAIN,
  RETIRED_ADZONE,
  answer,
  expectArchivedAs,
  foreign,
  foreignCounts,
  idOf,
  num,
  onlyArchiveOf,
  orderBody,
  ours,
  resolvedPage,
  win,
  wire,
} from './kit.ts';

it.each(MODES)(
  '[AC-B1-04zzc#1] $mode：混合页的归档只剩自家推广位（在用与已停用）的行、按上游顺序；别家行（adzone_id 是 JSON 整数或十进制串）在 gunzip 后的报文里一个字也没有',
  async ({ call }) => {
    const rows = [
      ours(1),
      foreign(50),
      ours(2, RETIRED_ADZONE),
      foreign(51, OTHER_FOREIGN_ADZONE, true),
      ours(3),
      foreign(52),
    ];
    const h = wire(() => answer(orderBody(rows)));

    const page = await resolvedPage(() => h.adapter.listOrders(win, {}, call));

    expect(page.items.map((order) => order.order_id)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(h.database.inserted, 'one archive row for the one upstream page').toHaveLength(1);
    const row = onlyArchiveOf(h.database, ORDER_PATH);
    expect(row.values['kind']).toBe('order');
    const text = expectArchivedAs(row, orderBody([ours(1), ours(2, RETIRED_ADZONE), ours(3)]));
    for (const index of [50, 51, 52]) {
      expect(text, `foreign row ${index} is not archived`).not.toContain(idOf(index));
    }
    expect(h.database.unexpected).toEqual([]);
  },
);

it('[AC-B1-04zzc#2] 读不出推广位的坏行（缺 adzone_id、非法值、JSON null、整行不是对象）照样在归档里，不当别家行删', async () => {
  const bad = [
    ours(2, OUR_ADZONE, { adzone_id: undefined }),
    ours(3, OUR_ADZONE, { adzone_id: 'synthetic-slot' }),
    ours(4, OUR_ADZONE, { adzone_id: num('0') }),
    ours(5, OUR_ADZONE, { adzone_id: num(`-${FOREIGN_ADZONE}`) }),
    ours(6, OUR_ADZONE, { adzone_id: num(`${FOREIGN_ADZONE}.5`) }),
    ours(7, OUR_ADZONE, { adzone_id: null }),
    ours(8, OUR_ADZONE, { adzone_id: '' }),
  ];
  const notObjects = ['synthetic-row-as-text', num('2900000000000001999'), null, [foreign(60)]];
  const rows = [
    ours(1),
    bad[0],
    foreign(50),
    bad[1],
    bad[2],
    notObjects[0],
    bad[3],
    bad[4],
    notObjects[1],
    foreign(51, FOREIGN_ADZONE, true),
    bad[5],
    notObjects[2],
    bad[6],
    notObjects[3],
  ];
  const kept = rows.filter((_row, index) => index !== 2 && index !== 9);
  const h = wire(() => answer(orderBody(rows)));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, COLLECT));

  expect(page.items.map((order) => order.order_id)).toEqual([idOf(1)]);
  expect(kept).toHaveLength(rows.length - 2);
  const text = expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody(kept));
  for (const index of [50, 51]) expect(text).not.toContain(idOf(index));
  for (const index of [2, 3, 4, 5, 6, 7, 8]) expect(text).toContain(idOf(index));
});

it('[AC-B1-04zzc#3] 外层字段与 JSON 数字原文原样：顶层其余键、has_next、position_index、data 下其余键都在；小数与长整型数字的原文不失真', async () => {
  const mine = ours(1, OUR_ADZONE, {
    trade_parent_id: num('2900000000000000123'),
    income: num('0.29999999999999999'),
    price_by_one: num('7.10'),
    income_by_one: num('1E-7'),
  });
  const retired = ours(2, RETIRED_ADZONE, { item_num: num('12'), day: '2026-10-30' });
  const options = {
    hasNext: true,
    position: 'arc-position-0001_SYN|arc-position-0002_SYN',
    top: {
      request_id: 'synthetic-archive-request-0003',
      cache: false,
      server_time: num('1793600000123'),
    },
    data: {
      has_pre: true,
      total_results: num('9007199254740993'),
      synthetic_note: '合成外层字段',
    },
  };
  const rows = [
    foreign(50, FOREIGN_ADZONE),
    mine,
    { ...foreign(51, OTHER_FOREIGN_ADZONE), income: num('0.10000000000000001') },
    retired,
  ];
  const h = wire(() => answer(orderBody(rows, options)));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, PLAIN));

  expect(page.nextCursor).toBeTypeOf('string');
  const text = expectArchivedAs(
    onlyArchiveOf(h.database, ORDER_PATH),
    orderBody([mine, retired], options),
  );
  for (const literal of [
    '0.29999999999999999',
    '2900000000000000123',
    '9007199254740993',
    '1793600000123',
    '1E-7',
  ]) {
    expect(text, `literal ${literal} kept as written`).toContain(literal);
  }
  expect(text).not.toContain('0.10000000000000001');
});

it('[AC-B1-04zzc#4] 一整页全是别家行：归档里 rows 为空数组，其余字段保留；listOrders 照常给空页，别家计数仍是这一页一条', async () => {
  const rows = [foreign(50), foreign(51, OTHER_FOREIGN_ADZONE), foreign(52, FOREIGN_ADZONE, true)];
  const options = {
    top: { request_id: 'synthetic-archive-request-0004' },
    data: { synthetic_note: '整页别家' },
  };
  const h = wire(() => answer(orderBody(rows, options)));

  const page = await resolvedPage(() => h.adapter.listOrders(win, {}, COLLECT));

  expect(page.items).toEqual([]);
  expect(page.rejected ?? []).toEqual([]);
  expect(page.nextCursor).toBeNull();
  const text = expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody([], options));
  expect(text).toContain('publisher_order_dto');
  for (const index of [50, 51, 52]) expect(text).not.toContain(idOf(index));
  expect(foreignCounts(h)).toEqual([3]);
});
