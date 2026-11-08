// B1-04zgb（FU-TB-ARCHIVE-EDGE ①）维权：注入自家订单查询时，get-order-refund 正文同一对象里出现重复键，维权
// 请求的归档存的是按 JSON.parse 语义（后出现者胜）重新序列化、再按自家订单查询删非凑狸行的报文——被覆盖那一份的
// 单号、维权单号与其它内容都不在 gunzip 后的 payload 里（哪怕那一行是凑狸订单），也没有重复键；数字原文、外层
// 字段、读不出 tb_trade_id 的行照旧。listRefunds 的条目与告警和「只含后出现那一份」的正常报文一样。装配照
// taobao-refund-archive/kit.ts 的 wireRefunds（真实 createArchivingTransport + 淘宝适配器），报文全部手写合成。
import { expect, it } from 'vitest';
import {
  answer,
  expectArchivedAs,
  onlyArchiveOf,
  payloadText,
  win,
} from '../taobao-order-archive/kit.ts';
import { listed, num, refundOf } from '../taobao-refunds/kit.ts';
import {
  PLAIN,
  REFUND_PATH,
  ownOrders,
  refundBody,
  suitIdOf,
  tradeIdOf,
  wireRefunds,
} from '../taobao-refund-archive/kit.ts';
import {
  afterSalesEnvelope,
  afterSalesRowWith,
  afterSalesTexts,
  array,
  duplicateKeys,
  expectNoDuplicateKeys,
  expectNoneOf,
  member,
  refundDataText,
  str,
} from './kit.ts';

/** listRefunds on a body without duplicate keys, with the same stored orders. */
async function plainRun(body: string, owned: readonly string[]) {
  const own = ownOrders(owned);
  const c = wireRefunds(() => answer(body), { ownOrders: own.reader });
  const page = await listed(c.adapter.listRefunds(win, PLAIN));
  return { c, page };
}

it('[AC-B1-04zgb#9] 维权：data 里 result 键出现两次（前一份有别家维权与一笔凑狸订单的维权，后一份只有凑狸订单的维权）：归档是后一份按解析语义重写的报文，前一份的单号与维权单号一个字也没有，也没有重复键；对照：没有重复键的同页报文逐字节原样存，listRefunds 条目与告警两者一样', async () => {
  const owned = [tradeIdOf(1), tradeIdOf(3), tradeIdOf(9)];
  const own = ownOrders(owned);
  const kept = [refundOf(1), refundOf(3)];
  const keptRows = afterSalesTexts(kept);
  const body = afterSalesEnvelope(
    member(
      'data',
      refundDataText(
        member('result', array(...afterSalesTexts([refundOf(50), refundOf(9)]))),
        member('result', array(...keptRows)),
      ),
    ),
  );
  const normal = afterSalesEnvelope(
    member('data', refundDataText(member('result', array(...keptRows)))),
  );
  expect(duplicateKeys(body), 'the fixture repeats result').toEqual(['result']);
  const h = wireRefunds(() => answer(body), { ownOrders: own.reader });

  const page = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(page.items.map((item) => item.refund_id)).toEqual([suitIdOf(1), suitIdOf(3)]);
  expect(page.nextCursor).toBeNull();
  expect(own.reader, 'one own-order lookup for the one refund page').toHaveBeenCalledTimes(1);
  expect(h.database.inserted, 'one archive row for the one upstream page').toHaveLength(1);
  const row = onlyArchiveOf(h.database, REFUND_PATH);
  expect(row.values['error_code']).toBeNull();
  const text = expectArchivedAs(row, refundBody(kept));
  expectNoneOf(text, [tradeIdOf(50), suitIdOf(50), tradeIdOf(9), suitIdOf(9)]);
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(normal, owned);
  expect(payloadText(onlyArchiveOf(c.database, REFUND_PATH)), 'no duplicate key: as received').toBe(
    normal,
  );
  expect(page).toEqual(plainPage);
  expect(h.refundWarn.mock.calls).toEqual(c.refundWarn.mock.calls);
});

it('[AC-B1-04zgb#10] 维权：行内重复键（别家维权后面再写一遍凑狸订单的 tb_trade_id 与 refund_suit_id、同名备注写两遍、读不出 tb_trade_id 的行里 refund_suit_id 写两遍）：归档里每行只有后出现的值，被覆盖的单号、维权单号与备注都不在，也没有重复键；读不出 tb_trade_id 的行照样在', async () => {
  const owned = [tradeIdOf(1), tradeIdOf(2), tradeIdOf(4)];
  const own = ownOrders(owned);
  const second = afterSalesRowWith(
    refundOf(50),
    member('tb_trade_id', str(tradeIdOf(2))),
    member('refund_suit_id', str(suitIdOf(2))),
  );
  const fourth = afterSalesRowWith(
    { ...refundOf(4), synthetic_note: '被覆盖-0004' },
    member('synthetic_note', str('保留-0004')),
  );
  const fifth = afterSalesRowWith(
    { ...refundOf(5), tb_trade_id: null, refund_suit_id: suitIdOf(55) },
    member('refund_suit_id', str(suitIdOf(5))),
  );
  const expected = [
    refundOf(1),
    refundOf(2),
    { ...refundOf(4), synthetic_note: '保留-0004' },
    { ...refundOf(5), tb_trade_id: null },
  ];
  const body = afterSalesEnvelope(
    member(
      'data',
      refundDataText(
        member('result', array(...afterSalesTexts([refundOf(1)]), second, fourth, fifth)),
      ),
    ),
  );
  expect(duplicateKeys(body), 'the fixture repeats members inside rows').toEqual([
    'tb_trade_id',
    'refund_suit_id',
    'synthetic_note',
    'refund_suit_id',
  ]);
  const h = wireRefunds(() => answer(body), { ownOrders: own.reader });

  const page = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(page.items.map((item) => item.order_id)).toEqual([
    tradeIdOf(1),
    tradeIdOf(2),
    tradeIdOf(4),
  ]);
  const text = expectArchivedAs(onlyArchiveOf(h.database, REFUND_PATH), refundBody(expected));
  expectNoneOf(text, [tradeIdOf(50), suitIdOf(50), '被覆盖-0004', suitIdOf(55)]);
  expect(text, 'the row whose tb_trade_id cannot be read stays').toContain(suitIdOf(5));
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(refundBody(expected), owned);
  expect(page).toEqual(plainPage);
  expect(h.refundWarn.mock.calls).toEqual(c.refundWarn.mock.calls);
});

it('[AC-B1-04zgb#11] 维权：顶层 data 与 server_time 各出现两次（前一份 data 全是别家维权）：归档只有后出现的值，别家单号与维权单号、被覆盖的 data 成员与时间戳都不在，也没有重复键；数字原文（JSON 整数单号、0.29999999999999999、1E-7、超 2^53 的整数）保真，外层字段保留', async () => {
  const mineId = '2900000000000001123';
  const owned = [mineId, tradeIdOf(2)];
  const own = ownOrders(owned);
  const mine = {
    ...refundOf(1),
    tb_trade_id: num(mineId),
    synthetic_rate: num('0.29999999999999999'),
    synthetic_tiny: num('1E-7'),
  };
  const kept = [mine, refundOf(2)];
  const body = afterSalesEnvelope(
    member('server_time', '1793433600999'),
    member(
      'data',
      refundDataText(
        member('result', array(...afterSalesTexts([refundOf(50), refundOf(51)]))),
        member('synthetic_note', str('被覆盖的 data')),
      ),
    ),
    member(
      'data',
      refundDataText(
        member('result', array(...afterSalesTexts(kept))),
        member('synthetic_total', '9007199254740993'),
      ),
    ),
    member('server_time', '1793433600123'),
  );
  const expected = refundBody(kept, {
    top: { server_time: num('1793433600123') },
    data: { synthetic_total: num('9007199254740993') },
  });
  expect(duplicateKeys(body), 'the fixture repeats data and server_time').toEqual([
    'data',
    'server_time',
  ]);
  const h = wireRefunds(() => answer(body), { ownOrders: own.reader });

  const page = await listed(h.adapter.listRefunds(win, PLAIN));

  expect(page.items.map((item) => item.order_id)).toEqual([mineId, tradeIdOf(2)]);
  const text = expectArchivedAs(onlyArchiveOf(h.database, REFUND_PATH), expected);
  for (const literal of [
    mineId,
    '0.29999999999999999',
    '1E-7',
    '9007199254740993',
    '1793433600123',
  ]) {
    expect(text, `literal ${literal} kept as written`).toContain(literal);
  }
  expectNoneOf(text, [
    tradeIdOf(50),
    tradeIdOf(51),
    suitIdOf(50),
    suitIdOf(51),
    '被覆盖的 data',
    '1793433600999',
  ]);
  expectNoDuplicateKeys(text);

  const { c, page: plainPage } = await plainRun(expected, owned);
  expect(page).toEqual(plainPage);
  expect(h.refundWarn.mock.calls).toEqual(c.refundWarn.mock.calls);
});
