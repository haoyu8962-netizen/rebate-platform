import { expect, it } from 'vitest';
import {
  collect,
  ctx,
  FOREIGN_ADZONE,
  listed,
  num,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  OUR_SLOT,
  onePage,
  rejection,
  RETIRED_ADZONE,
  row,
  rowOf,
  setup,
  visible,
  win,
} from './kit.ts';

// 推广位过滤（D10-488 ③）：账号与别家共用，只返回 adzone_id 属于凑狸在 union_pids 登记过的全部淘宝
// 推广位（含 retired）的订单。清单经注入的读取端口；PID 形如 mm_<memberid>_<siteid>_<adzoneid>，按最后
// 一段与 adzone_id 的十进制字符串比对。别家的订单不返回，每页只计数打一条告警（不带订单号、金额）；
// 清单为空 → 不发请求、返回空页并告警一次。订单源或推广位端口未注入 → adapter_unimplemented。

it('[AC-B1-04f#36] 只留我方推广位（含已停用）的订单；别家的不返回，整页只打一条计数告警', async () => {
  const rows = [
    rowOf(1, OUR_ADZONE),
    rowOf(2, FOREIGN_ADZONE),
    rowOf(3, RETIRED_ADZONE),
    rowOf(4, OTHER_FOREIGN_ADZONE),
  ];
  const s = setup(onePage(rows));
  const { orders } = await collect(s.adapter);
  expect(orders.map((order) => [order.order_id, order.promotion_slot])).toEqual([
    [rowOf(1).trade_id, OUR_ADZONE],
    [rowOf(3).trade_id, RETIRED_ADZONE],
  ]);
  const foreign = s.orderWarn.mock.calls.filter(
    ([event]) => event.event === 'taobao_order_foreign_slot',
  );
  expect(foreign).toEqual([[expect.objectContaining({ count: 2 })]]);
  const printed = visible(foreign);
  for (const marker of [
    String(rowOf(2).trade_id),
    String(rowOf(4).trade_id),
    FOREIGN_ADZONE,
    OTHER_FOREIGN_ADZONE,
    '88.80',
    '7.99',
  ]) {
    expect(printed).not.toContain(marker);
  }
});

it('[AC-B1-04f#37] 推广位清单经注入端口读取：以本次调用的上下文调用', async () => {
  const s = setup(onePage([rowOf(1)]));
  await listed(s.adapter.listOrders(win, {}, ctx));
  expect(s.orderSlots).toHaveBeenCalled();
  expect(s.orderSlots.mock.calls[0]![0]).toMatchObject({ appId: ctx.appId });
});

it('[AC-B1-04f#38] 只按 PID 最后一段整段比对：前缀、后缀、member / site 段相同都不算我方', async () => {
  const s = setup(onePage([rowOf(1, OUR_ADZONE)]), {
    slots: [
      `mm_1000000001_3000000001_${OUR_ADZONE}0`,
      `mm_1000000001_3000000001_${OUR_ADZONE.slice(1)}`,
      `mm_${OUR_ADZONE}_3000000001_999999999999`,
      `mm_1000000001_${OUR_ADZONE}_999999999998`,
    ],
  });
  const { orders } = await collect(s.adapter);
  expect(orders).toEqual([]);
  expect(s.orderWarn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_order_foreign_slot', count: 1 }),
  );
});

it('[AC-B1-04f#39] adzone_id 缺失或不是整数的订单不当作我方订单返回', async () => {
  const s = setup(
    onePage([
      row({ trade_id: '2900000000000000301', adzone_id: undefined }),
      row({ trade_id: '2900000000000000302', adzone_id: 'not-a-number' }),
      row({ trade_id: '2900000000000000303', adzone_id: num('123456789012.5') }),
      rowOf(4),
    ]),
  );
  const { orders } = await collect(s.adapter);
  expect(orders.map((order) => order.order_id)).toEqual([rowOf(4).trade_id]);
});

it('[AC-B1-04f#40] 推广位清单为空 → 不取凭据、不发请求，返回空页，告警一次', async () => {
  const s = setup(onePage([rowOf(1)]), { slots: [] });
  const page = await listed(s.adapter.listOrders(win, {}, ctx));
  expect(page).toEqual({ items: [], nextCursor: null });
  expect(s.orderSlots).toHaveBeenCalledTimes(1);
  expect(s.transport).not.toHaveBeenCalled();
  expect(s.dataokeCredentials).not.toHaveBeenCalled();
  expect(s.orderWarn.mock.calls).toEqual([
    [expect.objectContaining({ event: 'taobao_order_no_slots' })],
  ]);
});

it('[AC-B1-04f#41] 注入订单源与推广位端口才发请求；没有订单源 → adapter_unimplemented，不取凭据、不发请求', async () => {
  const wired = setup(onePage([rowOf(1)]));
  const { orders } = await collect(wired.adapter);
  expect(orders.map((order) => order.order_id)).toEqual([rowOf(1).trade_id]);
  expect(wired.transport).toHaveBeenCalledTimes(1);

  const bare = setup(onePage([rowOf(1)]), { source: false });
  await rejection(() => bare.adapter.listOrders(win, {}, ctx), 'adapter_unimplemented');
  expect(bare.transport).not.toHaveBeenCalled();
  expect(bare.dataokeCredentials).not.toHaveBeenCalled();
  expect(bare.taobaoCredentials).not.toHaveBeenCalled();
  expect(bare.taobaoTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04f#42] 有订单源但没有推广位端口 → adapter_unimplemented（不能过滤就不取单），不取凭据、不发请求', async () => {
  const wired = setup(onePage([rowOf(1)]));
  await collect(wired.adapter);
  expect(wired.orderSlots).toHaveBeenCalled();
  expect(wired.transport).toHaveBeenCalledTimes(1);

  const unfiltered = setup(onePage([rowOf(1)]), { slots: null });
  await rejection(() => unfiltered.adapter.listOrders(win, {}, ctx), 'adapter_unimplemented');
  expect(unfiltered.transport).not.toHaveBeenCalled();
  expect(unfiltered.dataokeCredentials).not.toHaveBeenCalled();
});

it('[AC-B1-04f#43] 我方单与别家单同页：别家单不占我方结果，我方单字段不受影响', async () => {
  const s = setup(
    onePage([row({ adzone_id: num(FOREIGN_ADZONE), trade_id: '2900000000000000401' }), row()]),
  );
  const { orders } = await collect(s.adapter);
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({
    promotion_slot: OUR_ADZONE,
    paid_fen: 8880n,
    commission_fen: 724n,
  });
  expect(visible(orders)).not.toContain('2900000000000000401');
  expect(OUR_SLOT.endsWith(`_${OUR_ADZONE}`)).toBe(true);
});
