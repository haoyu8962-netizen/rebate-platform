// B1-04zw（D10-522，与京东同一套）：必需金额为负不再跳过整行。pub_share_pre_fee 的负值留在
// est_commission_fen，commission_fen、paid_fen 必填非负，收到 0；原值留在归档报文。
import { expect, it } from 'vitest';
import { num, rowOf } from '../taobao-orders/kit.ts';
import { forms, MODES, NEGATIVE, orderOf, throughAdapter } from './negative-wire.ts';

/** 未结算的行：预估正是这个阶段用的，pub_share_fee 的 "0.00" 不当结算佣金。 */
const UNSETTLED = { tk_status: num('12'), tk_earning_time: '--', pub_share_fee: '0.00' };

it.each(NEGATIVE)(
  '[AC-B1-04zw#3] pub_share_pre_fee「%s」（两种开关）→ est_commission_fen %s 分，commission_fen 0n，行不跳过、不进 rejected',
  async (text, fen) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const negative = { ...rowOf(2), pub_share_pre_fee: value };
        const page = await throughAdapter([rowOf(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          est_commission_fen: fen,
          commission_fen: 0n,
          settle_commission_fen: 666n,
          paid_fen: 8880n,
        });
      }
    }
  },
);

it.each(NEGATIVE)(
  '[AC-B1-04zw#3] 未结算行 pub_share_pre_fee「%s」（两种开关）→ est_commission_fen %s 分，commission_fen 0n，settle 仍 null，行不跳过、不进 rejected',
  async (text, fen) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const negative = { ...rowOf(2), ...UNSETTLED, pub_share_pre_fee: value };
        const page = await throughAdapter([rowOf(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          est_commission_fen: fen,
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
    const negative = { ...rowOf(2), pub_share_pre_fee: '-2.00', pub_share_fee: '-1.00' };
    const page = await throughAdapter([negative], call);
    expect(page.rejected).toEqual([]);
    expect(orderOf(page.items, negative)).toMatchObject({
      est_commission_fen: -200n,
      settle_commission_fen: -100n,
      commission_fen: 0n,
    });
  },
);

it.each(NEGATIVE)(
  '[AC-B1-04zw#4] alipay_total_price「%s」（两种开关）→ paid_fen 0n，行不跳过、不进 rejected',
  async (text) => {
    for (const { call } of MODES) {
      for (const value of forms(text)) {
        const negative = { ...rowOf(2), alipay_total_price: value };
        const page = await throughAdapter([rowOf(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          paid_fen: 0n,
          est_commission_fen: 799n,
          commission_fen: 799n,
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
        const page = await throughAdapter([rowOf(1), negative], call);
        expect(page.rejected).toEqual([]);
        expect(page.warned).not.toContainEqual(
          expect.objectContaining({ event: 'taobao_order_row_skipped' }),
        );
        expect(orderOf(page.items, negative)).toMatchObject({
          paid_fen: 0n,
          est_commission_fen: 799n,
          commission_fen: 799n,
          settle_commission_fen: null,
        });
      }
    }
  },
);
