// B1-04zz（BR-CALC-03、BR-CALC-18、D10-105、D10-588）：淘宝订单 N 净额的合成报文。字段名与形状来自任务书，
// 值都是自拟的，不是录制原值。金额口径：佣金与补贴分字段，服务费单列。
//   预估：pub_share_pre_fee 12.00 = 佣金 10.00 + 补贴 2.00，预估服务费 1.00 → est 900
//   结算：pub_share_fee 10.50 = 佣金 9.00 + 补贴 1.50，结算服务费 0.80 → settle 820
import { num, rowOf } from '../taobao-orders/kit.ts';

const NET_AMOUNTS: Readonly<Record<string, unknown>> = {
  pub_share_pre_fee: '12.00',
  pub_share_pre_fee_for_commission: num('10.00'),
  pub_share_pre_fee_for_sdy: num('2.00'),
  pub_share_fee: '10.50',
  pub_share_fee_for_commission: num('9.00'),
  pub_share_fee_for_sdy: num('1.50'),
  alimama_share_fee: '0.30',
  alimm_share_info_dto: {
    alimm_tech_service_pre_fee: num('1.00'),
    alimm_tech_service_fee: num('0.80'),
  },
};

/** A settled row (tk_status 3) carrying every amount field; undefined drops a field. */
export function netRow(
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...rowOf(index), ...NET_AMOUNTS, ...overrides };
}

/** A paid row (tk_status 12): nothing settled yet, the settlement amounts are zero or "--". */
export function paidRow(
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return netRow(index, {
    tk_status: num('12'),
    tk_earning_time: '--',
    pub_share_fee: '0.00',
    pub_share_fee_for_commission: num('0'),
    pub_share_fee_for_sdy: num('0'),
    ...overrides,
  });
}
