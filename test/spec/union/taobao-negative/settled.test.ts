// B1-04zw：已结算行的负值原样保留（BR-CALC-26），不再置 null 回退到预估。'-0.00' 是 0。B1-04zz 改口径
// （D10-588）：结算读 pub_share_fee_for_commission 减结算服务费，kit 的预估服务费 0.50、结算服务费 1.00。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  mapTaobaoOrder,
  parseTaobaoOrderBody,
} from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { instant, num, pageData, reply, rowOf } from '../taobao-orders/kit.ts';
import { forms, MODES, NEGATIVE, orderOf, throughAdapter } from './negative-wire.ts';

/** 已结算行要有结算佣金字段（kit 的默认行没有）：7.66 − 1.00 = 666 分，与原来的期望值相同。 */
function settled(index: number): Record<string, unknown> {
  return { ...rowOf(index), pub_share_fee_for_commission: '7.66' };
}

it.each(MODES)(
  '[AC-B1-04zw#1] $mode：已结算行 pub_share_fee_for_commission「-1.00」→ settle_commission_fen -200n，留在 items，不告警，不进 rejected',
  async ({ call }) => {
    const negative: Record<string, unknown> = {
      ...rowOf(2),
      pub_share_fee_for_commission: '-1.00',
    };
    const page = await throughAdapter([settled(1), negative, settled(3)], call);
    expect(page.items.map((order) => order.sub_order_id)).toEqual([
      rowOf(1).trade_id,
      negative.trade_id,
      rowOf(3).trade_id,
    ]);
    expect(orderOf(page.items, negative)).toMatchObject({
      settle_commission_fen: -200n,
      est_commission_fen: 724n,
      commission_fen: 724n,
      paid_fen: 8880n,
    });
    expect(orderOf(page.items, rowOf(1)).settle_commission_fen).toBe(666n);
    expect(page.rejected).toEqual([]);
    expect(page.warned).toEqual([]);
  },
);

it.each(NEGATIVE)(
  '[AC-B1-04zw#2] pub_share_fee_for_commission「%s」（字符串与 JSON number，两种开关）→ settle_commission_fen 是 %s 分减 100，数学 floor',
  async (text, fen) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const input = { ...rowOf(1), pub_share_fee_for_commission: value };
        const page = await throughAdapter([input], call);
        expect(page.rejected).toEqual([]);
        expect(orderOf(page.items, rowOf(1)).settle_commission_fen).toBe(fen - 100n);
      }
    }
  },
);

/** A negative yuan literal and its fen worked out by hand on bigint: mathematical floor. */
const negativeYuan = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.stringMatching(/^[0-9]{0,6}$/))
  .map(([whole, tail]) => {
    const exact = whole * 100n + BigInt(tail.slice(0, 2).padEnd(2, '0'));
    const dropped = /[1-9]/.test(tail.slice(2));
    return {
      text: tail === '' ? `-${whole}` : `-${whole}.${tail}`,
      fen: -exact - (dropped ? 1n : 0n),
    };
  });

/** One row as listOrders would read it: the real body parser keeps JSON number literals. */
function parsedRow(value: unknown): unknown {
  const input = {
    ...rowOf(1),
    pub_share_fee_for_commission: value,
    pub_share_pre_fee_for_commission: value,
    alipay_total_price: value,
  };
  return parseTaobaoOrderBody(reply(pageData([input])).body).rows[0];
}

// PROP_RUNS 默认一万轮，所以这条走报文解析 + 映射，不每轮重建适配器；线路上的行为由上面的表钉着。
// 属性体返回布尔，fc.assert 外只做一次汇总断言（规划/11）；反例经 not.toThrow 成为 AssertionError。
it('[AC-B1-04zw#2] 任意负的元金额：settle、est 按数学 floor 保留，commission、paid 收到 0', () => {
  const meta = { rawPayloadId: null, like: new FixedClock(instant).now() };
  expect(() =>
    fc.assert(
      fc.property(negativeYuan, ({ text, fen }) => {
        const order = mapTaobaoOrder(parsedRow(num(text)), meta, undefined);
        return (
          order?.settle_commission_fen === fen - 100n &&
          order.est_commission_fen === fen - 50n &&
          order.commission_fen === 0n &&
          order.paid_fen === 0n
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 120_000);

it.each(MODES)(
  '[AC-B1-04zw#7] $mode：「-0.00」（字符串与 JSON number）是 0：三个金额都是 0n，行不跳过、不进 rejected',
  async ({ call }) => {
    for (const value of forms('-0.00')) {
      const zero = {
        ...rowOf(1),
        pub_share_fee_for_commission: value,
        pub_share_pre_fee: value,
        pub_share_pre_fee_for_commission: value,
        alipay_total_price: value,
        alimm_share_info_dto: {
          alimm_tech_service_fee: num('0'),
          alimm_tech_service_pre_fee: num('0'),
        },
      };
      const page = await throughAdapter([zero], call);
      expect(page.rejected).toEqual([]);
      expect(page.warned).not.toContainEqual(
        expect.objectContaining({ event: 'taobao_order_row_skipped' }),
      );
      const order = orderOf(page.items, zero);
      expect(order.settle_commission_fen).toBe(0n);
      expect(order.est_commission_fen).toBe(0n);
      expect(order.commission_fen).toBe(0n);
      expect(order.paid_fen).toBe(0n);
    }
  },
);
