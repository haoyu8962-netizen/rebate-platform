// B1-04zzc（D10-776 方案 A）：本单只改订单详情——同一个适配器、同一个归档传输上，大淘客的维权、搜索、
// 转链请求的归档不变（仍存收到的原文，连夹带的订单形状也不动），违规请求的归档自 B1-04zzp 起同样去掉别家
// 推广位的行，而订单详情的归档已去掉别家行。每个用例先走一页订单详情作对照。报文全部合成。
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
  punishData,
  punishOf,
  reply as afterSalesReply,
  refundData,
  refundOf,
} from '../taobao-refunds/kit.ts';
import {
  COLLECT,
  DECOY,
  DECOY_TRADE_ID,
  FOREIGN_ADZONE,
  ORDER_PATH,
  OTHER_FOREIGN_ADZONE,
  PLAIN,
  PUNISH_PATH,
  REFUND_PATH,
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
  type Wired,
} from './kit.ts';

const ORDER_ROWS = [ours(1), foreign(50)];

/** An upstream answering the order details with ORDER_ROWS and `path` with `body`. */
function wiredWith(path: string, body: string): Wired {
  return wire((call) =>
    answer(
      call.path === ORDER_PATH
        ? orderBody(ORDER_ROWS)
        : call.path === path
          ? body
          : '{"code":-1,"msg":"synthetic unexpected path"}',
    ),
  );
}

/** The order page of the same adapter: its archive holds our row only. */
async function orderPageFiltered(h: Wired): Promise<void> {
  await resolvedPage(() => h.adapter.listOrders(win, {}, COLLECT));
  expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody([ours(1)]));
}

it('[AC-B1-04zzc#11] 维权 get-order-refund 的归档仍是收到的原文（夹带的 publisher_order_dto 形状也不动），同一适配器的订单详情归档已去掉别家行', async () => {
  const body = afterSalesReply({
    ...refundData([refundOf(1), refundOf(2)]),
    results: { publisher_order_dto: [DECOY] },
  }).body;
  const h = wiredWith(REFUND_PATH, body);

  await orderPageFiltered(h);
  await regardless(() => h.adapter.listRefunds(win, PLAIN));

  const row = onlyArchiveOf(h.database, REFUND_PATH);
  expect(row.values['kind']).toBe('order');
  expect(payloadText(row)).toBe(body);
  expect(payloadText(row)).toContain(DECOY_TRADE_ID);
});

it('[AC-B1-04zzc#12] 违规 get-foul-order-list 的归档已去掉别家推广位的违规行（只剩自家行，外层字段不变；B1-04zzp），同一适配器的订单详情归档已去掉别家行', async () => {
  const rows = [punishOf(1), punishOf(2, FOREIGN_ADZONE), punishOf(3, OTHER_FOREIGN_ADZONE)];
  const body = afterSalesReply(punishData(rows, rows.length)).body;
  const h = wiredWith(PUNISH_PATH, body);

  await orderPageFiltered(h);
  await regardless(() => h.adapter.listPunishments(win, PLAIN));

  const row = onlyArchiveOf(h.database, PUNISH_PATH);
  expect(row.values['kind']).toBe('order');
  expectArchivedAs(row, afterSalesReply(punishData([punishOf(1)], rows.length)).body);
  expect(payloadText(row)).not.toContain(FOREIGN_ADZONE);
  expect(payloadText(row)).not.toContain(OTHER_FOREIGN_ADZONE);
});

it('[AC-B1-04zzc#13] 大淘客搜索的归档仍是收到的原文，同一适配器的订单详情归档已去掉别家行', async () => {
  const body = JSON.stringify({
    time: 1793600000000,
    code: 0,
    msg: '成功',
    data: { list: [], totalNum: 0, pageId: '1', results: { publisher_order_dto: [DECOY] } },
  });
  const h = wiredWith(DATAOKE_SEARCH_PATH, body);

  await orderPageFiltered(h);
  await regardless(() =>
    h.adapter.searchItems({ keyword: '合成关键词' }, { ...PLAIN, purpose: 'online' }),
  );

  const row = onlyArchiveOf(h.database, DATAOKE_SEARCH_PATH);
  expect(row.values['kind']).toBe('query');
  expect(payloadText(row)).toBe(body);
});

it('[AC-B1-04zzc#14] 大淘客转链的归档仍是收到的原文，同一适配器的订单详情归档已去掉别家行', async () => {
  const body = JSON.stringify({
    time: 1793600000000,
    code: 0,
    msg: 'ok',
    data: { ...privilegeData(), results: { publisher_order_dto: [DECOY] } },
  });
  const h = wiredWith(PRIVILEGE_PATH, body);

  await orderPageFiltered(h);
  await regardless(() => h.adapter.convert(req, identity, convertCtx));

  const row = onlyArchiveOf(h.database, PRIVILEGE_PATH);
  expect(row.values['kind']).toBe('convert');
  expect(payloadText(row)).toBe(body);
});
