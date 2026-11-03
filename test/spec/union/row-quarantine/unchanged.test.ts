// B1-04zv：不传 rowErrors 时 listOrders 行为完全不变；collect 只收逐行映射错误，整页结构、窗口、游标、
// 商品键模式配置错误仍抛。「仍抛」这件事实现之前本来就成立，所以每条先证明 collect 在这条线路上确实
// 生效（expectCollecting），再看错误没有被它吞掉：否则这些用例在实现前就绿，证明不了什么。
import { expect, it } from 'vitest';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import type { Flagged } from '../jd-narrow/refusal.ts';
import { inner, num, reply as jdReply, wire } from '../jd-orders/kit.ts';
import { pdd, reply as pddReply } from '../orders-shape/kit.ts';
import { pageData, reply as taobaoReply, setup as taobaoSetup } from '../taobao-orders/kit.ts';
import { expectCollecting, JD, PDD, refused, rejectedOf, resolved, TAOBAO } from './wires.ts';

it.each([JD, PDD])(
  '[AC-B1-04zv#2] $name：同一页 collect 下隔离，不传 rowErrors 时仍整页 invalid_dto',
  async (w) => {
    const rows = [w.good(1), w.bad(2), w.good(3)];
    const page = await resolved(() => w.adapter(rows).listOrders(w.win, {}, w.collect));
    expect(rejectedOf(page)).toHaveLength(1);
    const error = await refused(() => w.adapter(rows).listOrders(w.win, {}, w.ctx));
    expect(error).toMatchObject({ code: 'invalid_dto', platform: w.name });
  },
);

// 淘宝不传 rowErrors 时的现行为是跳过并告警（冻结用例 AC-B1-04f#34），「行为完全不变」指的就是它。
it('[AC-B1-04zv#2] taobao：同一页 collect 下隔离，不传 rowErrors 时仍跳过该行并告警，页上没有 rejected', async () => {
  // B1-04zz：已结算行要有结算佣金字段（kit 的默认行没有）。
  const settled = { pub_share_fee_for_commission: '7.66' };
  const rows = [
    { ...TAOBAO.good(1), ...settled },
    { ...TAOBAO.bad(2), ...settled },
    { ...TAOBAO.good(3), ...settled },
  ];
  const collected = await resolved(() =>
    TAOBAO.adapter(rows).listOrders(TAOBAO.win, {}, TAOBAO.collect),
  );
  expect(rejectedOf(collected)).toHaveLength(1);

  const s = taobaoSetup(() => taobaoReply(pageData(rows)));
  const plain = await resolved(() => s.adapter.listOrders(TAOBAO.win, {}, TAOBAO.ctx));
  expect(plain.items.map((order) => order.sub_order_id)).toEqual([TAOBAO.idOf(1), TAOBAO.idOf(3)]);
  expect(plain.items[0]).toMatchObject({ est_commission_fen: 724n, settle_commission_fen: 666n });
  expect(Object.hasOwn(plain, 'rejected')).toBe(false);
  expect(s.orderWarn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_order_row_skipped', field: TAOBAO.brokenField }),
  );
});

it('[AC-B1-04zv#3] jd：data 不是数组，collect 下仍抛 invalid_dto', async () => {
  await expectCollecting(JD);
  const { adapter } = wire(() => jdReply(inner('rq-not-an-array', false)));
  const error = await refused(() => adapter.listOrders(JD.win, {}, JD.collect));
  expect(error).toMatchObject({ code: 'invalid_dto', platform: 'jd' });
});

it('[AC-B1-04zv#3] pdd：order_list 损坏，collect 下仍抛 invalid_dto', async () => {
  await expectCollecting(PDD);
  const adapter = pdd(async () =>
    pddReply({ order_list_get_response: { order_list: 'rq-not-an-array' } }),
  );
  const error = await refused(() => adapter.listOrders(PDD.win, {}, PDD.collect));
  expect(error).toMatchObject({ code: 'invalid_dto', platform: 'pdd' });
});

it('[AC-B1-04zv#3] taobao：results 损坏，collect 下仍抛 upstream_unavailable', async () => {
  // B1-04zz：已结算行要有结算佣金字段（kit 的默认行没有）；先看净额，这条在新口径之前是红的。
  const settled = { pub_share_fee_for_commission: '7.66' };
  const wired = {
    ...TAOBAO,
    good: (index: number) => ({ ...TAOBAO.good(index), ...settled }),
    bad: (index: number) => ({ ...TAOBAO.bad(index), ...settled }),
  };
  const net = await resolved(() =>
    wired.adapter([wired.good(1)]).listOrders(wired.win, {}, wired.collect),
  );
  expect(net.items[0]).toMatchObject({ est_commission_fen: 724n, settle_commission_fen: 666n });
  await expectCollecting(wired);
  const s = taobaoSetup(() => taobaoReply({ results: 'rq-not-an-object' }));
  const error = await refused(() => s.adapter.listOrders(TAOBAO.win, {}, TAOBAO.collect));
  expect(error).toMatchObject({ code: 'upstream_unavailable', platform: 'taobao' });
});

it('[AC-B1-04zv#3] jd：商品键模式配置错误，collect 下仍抛 invalid_dto', async () => {
  await expectCollecting(JD);
  const read = async () => 'spu' as unknown as JdProductKeyMode;
  const { adapter } = wire(() => jdReply(inner([JD.good(1)], false)), { productKeyMode: { read } });
  const error = await refused(() => adapter.listOrders(JD.win, {}, JD.collect));
  expect(error).toMatchObject({ code: 'invalid_dto', platform: 'jd' });
});

it('[AC-B1-04zv#3] jd：窗口与游标错误，collect 下仍抛 invalid_dto', async () => {
  await expectCollecting(JD);
  const { adapter } = wire(() => jdReply(inner([JD.good(1)], false)));
  const tooWide = { from: '2026-10-30T02:00:00Z', to: '2026-10-30T04:00:00Z' };
  expect(await refused(() => adapter.listOrders(tooWide, {}, JD.collect))).toMatchObject({
    code: 'invalid_dto',
    platform: 'jd',
  });
  const cursor = { cursor: 'rq-not-a-cursor' };
  expect(await refused(() => adapter.listOrders(JD.win, cursor, JD.collect))).toMatchObject({
    code: 'invalid_dto',
    platform: 'jd',
  });
});

it('[AC-B1-04zv#3] jd：窗口过大的拒绝在 collect 下仍带 windowTooLarge 抛出，缩窗照旧', async () => {
  await expectCollecting(JD);
  const { adapter } = wire(() => jdReply(inner([], false, num('2002452'))));
  const error = (await refused(() => adapter.listOrders(JD.win, {}, JD.collect))) as Flagged;
  expect(error.windowTooLarge).toBe(true);
});
