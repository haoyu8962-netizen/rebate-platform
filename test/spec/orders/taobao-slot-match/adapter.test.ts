import { expect, it } from 'vitest';
import { num } from '../../union/taobao-orders/kit.ts';
import { ADZONE, FULL_PID, SITE, listPaidOrders, paidRow } from './adapter-kit.ts';

it('[AC-B1-08zzc#10] 只登记数字 PID 时，淘宝适配器正常拉单并返回数字推广位', async () => {
  const tradeId = '4920000000000000010';
  const page = await listPaidOrders([paidRow(tradeId)], [ADZONE]);

  expect(page.items).toMatchObject([
    { sub_order_id: tradeId, promotion_slot: ADZONE, site_id: SITE },
  ]);
});

it('[AC-B1-08zzc#11] mm_ 和数字 PID 混登时，淘宝适配器保留两种登记命中的订单', async () => {
  const fullPidTradeId = '4920000000000000011';
  const numericPidTradeId = '4920000000000000012';
  const page = await listPaidOrders(
    [
      paidRow(fullPidTradeId),
      paidRow('4920000000000000013', { adzone_id: num('4002') }),
      paidRow(numericPidTradeId, { adzone_id: num('3002') }),
    ],
    [FULL_PID, '3002'],
  );

  expect(page.items).toMatchObject([
    { sub_order_id: fullPidTradeId, promotion_slot: ADZONE },
    { sub_order_id: numericPidTradeId, promotion_slot: '3002' },
  ]);
});
