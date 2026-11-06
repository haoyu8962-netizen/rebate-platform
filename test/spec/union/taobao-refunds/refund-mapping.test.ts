import { expect, it } from 'vitest';
import {
  beijingDate,
  num,
  oneRefund,
  REFUND_ID,
  refundOf,
  refundPage,
  refundRow,
  refunds,
  setup,
  TRADE_ID,
  visible,
} from './kit.ts';

// 维权映射（任务书「目标口径 · UnionRefund 映射」，D10-488 ② / D10-491）：order_id = tb_trade_id，
// refund_id = refund_suit_id；base_refund_fen = tk_commission_fee_refund − tk_commission_alimm_refund_fee
// − tk_commission_agent_refund_fee，subsidy_refund_fen = tk_subsidy_fee_refund −
// tk_subsidy_alimm_refund_fee − tk_subsidy_agent_refund_fee，refund_fen = base_refund_fen；各金额先按
// BR-CALC-26 用 yuanStrToFen 单独取分（超两位 floor；JSON 数字取原文），再相减。show_return_fen 原样留存、
// 不参与金额；refund_status 原样字符串；平台时间（北京时间）→ Date，「--」或缺失 → null。必需金额缺失 /
// 非法 → 跳过该条并告警；差为负 → 跳过并告警（不出负数）。告警不带订单号、维权号与金额。

const REQUIRED_AMOUNTS = [
  'tk_commission_fee_refund',
  'tk_commission_alimm_refund_fee',
  'tk_commission_agent_refund_fee',
  'tk_subsidy_fee_refund',
  'tk_subsidy_alimm_refund_fee',
  'tk_subsidy_agent_refund_fee',
] as const;

it('[AC-B1-04z#24] 一条完整维权映射为 UnionRefund：编号、两段应扣佣金、留存字段与四个平台时间', async () => {
  const refund = await oneRefund(refundRow());
  expect(refund).toEqual({
    order_id: TRADE_ID,
    refund_id: REFUND_ID,
    refund_fen: 799n,
    base_refund_fen: 799n,
    subsidy_refund_fen: 100n,
    show_return_fen: 666n,
    refund_status: '4',
    rights_status: 'PROCESSING',
    refund_created_at: beijingDate('2026-10-30 10:20:00'),
    refund_finished_at: beijingDate('2026-10-30 10:50:00'),
    modified_at: beijingDate('2026-10-30 10:55:30'),
    earning_at: beijingDate('2026-10-30 10:40:00'),
  });
  for (const key of ['refund_created_at', 'refund_finished_at', 'modified_at', 'earning_at']) {
    expect(Reflect.get(refund, key)).toBeInstanceOf(Date);
  }
});

it('[AC-B1-04z#25] refund_fen 只用 base_refund_fen：补贴退款再大也不并入', async () => {
  const refund = await oneRefund(
    refundRow({
      tk_subsidy_fee_refund: '50.00',
      tk_subsidy_alimm_refund_fee: '0.00',
      tk_subsidy_agent_refund_fee: '0.00',
    }),
  );
  expect(refund.subsidy_refund_fen).toBe(5000n);
  expect(refund.base_refund_fen).toBe(799n);
  expect(refund.refund_fen).toBe(799n);
});

it('[AC-B1-04z#26] JSON 数字金额取报文原文（BR-CALC-26），不经 JS number', async () => {
  const refund = await oneRefund(
    refundRow({
      tk_commission_fee_refund: num('0.29999999999999999'),
      tk_commission_alimm_refund_fee: num('0'),
      tk_commission_agent_refund_fee: num('0.00'),
      tk_subsidy_fee_refund: num('1.2'),
      tk_subsidy_alimm_refund_fee: num('0.1'),
      tk_subsidy_agent_refund_fee: num('0'),
      show_return_fee: num('6.66'),
    }),
  );
  expect(refund.base_refund_fen).toBe(29n);
  expect(refund.refund_fen).toBe(29n);
  expect(refund.subsidy_refund_fen).toBe(110n);
  expect(refund.show_return_fen).toBe(666n);
});

it('[AC-B1-04z#27] 超过两位小数：每个金额先各自向下取整到分，再相减', async () => {
  const refund = await oneRefund(
    refundRow({
      tk_commission_fee_refund: '1.239',
      tk_commission_alimm_refund_fee: '0.011',
      tk_commission_agent_refund_fee: '0.009',
      tk_subsidy_fee_refund: '0.999',
      tk_subsidy_alimm_refund_fee: '0.001',
      tk_subsidy_agent_refund_fee: '0.001',
    }),
  );
  // 佣金取原值向下取整：1.239 → 123（D10-645 ①，不减服务费）；补贴逐项取整是 99 − 0 − 0 = 99。
  expect(refund.base_refund_fen).toBe(123n);
  expect(refund.refund_fen).toBe(123n);
  expect(refund.subsidy_refund_fen).toBe(99n);
});

it('[AC-B1-04z#28] 应扣为 0 的维权照常返回（不是负数）', async () => {
  // D10-645 ①：佣金取 tk_commission_fee_refund 原值 0.00，服务费 0.80 / 0.39 不参与相减（旧口径
  // 0 − 80 − 39 为负会跳过）；D10-206 让本用例在旧实现上因断言失败而红。
  const refund = await oneRefund(
    refundRow({
      tk_commission_fee_refund: '0.00',
      tk_commission_alimm_refund_fee: '0.80',
      tk_commission_agent_refund_fee: '0.39',
      tk_subsidy_fee_refund: '0.00',
      tk_subsidy_alimm_refund_fee: '0.00',
      tk_subsidy_agent_refund_fee: '0.00',
    }),
  );
  expect(refund).toMatchObject({ refund_fen: 0n, base_refund_fen: 0n, subsidy_refund_fen: 0n });
});

it('[AC-B1-04z#29] 订单号、维权号是 JSON 整数时取十进制原文（19 位不丢精度）；字符串原样', async () => {
  const fromNumbers = await oneRefund(
    refundRow({
      tb_trade_id: num('2900000000000000777'),
      refund_suit_id: num('3300000000000000777'),
    }),
  );
  expect(fromNumbers).toMatchObject({
    order_id: '2900000000000000777',
    refund_id: '3300000000000000777',
  });
  const fromStrings = await oneRefund(refundRow());
  expect(fromStrings).toMatchObject({ order_id: TRADE_ID, refund_id: REFUND_ID });
});

it.each(['tb_trade_id', 'refund_suit_id', ...REQUIRED_AMOUNTS])(
  '[AC-B1-04z#30] 缺 %s → 跳过该条并告警（带字段名），同页其他维权不受影响',
  async (field) => {
    const s = setup(refundPage([refundRow({ [field]: undefined }), refundOf(2)]));
    const { items } = await refunds(s.adapter);
    expect(items.map((refund) => refund.refund_id)).toEqual([refundOf(2).refund_suit_id]);
    expect(s.refundWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'taobao_refund_row_skipped', field }),
    );
  },
);

it.each([
  ['非数字', 'abc'],
  ['负数', '-0.50'],
  ['空串', ''],
  ['科学计数法', '1e2'],
  ['JSON null', null],
  ['对象', { value: '1.00' }],
])('[AC-B1-04z#31] 必需金额是%s → 跳过该条并告警', async (_name, value) => {
  for (const field of REQUIRED_AMOUNTS) {
    const s = setup(refundPage([refundRow({ [field]: value }), refundOf(2)]));
    const { items } = await refunds(s.adapter);
    expect(
      items.map((refund) => refund.refund_id),
      field,
    ).toEqual([refundOf(2).refund_suit_id]);
    expect(s.refundWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'taobao_refund_row_skipped', field }),
    );
  }
});

it.each([
  ['空串', ''],
  ['空白', '   '],
  ['JSON null', null],
  ['对象', { id: TRADE_ID }],
])('[AC-B1-04z#32] tb_trade_id / refund_suit_id 是%s → 跳过该条并告警', async (_name, value) => {
  for (const field of ['tb_trade_id', 'refund_suit_id']) {
    const s = setup(refundPage([refundRow({ [field]: value }), refundOf(2)]));
    const { items } = await refunds(s.adapter);
    expect(
      items.map((refund) => refund.refund_id),
      field,
    ).toEqual([refundOf(2).refund_suit_id]);
    expect(s.refundWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'taobao_refund_row_skipped', field }),
    );
  }
});

it('[AC-B1-04zza#44] 佣金取原值、不跳过：tk_commission_fee_refund 0.50（alimm 0.40、agent 0.20）照常返回，base_refund_fen = refund_fen = 50n，不告警跳过', async () => {
  // D10-645 ①：tk_commission_fee_refund 已不含技术服务费和渠道专项服务费，取原值，不再减
  // tk_commission_alimm_refund_fee / tk_commission_agent_refund_fee。旧口径 0.50 − 0.40 − 0.20 为负会跳过并
  // 告警（即 [AC-B1-04z#33] 表里删去的 base_refund_fen 那一行，D10-682 取 B），这里钉它照常返回。
  const s = setup(
    refundPage([
      refundRow({
        tk_commission_fee_refund: '0.50',
        tk_commission_alimm_refund_fee: '0.40',
        tk_commission_agent_refund_fee: '0.20',
      }),
      refundOf(2),
    ]),
  );
  const { items } = await refunds(s.adapter);
  expect(items.map((refund) => refund.refund_id)).toEqual([REFUND_ID, refundOf(2).refund_suit_id]);
  expect(items[0]).toMatchObject({
    base_refund_fen: 50n,
    refund_fen: 50n,
    subsidy_refund_fen: 100n,
  });
  for (const event of ['taobao_refund_negative', 'taobao_refund_row_skipped']) {
    expect(s.refundWarn).not.toHaveBeenCalledWith(expect.objectContaining({ event }));
  }
  {
    // 第二段（D10-689 照 D10-669，由原 [AC-B1-04z#33] 保留块并入，输入与断言逐字搬来）：
    // subsidy_refund_fen 算出负数 → 跳过该条并告警，不出负数。
    const s = setup(
      refundPage([
        refundRow({
          tk_subsidy_fee_refund: '0.10',
          tk_subsidy_alimm_refund_fee: '0.08',
          tk_subsidy_agent_refund_fee: '0.03',
        }),
        refundOf(2),
      ]),
    );
    const { items } = await refunds(s.adapter);
    expect(items.map((refund) => refund.refund_id)).toEqual([refundOf(2).refund_suit_id]);
    expect(items.every((refund) => refund.refund_fen >= 0n)).toBe(true);
    expect(s.refundWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'taobao_refund_negative', field: 'subsidy_refund_fen' }),
    );
  }
});

it.each([
  ['null', null],
  ['字符串', 'not-a-row'],
  ['数字', num('1')],
  ['数组', [refundRow()]],
] as const)('[AC-B1-04z#34] result 里不是对象的条目（%s）跳过并告警', async (_name, input) => {
  const s = setup(refundPage([input, refundOf(2)]));
  const { items } = await refunds(s.adapter);
  expect(items.map((refund) => refund.refund_id)).toEqual([refundOf(2).refund_suit_id]);
  expect(s.refundWarn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_refund_row_skipped' }),
  );
});

it.each([
  ['「--」', '--'],
  ['缺失', undefined],
  ['JSON null', null],
  ['不是时间', '2026-13-01 00:00:00'],
  ['不是北京时间文本', '2026-10-30T10:20:00Z'],
])('[AC-B1-04z#35] 平台时间%s → null，维权照常返回', async (_name, value) => {
  const refund = await oneRefund(
    refundRow({
      tk_refund_time: value,
      tk_refund_suit_time: value,
      modified_time: value,
      earning_time: value,
    }),
  );
  expect(refund).toMatchObject({
    refund_fen: 799n,
    refund_created_at: null,
    refund_finished_at: null,
    modified_at: null,
    earning_at: null,
  });
});

it('[AC-B1-04z#36] 平台时间各自独立：只缺维权完成时间时其余照常换算', async () => {
  const refund = await oneRefund(refundRow({ tk_refund_suit_time: '--' }));
  expect(refund.refund_finished_at).toBeNull();
  expect(refund.refund_created_at).toEqual(beijingDate('2026-10-30 10:20:00'));
  expect(refund.modified_at).toEqual(beijingDate('2026-10-30 10:55:30'));
  expect(refund.earning_at).toEqual(beijingDate('2026-10-30 10:40:00'));
});

it.each([
  ['JSON 数字', num('11'), '11'],
  ['字符串', '13', '13'],
  ['缺失', undefined, null],
  ['JSON null', null, null],
])('[AC-B1-04z#37] refund_status 是%s → %s', async (_name, value, expected) => {
  const refund = await oneRefund(refundRow({ refund_status: value }));
  expect(refund.refund_status).toBe(expected);
  expect(refund.refund_fen).toBe(799n);
});

it.each([
  ['缺失', undefined],
  ['「--」', '--'],
  ['非数字', 'abc'],
  ['负数', '-1.00'],
])(
  '[AC-B1-04z#38] show_return_fee %s → show_return_fen 为 null，金额照常',
  async (_name, value) => {
    const refund = await oneRefund(refundRow({ show_return_fee: value }));
    expect(refund.show_return_fen).toBeNull();
    expect(refund).toMatchObject({
      refund_fen: 799n,
      base_refund_fen: 799n,
      subsidy_refund_fen: 100n,
    });
  },
);

it('[AC-B1-04z#39] 不映射 refund_fee / tb_trade_finish_price / day / refund_day / tb_trade_parent_id', async () => {
  const refund = await oneRefund(refundRow());
  const printed = visible(refund);
  for (const marker of ['8880', '88.80', '2026-10-30"', '2900000000000000100']) {
    expect(printed).not.toContain(marker);
  }
  for (const key of ['refund_fee', 'tb_trade_finish_price', 'day', 'refund_day', 'paid_fen']) {
    expect(refund).not.toHaveProperty(key);
  }
});

it('[AC-B1-04z#40] 告警不带订单号、维权号、金额与凭据', async () => {
  const s = setup(
    refundPage([
      refundRow({ tk_commission_fee_refund: 'abc' }),
      // 补贴差为负而跳过（佣金按 D10-645 ①取原值，不再因服务费减成负数；旧实现会在佣金这步
      // 就以 base_refund_fen 跳过，下面的 subsidy_refund_fen 告警断言因此在旧实现上为红，D10-206）。
      refundRow({
        tb_trade_id: '2900000000000000901',
        refund_suit_id: '3300000000000000901',
        tk_commission_fee_refund: '0.50',
        tk_commission_alimm_refund_fee: '0.40',
        tk_commission_agent_refund_fee: '0.20',
        tk_subsidy_fee_refund: '0.50',
        tk_subsidy_alimm_refund_fee: '0.40',
        tk_subsidy_agent_refund_fee: '0.20',
      }),
      refundRow({ tb_trade_id: '2900000000000000902', refund_suit_id: undefined }),
    ]),
  );
  const { items } = await refunds(s.adapter);
  expect(items).toEqual([]);
  expect(s.refundWarn).toHaveBeenCalled();
  expect(s.refundWarn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_refund_negative', field: 'subsidy_refund_fen' }),
  );
  const printed = visible(s.refundWarn.mock.calls);
  for (const marker of [
    TRADE_ID,
    REFUND_ID,
    '2900000000000000901',
    '3300000000000000901',
    '2900000000000000902',
    '0.50',
    '0.40',
    'abc',
    'dtk-dtk',
    'fake-dataoke-key',
  ]) {
    expect(printed).not.toContain(marker);
  }
});
