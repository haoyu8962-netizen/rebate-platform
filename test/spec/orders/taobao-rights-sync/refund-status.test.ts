// 淘宝维权状态与应扣佣金（编排 D10-645，09 2_TB 2026-11-05 条，文档事实：refund_status 4 维权创建、11 多次维权
// 待处理、2 维权成功、3 维权失败、12 / 13 从淘客处补扣（钱已结给淘客）等待扣款 / 扣款成功、14 / 15 从卖家处补扣
// （钱已结给卖家）等待扣款 / 扣款成功；tk_commission_fee_refund 为「应退还佣金(不含技术服务费和渠道专项服务费)」，
// 两项服务费另列，文档样例 0.71 与 0.06 分列）。状态在联盟适配器归一成 UnionRefund.rights_status（订单模块不读
// 平台码，apps/api/src/modules/orders/AGENTS.md 硬规则 1）：4 / 11 → PROCESSING，2 / 12 / 13 → SUCCEEDED，
// 3 → FAILED，14 / 15 → CLOSED_NO_CHARGE（结束且不扣我方）；缺失或别的码 → null，不得当成功。
// 报文经 test/spec/union/taobao-refunds/kit.ts 的合成大淘客上游（外层形状同录制、值是掩码形状的合成值）。
import { expect, it } from 'vitest';
import {
  num,
  oneRefund,
  refundOf,
  refundPage,
  refundRow,
  refunds,
  setup,
} from '../../union/taobao-refunds/kit.ts';

it.each([
  ['4', 'PROCESSING'],
  ['11', 'PROCESSING'],
  ['2', 'SUCCEEDED'],
  ['12', 'SUCCEEDED'],
  ['13', 'SUCCEEDED'],
  ['3', 'FAILED'],
  ['14', 'CLOSED_NO_CHARGE'],
  ['15', 'CLOSED_NO_CHARGE'],
] as const)(
  '[AC-B1-04zza#1] refund_status %s → rights_status %s（JSON 数字与字符串同口径，原码照留）',
  async (code, expected) => {
    for (const value of [num(code), code]) {
      const refund = await oneRefund(refundRow({ refund_status: value }));
      expect(refund.rights_status).toBe(expected);
      expect(refund.refund_status).toBe(code);
    }
  },
);

it.each([
  ['缺失', undefined],
  ['JSON null', null],
  ['「--」', '--'],
  ['未列出的码 1', num('1')],
  ['未列出的码 5', '5'],
  ['未列出的码 99', num('99')],
  ['非数字', 'abc'],
] as const)(
  '[AC-B1-04zza#2] refund_status %s → rights_status 为 null（不当成功），维权照常返回',
  async (_name, value) => {
    const refund = await oneRefund(refundRow({ refund_status: value }));
    expect(refund.rights_status).toBeNull();
    expect(refund.rights_status).not.toBe('SUCCEEDED');
    expect(refund.refund_id).toBe(refundRow().refund_suit_id);
  },
);

it('[AC-B1-04zza#3] 应扣佣金取 tk_commission_fee_refund 原值：文档样例佣金 0.71、服务费 0.06 分列，不得相减', async () => {
  const refund = await oneRefund(
    refundRow({
      tk_commission_fee_refund: '0.71',
      tk_commission_alimm_refund_fee: '0.06',
      tk_commission_agent_refund_fee: '0.00',
    }),
  );
  expect(refund.refund_fen).toBe(71n);
  expect(refund.base_refund_fen).toBe(71n);
  // 0.71 − 0.06 的结果不得出现。
  expect([refund.refund_fen, refund.base_refund_fen]).not.toContain(65n);
});

it('[AC-B1-04zza#4] 两项服务费都不扣：渠道专项服务费也不从应扣佣金里减', async () => {
  const refund = await oneRefund(
    refundRow({
      tk_commission_fee_refund: num('0.71'),
      tk_commission_alimm_refund_fee: num('0.06'),
      tk_commission_agent_refund_fee: num('0.05'),
    }),
  );
  expect(refund.refund_fen).toBe(71n);
  expect(refund.base_refund_fen).toBe(71n);
});

it('[AC-B1-04zza#5] 补贴退款不进应扣佣金：tk_subsidy_fee_refund 再大，refund_fen 仍是佣金原值', async () => {
  const refund = await oneRefund(
    refundRow({
      tk_commission_fee_refund: '0.71',
      tk_commission_alimm_refund_fee: '0.06',
      tk_commission_agent_refund_fee: '0.00',
      tk_subsidy_fee_refund: '50.00',
      tk_subsidy_alimm_refund_fee: '0.00',
      tk_subsidy_agent_refund_fee: '0.00',
    }),
  );
  expect(refund.refund_fen).toBe(71n);
  expect(refund.base_refund_fen).toBe(71n);
});

it('[AC-B1-04zza#6] 服务费大于应退佣金也不跳过：应扣佣金照原值，不告警成负数', async () => {
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
  expect(items.map((refund) => [refund.refund_id, refund.refund_fen])).toEqual([
    [refundRow().refund_suit_id, 50n],
    [refundOf(2).refund_suit_id, 799n],
  ]);
  expect(s.refundWarn).not.toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_refund_negative', field: 'base_refund_fen' }),
  );
});
