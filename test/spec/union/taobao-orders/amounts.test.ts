import { expect, it } from 'vitest';
import {
  collect,
  FOREIGN_ADZONE,
  num,
  one,
  OUR_ADZONE,
  OUR_SLOT,
  onePage,
  row,
  rowOf,
  setup,
  TRADE_ID,
  visible,
} from './kit.ts';

// 金额与比例（BR-CALC-26，订单报文金额）：元字符串按十进制解析，两位内精确、超两位 floor 到分
// （yuanStrToFen）；JSON number 取数字原文再解析，不先转 JS number；百分比字符串 → bp（pctStrToBp）。
// 可选字段非法 / 缺失 → 该字段 null 并告警，不整页失败；缺必需字段（trade_id、alipay_total_price、
// pub_share_pre_fee）或其非法 → 跳过该条并告警。告警不带订单号、金额。

it.each([
  ['14.52', 1452n],
  ['14.5', 1450n],
  ['14', 1400n],
  ['14.526', 1452n],
  ['0.009', 0n],
  ['0.00', 0n],
])('[AC-B1-04f#28] 元字符串「%s」→ %s 分（两位内精确、超两位 floor）', async (text, fen) => {
  const order = await one(
    row({
      alipay_total_price: text,
      pub_share_pre_fee_for_commission: text,
      pub_share_fee_for_commission: text,
      alimm_share_info_dto: {
        alimm_tech_service_fee: num('0'),
        alimm_tech_service_pre_fee: num('0'),
      },
    }),
  );
  expect(order.paid_fen).toBe(fen);
  expect(order.commission_fen).toBe(fen);
  expect(order.est_commission_fen).toBe(fen);
  expect(order.settle_commission_fen).toBe(fen);
});

it('[AC-B1-04f#29] 金额为 JSON number 时取数字原文：0.29999999999999999 元 → 29 分（转 JS number 会得 30）', async () => {
  const order = await one(
    row({
      pub_share_pre_fee_for_commission: num('1.29999999999999999'),
      alimm_share_info_dto: {
        alimm_tech_service_fee: num('2'),
        alimm_tech_service_pre_fee: num('0.29999999999999999'),
        alimm_tech_service_rate: num('10'),
      },
    }),
  );
  expect(order.commission_fen).toBe(100n);
  expect(order.est_commission_fen).toBe(100n);
  expect(order.tech_service_pre_fee_fen).toBe(29n);
  expect(order.tech_service_fee_fen).toBe(200n);
});

it('[AC-B1-04f#30] 超出 JS 安全整数的元金额（字符串或 JSON number）都精确到分', async () => {
  const text = '12345678901234567.89';
  const asText = await one(row({ alipay_total_price: text }));
  expect(asText.paid_fen).toBe(1234567890123456789n);
  const asNumber = await one(row({ alipay_total_price: num(text) }));
  expect(asNumber.paid_fen).toBe(1234567890123456789n);
});

it.each([
  ['9.00', 900n],
  ['12.345', 1234n],
  ['100.00', 10000n],
  ['0.5', 50n],
])('[AC-B1-04f#31] 比例字符串「%s」→ %s bp（pctStrToBp）', async (text, bp) => {
  const order = await one(
    row({ income_rate: text, pub_share_rate: text, total_commission_rate: text }),
  );
  expect(order.income_rate_bp).toBe(bp);
  expect(order.pub_share_rate_bp).toBe(bp);
  expect(order.total_commission_rate_bp).toBe(bp);
});

it.each([
  ['subsidy_fee', 'abc', 'subsidy_fen'],
  ['subsidy_fee', '1e2', 'subsidy_fen'],
  ['alimama_share_fee', 'NaN', 'alimama_share_fen'],
  ['total_commission_fee', '', 'total_commission_fen'],
  ['item_price', '12.3.4', 'item_price_fen'],
  ['income_rate', '120.00', 'income_rate_bp'],
  ['pub_share_rate', 'abc', 'pub_share_rate_bp'],
  ['pub_share_fee_for_commission', 'abc', 'settle_commission_fen'],
] as const)(
  '[AC-B1-04f#32] 可选字段 %s 非法（「%s」）→ %s 为 null 并告警，该条与同页其他条照常返回',
  async (field, value, mapped) => {
    const s = setup(onePage([row({ [field]: value }), rowOf(2)]));
    const { orders } = await collect(s.adapter);
    expect(orders.map((order) => order.order_id)).toEqual([TRADE_ID, rowOf(2).trade_id]);
    expect(orders[0]![mapped]).toBeNull();
    expect(orders[0]).toMatchObject({ paid_fen: 8880n, commission_fen: 724n });
    expect(s.orderWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'taobao_order_field_invalid', field }),
    );
  },
);

it('[AC-B1-04f#33] 时间字段非法 → 该时刻为 null 并告警（field 为上游字段名），不整页失败', async () => {
  const s = setup(onePage([row({ modified_time: '2026-13-45 99:00:00' }), rowOf(2)]));
  const { orders } = await collect(s.adapter);
  expect(orders).toHaveLength(2);
  expect(orders[0]!.modified_at).toBeNull();
  expect(orders[0]!.paid_at).toEqual(new Date('2026-10-30T02:00:05Z'));
  expect(s.orderWarn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_order_field_invalid', field: 'modified_time' }),
  );
});

it.each([
  ['trade_id', undefined],
  ['trade_id', num('2900000000000000101')],
  ['trade_id', null],
  ['alipay_total_price', undefined],
  ['alipay_total_price', 'abc'],
  ['pub_share_pre_fee', undefined],
  ['pub_share_pre_fee', 'abc'],
] as const)(
  '[AC-B1-04f#34] 必需字段 %s 缺失或非法（%o）→ 跳过该条并告警，同页其他条照常返回',
  async (field, value) => {
    const s = setup(onePage([rowOf(1), row({ [field]: value }), rowOf(3)]));
    const { orders } = await collect(s.adapter);
    expect(orders.map((order) => order.order_id)).toEqual([rowOf(1).trade_id, rowOf(3).trade_id]);
    expect(s.orderWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'taobao_order_row_skipped', field }),
    );
  },
);

it('[AC-B1-04f#35] 告警不带订单号、金额、推广位或凭据', async () => {
  const s = setup(
    onePage([
      row({ subsidy_fee: 'abc', modified_time: 'not-a-time' }),
      row({ trade_id: '2900000000000000909', alipay_total_price: undefined }),
      row({ trade_id: '2900000000000000808', adzone_id: num(FOREIGN_ADZONE) }),
    ]),
  );
  await collect(s.adapter);
  expect(s.orderWarn).toHaveBeenCalled();
  const printed = visible(s.orderWarn.mock.calls);
  for (const marker of [
    TRADE_ID,
    '2900000000000000909',
    '2900000000000000808',
    '88.80',
    '7.99',
    '6.66',
    OUR_ADZONE,
    FOREIGN_ADZONE,
    OUR_SLOT,
    'dtk-dtk-dtk-dtk-dtk-dtk',
  ]) {
    expect(printed).not.toContain(marker);
  }
});
