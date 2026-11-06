// B1-04zzc（D10-776 方案 A）：别家行的计数仍只由 ourRows 发——taobao_order_foreign_slot 每页恰好一条
// （count = 别家行数，与冻结的 [AC-B1-04f#36] 一致），归档侧不另发 warn / error；告警与日志里不带订单号、金额。
import { expect, it } from 'vitest';
import {
  MODES,
  ORDER_PATH,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  answer,
  expectArchivedAs,
  FOREIGN_ADZONE,
  foreign,
  foreignCounts,
  idOf,
  onlyArchiveOf,
  orderBody,
  ours,
  resolvedPage,
  visible,
  win,
  wire,
} from './kit.ts';

it.each(MODES)(
  '[AC-B1-04zzc#9] $mode：taobao_order_foreign_slot 这一页恰好一条（count 3），归档侧不另发 warn / error；告警与日志里没有订单号与金额',
  async ({ call }) => {
    const noSlot = ours(2, OUR_ADZONE, { adzone_id: undefined });
    const rows = [
      ours(1),
      foreign(50),
      noSlot,
      foreign(51, OTHER_FOREIGN_ADZONE, true),
      foreign(52, FOREIGN_ADZONE),
    ];
    const h = wire(() => answer(orderBody(rows)));

    await resolvedPage(() => h.adapter.listOrders(win, {}, call));

    expectArchivedAs(onlyArchiveOf(h.database, ORDER_PATH), orderBody([ours(1), noSlot]));
    expect(foreignCounts(h)).toEqual([3]);
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    const logs = visible([
      h.orderWarn.mock.calls,
      h.logger.warn.mock.calls,
      h.logger.error.mock.calls,
    ]);
    for (const index of [1, 2, 50, 51, 52]) expect(logs).not.toContain(idOf(index));
    for (const amount of ['88.80', '7.74', '7.66', '7.99']) expect(logs).not.toContain(amount);
  },
);
