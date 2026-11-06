// B2-12d approval of a large balance (claude-independent; spec-test r1 S1 on approve.int.test.ts:55):
// adminApproveAdjustment with BR-FUND-24 ④ (金额不设单笔上限) and ⑧ (金额在批准时按当时 available 取);
// amounts are int64 fen (ADR-0001 §4 金额 JSON 表示: an integer number). Odd balances above 2^31 and
// 2^32 — 2147483649 and 4294967297 fen — catch an int32 / uint32 truncation or a float halving on
// the way: the response, the form, the two signed entries of ADMIN_ADJUST:ACCOUNT_CLOSED and the
// balance are checked against literal values written by hand.
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  answer,
  expectApproved,
  fixture,
  formNow,
  member,
  moneyOf,
  seedPrefill,
  seedRequest,
  suite,
  withClosingAdmin,
} from './kit.ts';
import { entriesOf, voucherByKey } from '../admin-adjustments/kit.ts';

const s = suite();

const CASES: readonly { readonly amount: bigint; readonly digits: string }[] = [
  { amount: 2147483649n, digits: '2147483649' },
  { amount: 4294967297n, digits: '4294967297' },
];

it.each(CASES)(
  '[AC-B2-12d#27] 余额 $digits 分（超过 2^31 / 2^32 的奇数）批准：响应、单据、两条带符号分录与归零余额逐项为精确值',
  async ({ amount, digits }) => {
    const f = fixture(s);
    const userId = await member(f, { available: amount, status: 'deleting' });
    const request = await seedRequest(f, userId);
    const form = await seedPrefill(f, userId, {
      refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
    });
    expect(await moneyOf(f, userId)).toEqual({ available: amount, frozen: 0n });
    await withClosingAdmin(f, async (h) => {
      const sent = await h.approve(form.adjust_id);
      const body = await answer(sent, 0);
      const data = body.data as {
        adjustment: Record<string, unknown>;
        available_before_fen: unknown;
        available_after_fen: unknown;
      };
      // Integers in the JSON text itself, not strings and not rounded.
      expect(sent.body).toContain(`"amount_fen":${digits}`);
      expect(sent.body).toContain(`"available_before_fen":${digits}`);
      expect(sent.body).toContain('"available_after_fen":0');
      expect(data.adjustment['amount_fen']).toBe(Number(digits));
      expect(data.adjustment['status']).toBe('APPROVED');
      expect(data.adjustment['reason_code']).toBe('ACCOUNT_CLOSED');
      expect(data.adjustment['direction']).toBe('decrease');
      expect(data.available_before_fen).toBe(Number(digits));
      expect(data.available_after_fen).toBe(0);

      const row = await formNow(f, form.adjust_id);
      expect(row?.amount_fen).toBe(amount);
      expect(row?.status).toBe('APPROVED');
      expect(row?.reviewed_by).toBe(h.maker.id);
      expect(data.adjustment['voucher_id']).toBe(row?.voucher_id);

      const uniq = `ADJ:${form.adjust_id}`;
      expect((await voucherByKey(f, uniq))?.id).toBe(row?.voucher_id);
      expect(await entriesOf(f, uniq)).toEqual([
        {
          owner_type: 'platform',
          owner_id: 'platform',
          subject: 'COMMISSION_REVENUE',
          sub_account: 'available',
          amount_fen: -amount,
          ledger_type: 'ADMIN_ADJUST',
          sub_type: 'ACCOUNT_CLOSED',
        },
        {
          owner_type: 'user',
          owner_id: userId,
          subject: 'USER_BALANCE',
          sub_account: 'available',
          amount_fen: amount,
          ledger_type: 'ADMIN_ADJUST',
          sub_type: 'ACCOUNT_CLOSED',
        },
      ]);
      expect(await moneyOf(f, userId)).toEqual({ available: 0n, frozen: 0n });
      // The kit's whole check of an approval (form, response view, voucher, template, no message).
      await expectApproved(f, sent, { caller: h.maker, form, amount });
    });
  },
  TIMEOUT,
);
