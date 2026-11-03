// B1-08zh（D10-574，FU-PDD-NET-N）映射：拼多多的扣除只在适配器（BR-CALC-02、BR-CALC-03）。
// est_commission_fen = promotion_amount − duo_id_service_fee，可为负，负值保留；服务费缺失时 est 为 null，绝不按 0。
// commission_fen 仍是毛额（不入库），service_fee_fen 仍按本次报文原样。京东一字不变；淘宝自 B1-04zz 也是净额，在它自己的适配器里算。
import { expect, it } from 'vitest';
import { mapped as jdOrder } from '../jd-orders/kit.ts';
import { one as taobaoOrder, row as taobaoRow } from '../taobao-orders/kit.ts';
import {
  mapPddOrder,
  type PddOrderPage,
  type PddOrderSource,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';

/** 与 orders/rebate-wiring、orders/attribution 两个夹具的归因码、推广位相同。 */
const ATTR_UID = 'abcd1234';
const SLOT = 'slot-ours';
const CUSTOM_PARAMETERS = JSON.stringify({ app: 'n', uid: ATTR_UID });

const PAGE: PddOrderPage = { rawPayloadId: null, like: new Date('2026-10-17T17:30:00.000Z') };

/**
 * 一条已支付的订单报文：佣金 1000（含服务费）、服务费 100。字段名按 pdd.ddk.order.list.increment.get 文档：
 * promotion_amount 佣金含软件服务费，duo_id_service_fee 软件服务费，都是整数分。合成值，不是录制报文。
 */
function pddRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    order_sn: 'SYN-241102-0001',
    order_id: 'SYN-PO-0001',
    p_id: SLOT,
    pid: SLOT,
    goods_id: 8123456789012,
    goods_sign: 'syn-goods',
    mall_id: 7001,
    custom_parameters: CUSTOM_PARAMETERS,
    goods_price: 12000,
    order_amount: 12000,
    promotion_amount: 1000,
    duo_id_service_fee: 100,
    order_status: 0,
    order_status_desc: '已支付',
    order_pay_time: 1792000000,
    order_modify_at: 1792000060,
    ...overrides,
  };
}

function mapPdd(overrides: Record<string, unknown> = {}, source: PddOrderSource = 'increment') {
  return mapPddOrder(pddRow(overrides), source, PAGE);
}

it('[AC-B1-08zh#1][BR-CALC-03] 佣金 1000、服务费 100 → est 900，service_fee 100，commission_fen 1000；服务费 0 是真实值，est 等于佣金', () => {
  for (const source of ['increment', 'range', 'detail'] as const) {
    expect(mapPdd({}, source), source).toMatchObject({
      est_commission_fen: 900n,
      service_fee_fen: 100n,
      commission_fen: 1000n,
      settle_commission_fen: null,
    });
    expect(mapPdd({ duo_id_service_fee: 0 }, source), source).toMatchObject({
      est_commission_fen: 1000n,
      service_fee_fen: 0n,
      commission_fen: 1000n,
    });
  }
});

it('[AC-B1-08zh#2][BR-CALC-03] 服务费缺失（没有字段或 JSON null）→ est 为 null，不按 0，毛额照常', () => {
  for (const source of ['increment', 'range', 'detail'] as const) {
    for (const fee of [undefined, null]) {
      const order = mapPdd({ duo_id_service_fee: fee }, source);
      expect(order.est_commission_fen, `${source} ${String(fee)}`).toBeNull();
      expect(order.service_fee_fen, `${source} ${String(fee)}`).toBeNull();
      expect(order.commission_fen, `${source} ${String(fee)}`).toBe(1000n);
    }
  }
});

it('[AC-B1-08zh#3][BR-CALC-02] 服务费大于佣金：est 为负，不夹成 0；两者相等时 est 是 0', () => {
  expect(mapPdd({ promotion_amount: 100, duo_id_service_fee: 300 })).toMatchObject({
    est_commission_fen: -200n,
    service_fee_fen: 300n,
    commission_fen: 100n,
  });
  expect(mapPdd({ promotion_amount: 100, duo_id_service_fee: 100 })).toMatchObject({
    est_commission_fen: 0n,
    service_fee_fen: 100n,
    commission_fen: 100n,
  });
});

it('[AC-B1-08zh#4][BR-CALC-03] 净额逐分准确：接近安全整数上限也不经浮点', () => {
  const order = mapPdd({ promotion_amount: 9007199254740991, duo_id_service_fee: 3 });
  expect(order.est_commission_fen).toBe(9007199254740988n);
  expect(order.commission_fen).toBe(9007199254740991n);
});

it('[AC-B1-08zh#5][BR-CALC-03] 各扣各的：同一轮里拼多多 est 900，淘宝是自己字段的净额（B1-04zz），京东的 est 与结算额不受影响', async () => {
  expect(mapPdd().est_commission_fen).toBe(900n);

  const taobao = await taobaoOrder(taobaoRow({ pub_share_fee_for_commission: '7.66' }));
  expect(taobao.est_commission_fen).toBe(724n);
  expect(taobao.settle_commission_fen).toBe(666n);
  const jd = jdOrder({});
  expect(jd.est_commission_fen).toBe(123n);
  expect(jd.settle_commission_fen).toBeNull();
});
