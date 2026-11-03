// B1-04zw（D10-522，与京东同一套），B1-04zz 改口径（D10-588）：必需金额为负不再跳过整行。
// pub_share_pre_fee_for_commission 减预估服务费的负值留在 est_commission_fen，commission_fen、paid_fen
// 必填非负，收到 0；原值留在归档报文。kit 的预估服务费 0.50、结算服务费 1.00。
import { expect, it } from 'vitest';
import { num, rowOf } from '../taobao-orders/kit.ts';
import { forms, MODES, NEGATIVE, orderOf, throughAdapter } from './negative-wire.ts';

/** 未结算的行：预估正是这个阶段用的，pub_share_fee 的 "0.00" 不当结算佣金。 */
const UNSETTLED = { tk_status: num('12'), tk_earning_time: '--', pub_share_fee: '0.00' };

/** 已结算行要有结算佣金字段（kit 的默认行没有）：7.66 − 1.00 = 666 分，与原来的期望值相同。 */
function settled(index: number): Record<string, unknown> {
  return { ...rowOf(index), pub_share_fee_for_commission: '7.66' };
}

it.each(NEGATIVE)(
  '[AC-B1-04zw#3] pub_share_pre_fee_for_commission「%s」（两种开关）→ est_commission_fen 是 %s 分减 50，commission_fen 0n，行不跳过、不进 rejected',
  async (text, fen) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const negative = {
          ...settled(2),
          pub_share_pre_fee: value,
          pub_share_pre_fee_for_commission: value,
        };
        const page = await throughAdapter([settled(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          est_commission_fen: fen - 50n,
          commission_fen: 0n,
          settle_commission_fen: 666n,
          paid_fen: 8880n,
        });
      }
    }
  },
);

it.each(NEGATIVE)(
  '[AC-B1-04zw#3] 未结算行 pub_share_pre_fee_for_commission「%s」（两种开关）→ est_commission_fen 是 %s 分减 50，commission_fen 0n，settle 仍 null，行不跳过、不进 rejected',
  async (text, fen) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const negative = {
          ...rowOf(2),
          ...UNSETTLED,
          pub_share_pre_fee: value,
          pub_share_pre_fee_for_commission: value,
        };
        const page = await throughAdapter([settled(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          est_commission_fen: fen - 50n,
          commission_fen: 0n,
          settle_commission_fen: null,
          paid_fen: 8880n,
        });
      }
    }
  },
);

it.each(MODES)(
  '[AC-B1-04zw#3] $mode：预估与结算都为负：各自保留，commission_fen 0n',
  async ({ call }) => {
    const negative = {
      ...rowOf(2),
      pub_share_pre_fee_for_commission: '-2.00',
      pub_share_fee_for_commission: '-1.00',
    };
    const page = await throughAdapter([negative], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, negative)).toMatchObject({
      est_commission_fen: -250n,
      settle_commission_fen: -200n,
      commission_fen: 0n,
    });
  },
);

it.each(NEGATIVE)(
  '[AC-B1-04zw#4] alipay_total_price「%s」（两种开关）→ paid_fen 0n，行不跳过、不进 rejected',
  async (text) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const negative = { ...settled(2), alipay_total_price: value };
        const page = await throughAdapter([settled(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          paid_fen: 0n,
          est_commission_fen: 724n,
          commission_fen: 724n,
          settle_commission_fen: 666n,
        });
      }
    }
  },
);

it.each(NEGATIVE)(
  '[AC-B1-04zw#4] 未结算行 alipay_total_price「%s」（两种开关）→ paid_fen 0n，预估照常，settle 仍 null，行不跳过、不进 rejected',
  async (text) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const negative = { ...rowOf(2), ...UNSETTLED, alipay_total_price: value };
        const page = await throughAdapter([settled(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          paid_fen: 0n,
          est_commission_fen: 724n,
          commission_fen: 724n,
          settle_commission_fen: null,
        });
      }
    }
  },
);
