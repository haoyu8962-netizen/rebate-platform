// B1-04zzu（D10-796 ② 甲）：只改维权请求的归档。
// - 没有可删的行（全是凑狸订单 / 只剩读不出单号的行 / 空页），或 data.result 不是数组时，归档逐字节就是收到的
//   原文、error_code 为空；同一适配器接着取的混合页，归档已去掉别家行。
// - listRefunds 返回的条目、nextCursor、维权告警与不注入查询时完全相同；不注入查询时维权归档仍是原文
//   （冻结的 [AC-B1-04zzc#11] 即此情形，不改它）。
// - 同一适配器上订单详情、违规、搜索、转链的归档不变，也不去问自家订单查询。报文全部合成。
import { expect, it } from 'vitest';
import { DATAOKE_SEARCH_PATH } from '../../../../apps/api/src/modules/union/infra/taobao/dataoke-search.ts';
import {
  PRIVILEGE_PATH,
  ctx as convertCtx,
  identity,
  privilegeData,
  req,
} from '../taobao-convert/kit.ts';
import {
  COLLECT,
  DECOY,
  ORDER_PATH,
  PUNISH_PATH,
  answer,
  expectArchivedAs,
  foreign,
  onlyArchiveOf,
  orderBody,
  ours,
  payloadText,
  regardless,
  resolvedPage,
  win,
  wire,
} from '../taobao-order-archive/kit.ts';
import { punishBody } from '../taobao-punish-archive/kit.ts';
import {
  FOREIGN_ADZONE,
  jsonText,
  listed,
  num,
  punishOf,
  refundOf,
} from '../taobao-refunds/kit.ts';
import {
  PLAIN,
  REFUND_PATH,
  expectAskedOnce,
  ownOrders,
  refundBody,
  suitIdOf,
  tradeIdOf,
  wireRefunds,
} from './kit.ts';

const MIXED = [refundOf(11), refundOf(60)];

const CASES: readonly { readonly label: string; readonly body: string }[] = [
  {
    label: '全是凑狸订单的行，报文带多余空白',
    body: refundBody([refundOf(1), refundOf(2)]).replace(/,"/g, ', "'),
  },
  {
    label: '只有凑狸订单的行与读不出单号的行',
    body: refundBody([
      refundOf(1),
      { ...refundOf(3), tb_trade_id: undefined },
      { ...refundOf(4), tb_trade_id: null },
      'synthetic-refund-row-as-text',
    ]),
  },
  { label: '空页', body: refundBody([]) },
  { label: 'data.result 缺失', body: refundBody([], { data: { result: undefined } }) },
  { label: 'data.result 是 null', body: refundBody([], { data: { result: null } }) },
  {
    label: 'data.result 是对象（里面夹着别家的维权行）',
    body: refundBody([], { data: { result: { list: [refundOf(61)] } } }),
  },
  {
    label: 'data 不是对象（数组里夹着别家的维权行）',
    body: jsonText({
      time: num('1793433600000'),
      code: num('0'),
      msg: '成功',
      data: [refundOf(62)],
    }),
  },
];

it.each(CASES)(
  '[AC-B1-04zzu#6] $label：维权归档逐字节就是收到的原文、error_code 为空；同一适配器接着取的混合页归档已去掉别家行',
  async ({ body }) => {
    const own = ownOrders([tradeIdOf(1), tradeIdOf(2), tradeIdOf(11)]);
    let served = 0;
    const h = wireRefunds(
      () => {
        served += 1;
        return answer(served === 1 ? body : refundBody(MIXED));
      },
      { ownOrders: own.reader },
    );

    await regardless(() => h.adapter.listRefunds(win, PLAIN));
    const page = await listed(h.adapter.listRefunds(win, PLAIN));

    expect(h.upstream).toHaveBeenCalledTimes(2);
    expect(h.database.inserted, 'one archive row per upstream page').toHaveLength(2);
    const [first, second] = h.database.inserted;
    expect(payloadText(first!), 'nothing to drop: the body as received').toBe(body);
    expect(first!.values['error_code']).toBeNull();
    expect(page.items.map((item) => item.refund_id)).toEqual([suitIdOf(11), suitIdOf(60)]);
    const text = expectArchivedAs(second!, refundBody([refundOf(11)]));
    expect(text).not.toContain(tradeIdOf(60));
    expect(second!.values['error_code']).toBeNull();
  },
);

it('[AC-B1-04zzu#7] listRefunds 返回的条目、nextCursor、维权告警与不注入查询的适配器完全相同；不注入查询时维权归档仍是收到的原文，注入后同一页的归档只剩凑狸订单的行', async () => {
  const rows = [
    refundOf(1),
    refundOf(50),
    { ...refundOf(2), refund_suit_id: undefined },
    { ...refundOf(51), tk_subsidy_alimm_refund_fee: '1.30' },
    { ...refundOf(3), refund_status: num('99'), tk_refund_time: 'synthetic-not-a-time' },
    refundOf(52),
  ];
  const body = refundBody(rows, { hasNext: true, position: 'synthetic-refund-position-0007' });
  const own = ownOrders([tradeIdOf(1), tradeIdOf(2), tradeIdOf(3)]);
  const h = wireRefunds(() => answer(body), { ownOrders: own.reader });
  const plain = wire(() => answer(body));

  const page = await listed(h.adapter.listRefunds(win, PLAIN));
  const before = await listed(plain.adapter.listRefunds(win, PLAIN));

  expect(page.items).toEqual(before.items);
  expect(page.items.map((item) => item.refund_id)).toEqual(
    [1, 50, 3, 52].map((suit) => suitIdOf(suit)),
  );
  expect(page.nextCursor).toBeTypeOf('string');
  expect(page.nextCursor).toBe(before.nextCursor);
  expect(before.items.length).toBeGreaterThan(0);
  expect(plain.refundWarn.mock.calls.length, 'the page has bad rows').toBeGreaterThan(0);
  expect(h.refundWarn.mock.calls).toEqual(plain.refundWarn.mock.calls);

  expect(payloadText(onlyArchiveOf(plain.database, REFUND_PATH))).toBe(body);
  expectArchivedAs(
    onlyArchiveOf(h.database, REFUND_PATH),
    refundBody([rows[0], rows[2], rows[4]], {
      hasNext: true,
      position: 'synthetic-refund-position-0007',
    }),
  );
  expectAskedOnce(
    own.reader,
    [1, 50, 2, 51, 3, 52].map((index) => tradeIdOf(index)),
  );
});

it('[AC-B1-04zzu#8] 注入查询后，同一适配器上订单详情、违规的归档仍按推广位改写，搜索、转链的归档仍是收到的原文，它们都不问自家订单查询；只有维权的归档按查询结果去掉别家行', async () => {
  const searchBody = JSON.stringify({
    time: 1793600000000,
    code: 0,
    msg: '成功',
    data: { list: [], totalNum: 0, pageId: '1', results: { publisher_order_dto: [DECOY] } },
  });
  const convertBody = JSON.stringify({
    time: 1793600000000,
    code: 0,
    msg: 'ok',
    data: { ...privilegeData(), results: { publisher_order_dto: [DECOY] } },
  });
  const punishRows = [punishOf(1), punishOf(50, FOREIGN_ADZONE)];
  const refundRows = [refundOf(1), refundOf(50)];
  const bodies: Readonly<Record<string, string>> = {
    [ORDER_PATH]: orderBody([ours(1), foreign(50)]),
    [PUNISH_PATH]: punishBody(punishRows),
    [DATAOKE_SEARCH_PATH]: searchBody,
    [PRIVILEGE_PATH]: convertBody,
    [REFUND_PATH]: refundBody(refundRows),
  };
  const own = ownOrders([tradeIdOf(1)]);
  const h = wireRefunds(
    (call) => answer(bodies[call.path] ?? '{"code":-1,"msg":"synthetic unexpected path"}'),
    { ownOrders: own.reader },
  );

  await resolvedPage(() => h.adapter.listOrders(win, {}, COLLECT));
  await listed(h.adapter.listPunishments(win, PLAIN));
  await regardless(() =>
    h.adapter.searchItems({ keyword: '合成关键词' }, { ...PLAIN, purpose: 'online' }),
  );
  await regardless(() => h.adapter.convert(req, identity, convertCtx));

  expect(own.reader, 'only the refund archive asks for own orders').not.toHaveBeenCalled();
  expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody([ours(1)]));
  expectArchivedAs(
    onlyArchiveOf(h.database, PUNISH_PATH),
    punishBody([punishOf(1)], { total: punishRows.length }),
  );
  const search = onlyArchiveOf(h.database, DATAOKE_SEARCH_PATH);
  expect(search.values['kind']).toBe('query');
  expect(payloadText(search)).toBe(searchBody);
  const convert = onlyArchiveOf(h.database, PRIVILEGE_PATH);
  expect(convert.values['kind']).toBe('convert');
  expect(payloadText(convert)).toBe(convertBody);

  await listed(h.adapter.listRefunds(win, PLAIN));

  const refund = onlyArchiveOf(h.database, REFUND_PATH);
  expect(refund.values['kind']).toBe('order');
  const text = expectArchivedAs(refund, refundBody([refundOf(1)]));
  expect(text).not.toContain(tradeIdOf(50));
  expectAskedOnce(own.reader, [tradeIdOf(1), tradeIdOf(50)]);
});
