// B1-18c（BR-CALC-18「分字段返回时直接映射」）：淘宝订单 DTO 输出 subsidy_commission_fen。未结算行（tk_status ≠ 3）
// 取 pub_share_pre_fee_for_sdy，已结算行（tk_status = 3）取 pub_share_fee_for_sdy，同 est / settle 的取值时机；
// 元转分同 BR-CALC-26（元字符串或 JSON 数字原文，两位以外 floor）。补贴字段没有值（缺键、null、「--」、空串）或
// 非法 → null，不是 0，整行照常映射；est / settle 不因补贴变化而变化。补贴部分不扣服务费。
// 真实适配器 + 假传输，两种开关（不开 / CallCtx.rowErrors collect）都跑。报文全部合成，字段名照官方
// publisher_order_dto（pub_share_pre_fee_for_sdy / pub_share_fee_for_sdy）。
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  mapTaobaoOrder,
  parseTaobaoOrderBody,
} from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { BAD_AMOUNT } from '../row-quarantine/wires.ts';
import { netRow, paidRow } from '../taobao-net-n/net-row.ts';
import {
  forms,
  ILLEGAL,
  inBothModes,
  MODES,
  orderOf,
  throughAdapter,
} from '../taobao-negative/negative-wire.ts';
import { instant, num, pageData, reply } from '../taobao-orders/kit.ts';

const PRE_SDY = 'pub_share_pre_fee_for_sdy';
const SETTLE_SDY = 'pub_share_fee_for_sdy';

// net-row.ts 的金额：未结算行补贴 2.00、佣金 10.00、预估服务费 1.00 → est 900；
// 已结算行补贴 1.50、佣金 9.00、结算服务费 0.80 → settle 820。
const PAID_NET = { est_commission_fen: 900n, settle_commission_fen: null };
const SETTLED_NET = { est_commission_fen: 900n, settle_commission_fen: 820n };

it.each(MODES)(
  '[AC-B1-18c#1][AC-B1-18c#2][BR-CALC-18] $mode：未结算行（tk_status 12）subsidy_commission_fen 取 pub_share_pre_fee_for_sdy 2.00 → 200，不扣服务费；pub_share_fee_for_sdy 不读；est 不变',
  async ({ call }) => {
    const input = paidRow(1);
    const ignoresSettle = paidRow(2, { [SETTLE_SDY]: num('5.55') });
    const moreSubsidy = paidRow(3, { pub_share_pre_fee: '99.00', [PRE_SDY]: num('89.00') });
    const page = await throughAdapter([input, ignoresSettle, moreSubsidy], call);
    expect(page.rejected).toEqual([]);

    const order = orderOf(page.items, input);
    expect(order.subsidy_commission_fen).toBe(200n);
    expect(order).toMatchObject(PAID_NET);
    expect(orderOf(page.items, ignoresSettle).subsidy_commission_fen).toBe(200n);
    // 只改补贴字段：补贴跟着变，N 不变（补贴不进 N）。
    expect(orderOf(page.items, moreSubsidy).subsidy_commission_fen).toBe(8900n);
    expect(orderOf(page.items, moreSubsidy)).toMatchObject(PAID_NET);
  },
);

it.each(MODES)(
  '[AC-B1-18c#2][BR-CALC-18] $mode：已结算行（tk_status 3）subsidy_commission_fen 取 pub_share_fee_for_sdy 1.50 → 150，不取预估的 2.00，不扣服务费；est、settle 不变',
  async ({ call }) => {
    const input = netRow(1);
    const moreSubsidy = netRow(2, {
      pub_share_pre_fee: '50.00',
      [PRE_SDY]: num('40.00'),
      pub_share_fee: '45.50',
      [SETTLE_SDY]: num('36.50'),
    });
    const page = await throughAdapter([input, moreSubsidy], call);
    expect(page.rejected).toEqual([]);

    const order = orderOf(page.items, input);
    expect(order.subsidy_commission_fen).toBe(150n);
    expect(order).toMatchObject(SETTLED_NET);
    expect(orderOf(page.items, moreSubsidy).subsidy_commission_fen).toBe(3650n);
    expect(orderOf(page.items, moreSubsidy)).toMatchObject(SETTLED_NET);
  },
);

const NO_VALUE: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '缺键', value: undefined },
  { label: 'JSON null', value: null },
  { label: '「--」', value: '--' },
  { label: '空串', value: '' },
];

it.each(inBothModes(NO_VALUE))(
  '[AC-B1-18c#3][BR-CALC-18] $mode：补贴字段$label → subsidy_commission_fen 为 null（不是 0n），行照常映射、不进 rejected；已结算行不回退预估补贴',
  async ({ call, value }) => {
    const paid = paidRow(1, { [PRE_SDY]: value });
    const settled = netRow(2, { [SETTLE_SDY]: value });
    const page = await throughAdapter([paid, settled], call);
    expect(page.rejected).toEqual([]);

    const paidOrder = orderOf(page.items, paid);
    expect(paidOrder.subsidy_commission_fen).toBeNull();
    expect(paidOrder).toMatchObject(PAID_NET);
    const settledOrder = orderOf(page.items, settled);
    expect(settledOrder.subsidy_commission_fen).toBeNull();
    expect(settledOrder).toMatchObject(SETTLED_NET);
  },
);

const INVALID: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: '非数字', value: BAD_AMOUNT },
  ...ILLEGAL.filter((item) => item.value !== ''),
];

it.each(inBothModes(INVALID))(
  '[AC-B1-18c#3][BR-CALC-18][BR-CALC-26] $mode：补贴字段 $label 是非法数字 → subsidy_commission_fen 为 null，不整行拒收，其他字段照常映射',
  async ({ call, value }) => {
    const paid = paidRow(1, { [PRE_SDY]: value });
    const settled = netRow(2, { [SETTLE_SDY]: value });
    const page = await throughAdapter([paid, settled], call);
    expect(page.rejected).toEqual([]);
    expect(page.items.map((order) => order.sub_order_id)).toEqual([
      paid.trade_id,
      settled.trade_id,
    ]);

    const paidOrder = orderOf(page.items, paid);
    expect(paidOrder.subsidy_commission_fen).toBeNull();
    expect(paidOrder).toMatchObject({ ...PAID_NET, commission_fen: 900n, service_fee_fen: 100n });
    const settledOrder = orderOf(page.items, settled);
    expect(settledOrder.subsidy_commission_fen).toBeNull();
    expect(settledOrder).toMatchObject({ ...SETTLED_NET, service_fee_fen: 80n, raw_status: '3' });
  },
);

it.each(inBothModes([{ text: '0' }, { text: '0.00' }]))(
  '[AC-B1-18c#3][BR-CALC-18] $mode：补贴字段「$text」（字符串与 JSON number）→ 0n，不是 null',
  async ({ call, text }) => {
    for (const value of forms(text)) {
      const paid = paidRow(1, { [PRE_SDY]: value });
      const settled = netRow(2, { [SETTLE_SDY]: value });
      const page = await throughAdapter([paid, settled], call);
      expect(page.rejected).toEqual([]);
      expect(orderOf(page.items, paid).subsidy_commission_fen).toBe(0n);
      expect(orderOf(page.items, settled).subsidy_commission_fen).toBe(0n);
    }
  },
);

it.each([
  ['1.239', 123n],
  ['0.009', 0n],
  ['0.29999999999999999', 29n],
  ['10', 1000n],
  ['12345678901234567.89', 1234567890123456789n],
] as const)(
  '[AC-B1-18c#2][BR-CALC-26] 补贴 %s 元 → %s 分：字面值逐字解析，两位以外 floor，不经浮点；未结算行、已结算行同一换算',
  async (text, fen) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const paid = paidRow(1, { [PRE_SDY]: value });
        const settled = netRow(2, { [SETTLE_SDY]: value });
        const page = await throughAdapter([paid, settled], call);
        expect(page.rejected).toEqual([]);
        expect(orderOf(page.items, paid).subsidy_commission_fen).toBe(fen);
        expect(orderOf(page.items, settled).subsidy_commission_fen).toBe(fen);
      }
    }
  },
);

/** A non-negative yuan literal and its fen worked out by hand on bigint (floor). */
function yuan() {
  return fc
    .tuple(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.stringMatching(/^[0-9]{0,6}$/))
    .map(([whole, tail]) => ({
      text: `${whole}${tail === '' ? '' : `.${tail}`}`,
      fen: whole * 100n + BigInt(tail.slice(0, 2).padEnd(2, '0')),
    }));
}

/** One row as listOrders would read it: the real body parser keeps JSON number literals. */
function parsedRow(input: Record<string, unknown>): unknown {
  return parseTaobaoOrderBody(reply(pageData([input])).body).rows[0];
}

// 走报文解析 + 映射，不每轮重建适配器；断言写在属性回调里，反例由 fc.assert 直接报出。
it('[AC-B1-18c#2][BR-CALC-18][BR-CALC-26] 任意补贴：未结算行等于预估补贴 floor 后的分、已结算行等于结算补贴 floor 后的分，est、settle 不随补贴变', () => {
  const meta = { rawPayloadId: null, like: new FixedClock(instant).now() };
  fc.assert(
    fc.property(yuan(), yuan(), (pre, settle) => {
      const amounts = { [PRE_SDY]: num(pre.text), [SETTLE_SDY]: num(settle.text) };
      const paid = mapTaobaoOrder(parsedRow(paidRow(1, amounts)), meta, undefined);
      const settled = mapTaobaoOrder(parsedRow(netRow(2, amounts)), meta, undefined);
      expect(paid?.subsidy_commission_fen).toBe(pre.fen);
      expect(paid).toMatchObject(PAID_NET);
      expect(settled?.subsidy_commission_fen).toBe(settle.fen);
      expect(settled).toMatchObject(SETTLED_NET);
      return true;
    }),
    { numRuns: Math.max(50, Math.floor(propRuns() / 100)), seed: propSeed() },
  );
}, 900_000);
