// B1-04zzu（D10-796 ② 甲）：联盟账号与另一家共用，大淘客维权接口返回两边全部维权单。注入「自家淘宝订单查询」时，
// 维权请求的归档只存 tb_trade_id 可读且是凑狸已入库淘宝订单的行，以及 tb_trade_id 读不出的行；外层字段与
// JSON 数字原文不变；一整页全不是凑狸订单时 result 为空数组。listRefunds 返回的条目照常全部给出（包括维权早于
// 订单入库的那一条，D10-796 接受）。走真实 createArchivingTransport + 淘宝适配器，报文全部合成。
import { expect, it } from 'vitest';
import {
  answer,
  expectArchivedAs,
  onlyArchiveOf,
  payloadText,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import { listed, num, refundOf } from '../taobao-refunds/kit.ts';
import {
  PLAIN,
  REFUND_PATH,
  expectAskedOnce,
  ownOrders,
  refundBody,
  refundSuit,
  suitIdOf,
  tradeIdOf,
  wireRefunds,
} from './kit.ts';

it('[AC-B1-04zzu#1] 混合页的维权归档只剩凑狸已入库订单的行（按上游顺序，同一订单的几笔维权都在）；别家行在 gunzip 后的报文里一个字也没有；listRefunds 的条目照常全部给出；查询按 ctx.appId 问一次、单号去重', async () => {
  const own = ownOrders([tradeIdOf(1), tradeIdOf(3)]);
  const rows = [
    refundOf(1),
    refundOf(50),
    refundOf(3),
    refundOf(51),
    refundSuit(1, 90),
    refundSuit(50, 91),
  ];
  const h = wireRefunds(() => answer(refundBody(rows)), { ownOrders: own.reader });

  const page = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(page.items.map((item) => item.refund_id)).toEqual(
    [1, 50, 3, 51, 90, 91].map((suit) => suitIdOf(suit)),
  );
  expect(page.items.map((item) => item.order_id)).toEqual(
    [1, 50, 3, 51, 1, 50].map((index) => tradeIdOf(index)),
  );
  expect(page.nextCursor).toBeNull();
  expect(h.database.inserted, 'one archive row for the one upstream page').toHaveLength(1);
  const row = onlyArchiveOf(h.database, REFUND_PATH);
  expect(row.values['kind']).toBe('order');
  expect(row.values['error_code']).toBeNull();
  const text = expectArchivedAs(row, refundBody([refundOf(1), refundOf(3), refundSuit(1, 90)]));
  for (const index of [50, 51]) {
    expect(text, `refund of order ${index} (not ours) is not archived`).not.toContain(
      tradeIdOf(index),
    );
  }
  for (const suit of [50, 51, 91]) expect(text).not.toContain(suitIdOf(suit));
  expectAskedOnce(
    own.reader,
    [1, 50, 3, 51].map((index) => tradeIdOf(index)),
  );
  expect(h.database.unexpected).toEqual([]);
});

it('[AC-B1-04zzu#2] 读不出 tb_trade_id 的行（缺失、JSON null、空串、布尔、对象、整行不是对象）照样在维权归档里，不当别家行删，也不拿去查询', async () => {
  const own = ownOrders([tradeIdOf(1)]);
  const unreadable = [
    { ...refundOf(2), tb_trade_id: undefined },
    { ...refundOf(3), tb_trade_id: null },
    { ...refundOf(4), tb_trade_id: '' },
    { ...refundOf(5), tb_trade_id: true },
    { ...refundOf(6), tb_trade_id: { synthetic: tradeIdOf(56) } },
  ];
  const notObjects = ['synthetic-refund-row-as-text', num(tradeIdOf(8)), null, [refundOf(9)]];
  const rows = [
    refundOf(1),
    unreadable[0],
    refundOf(50),
    unreadable[1],
    notObjects[0],
    unreadable[2],
    notObjects[1],
    refundOf(51),
    unreadable[3],
    notObjects[2],
    unreadable[4],
    notObjects[3],
  ];
  const kept = rows.filter((_row, index) => index !== 2 && index !== 7);
  const h = wireRefunds(() => answer(refundBody(rows)), { ownOrders: own.reader });

  const page = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(page.items.map((item) => item.refund_id)).toEqual(
    [1, 50, 51].map((suit) => suitIdOf(suit)),
  );
  expect(kept).toHaveLength(rows.length - 2);
  const text = expectArchivedAs(onlyArchiveOf(h.database, REFUND_PATH), refundBody(kept));
  for (const index of [50, 51]) expect(text).not.toContain(tradeIdOf(index));
  for (const suit of [2, 3, 4, 5, 6]) expect(text).toContain(suitIdOf(suit));
  for (const index of [8, 9, 56]) expect(text).toContain(tradeIdOf(index));
  expectAskedOnce(
    own.reader,
    [1, 50, 51].map((index) => tradeIdOf(index)),
  );
});

it('[AC-B1-04zzu#3] 外层字段与 JSON 数字原文原样：顶层其余键、has_next / position_index / page_no 等、data 下其余键都在；tb_trade_id 是 JSON 整数时按十进制原文查询与判定，长整型与小数原文不失真', async () => {
  const mineId = '2900000000000001123';
  const otherId = '2900000000000001150';
  const own = ownOrders([mineId, tradeIdOf(2)]);
  const mine = {
    ...refundOf(1),
    tb_trade_id: num(mineId),
    synthetic_rate: num('0.29999999999999999'),
    synthetic_tiny: num('1E-7'),
  };
  const other = {
    ...refundOf(70),
    tb_trade_id: num(otherId),
    synthetic_rate: num('0.10000000000000001'),
  };
  const options = {
    hasNext: true,
    position: 'synthetic-refund-position-0003',
    top: {
      request_id: 'synthetic-refund-archive-request-0003',
      cache: false,
      server_time: num('1793433600123'),
    },
    data: {
      synthetic_flag: true,
      synthetic_total: num('9007199254740993'),
      synthetic_note: '合成外层字段',
    },
  };
  const rows = [other, mine, refundOf(71), refundOf(2)];
  const h = wireRefunds(() => answer(refundBody(rows, options)), { ownOrders: own.reader });

  const page = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(page.items.map((item) => item.order_id)).toEqual([
    otherId,
    mineId,
    tradeIdOf(71),
    tradeIdOf(2),
  ]);
  expect(page.nextCursor, 'has_next with a new position: another page follows').toBeTypeOf(
    'string',
  );
  const text = expectArchivedAs(
    onlyArchiveOf(h.database, REFUND_PATH),
    refundBody([mine, refundOf(2)], options),
  );
  for (const literal of [
    '0.29999999999999999',
    mineId,
    '9007199254740993',
    '1793433600123',
    '1E-7',
    'synthetic-refund-position-0003',
  ]) {
    expect(text, `literal ${literal} kept as written`).toContain(literal);
  }
  expect(text).not.toContain('0.10000000000000001');
  expect(text).not.toContain(otherId);
  expect(text).not.toContain(tradeIdOf(71));
  expectAskedOnce(own.reader, [otherId, mineId, tradeIdOf(71), tradeIdOf(2)]);
});

it('[AC-B1-04zzu#4] 一整页全不是凑狸订单：维权归档里 result 为空数组，其余字段保留；listRefunds 照常给出全部条目，nextCursor 与不注入查询时相同', async () => {
  const rows = [refundOf(50), refundOf(51), refundSuit(50, 52)];
  const options = {
    hasNext: true,
    position: 'synthetic-refund-position-0004',
    top: { request_id: 'synthetic-refund-archive-request-0004' },
    data: { synthetic_note: '整页别家' },
  };
  const body = refundBody(rows, options);
  const own = ownOrders([tradeIdOf(1)]);
  const h = wireRefunds(() => answer(body), { ownOrders: own.reader });
  const plain = wire(() => answer(body));

  const page = await listed(h.adapter.listRefunds(win, PLAIN));
  const before = await listed(plain.adapter.listRefunds(win, PLAIN));

  expect(page.items.map((item) => item.refund_id)).toEqual(
    [50, 51, 52].map((suit) => suitIdOf(suit)),
  );
  expect(page.nextCursor).toBeTypeOf('string');
  expect(page.nextCursor).toBe(before.nextCursor);
  const text = expectArchivedAs(onlyArchiveOf(h.database, REFUND_PATH), refundBody([], options));
  expect(text).toContain('"result"');
  for (const index of [50, 51]) expect(text).not.toContain(tradeIdOf(index));
  for (const suit of [50, 51, 52]) expect(text).not.toContain(suitIdOf(suit));
  expectAskedOnce(own.reader, [tradeIdOf(50), tradeIdOf(51)]);
});

it('[AC-B1-04zzu#5] 维权早于订单入库（查询里还没有）：这一条原文不入档，但 listRefunds 返回的条目照常包含它；订单入库后再取同一页，归档就留下它（D10-796）', async () => {
  const own = ownOrders([tradeIdOf(1)]);
  const rows = [refundOf(1), refundOf(2)];
  const h = wireRefunds(() => answer(refundBody(rows)), { ownOrders: own.reader });

  const early = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(early.items.map((item) => [item.order_id, item.refund_id])).toEqual([
    [tradeIdOf(1), suitIdOf(1)],
    [tradeIdOf(2), suitIdOf(2)],
  ]);
  expect(h.database.inserted).toHaveLength(1);
  const first = expectArchivedAs(h.database.inserted[0]!, refundBody([refundOf(1)]));
  expect(first).not.toContain(tradeIdOf(2));
  expect(first).not.toContain(suitIdOf(2));

  // The order sync has stored order 2 since: the same page now archives both refunds.
  own.stored.add(tradeIdOf(2));
  const later = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(later.items).toEqual(early.items);
  expect(h.database.inserted).toHaveLength(2);
  expect(payloadText(h.database.inserted[1]!)).toBe(refundBody(rows));
  expect(own.reader).toHaveBeenCalledTimes(2);
});
