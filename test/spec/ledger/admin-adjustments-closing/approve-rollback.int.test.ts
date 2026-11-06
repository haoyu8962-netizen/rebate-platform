// B2-12d approval in one transaction (claude-independent; spec-test r1 S1 on approve.int.test.ts:50):
// adminApproveAdjustment "Effects, in one transaction under the member's balance lock" — the form
// becoming APPROVED with its amount, reviewer and voucher_id, the voucher ADJ:{adjust_id}
// (ADMIN_ADJUST / ACCOUNT_CLOSED), both entries, the balance and the adjustment_approve audit record
// commit together (BR-FUND-24 ①「批准时在同一事务内重读余额并写凭证」「全程写 audit_logs」).
// A one-shot failure late in the approval — the form write after the voucher was inserted, or the
// audit insert — answers 50001 and leaves everything as it was before the request: the form still
// PENDING without amount, no voucher, no entry, the balance, events, inbox and audit_logs row for
// row. Then the same Idempotency-Key (a fresh sms-tier token: the token is a header, not part of the
// body hash) approves with exactly one whole effect, and a replay returns the same result without a
// second one. Amounts by hand: 1800 → amount 1800, available 0.
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  TIMEOUT,
  adjustVouchers,
  answer,
  audits,
  expectApproveAudit,
  expectApproved,
  fixture,
  formNow,
  member,
  moneyOf,
  newIdemKey,
  seedPrefill,
  seedRequest,
  suite,
  trace,
  withClosingAdmin,
} from './kit.ts';
import { voucherByKey } from '../admin-adjustments/kit.ts';
import { approvalFault, userLines, type ApprovalFaultPoint } from './kit-r2.ts';

const s = suite();

const POINTS: readonly ApprovalFaultPoint[] = ['form', 'audit'];

it.each(POINTS)(
  '[AC-B2-12d#26] 批准事务后段失败（%s）→ 50001，调账单、凭证、全部分录、余额与审计整体回到批准前；同一 key 重试后恰好一次完整效果，再重放不再生效',
  async (point) => {
    const f = fixture(s);
    const userId = await member(f, { available: 1800n, status: 'deleting' });
    const request = await seedRequest(f, userId);
    const form = await seedPrefill(f, userId, {
      refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
    });
    const fault = approvalFault(form.adjust_id, point);
    await withClosingAdmin({ ...f, db: f.db.withPlugin(fault.plugin) }, async (h) => {
      const before = await trace(f);
      const auditsBefore = await audits(f);
      const linesBefore = await userLines(f, userId);
      expect(linesBefore.map((line) => line.amount_fen)).toEqual([-1800n]);
      const key = newIdemKey();

      const failed = await h.approve(form.adjust_id, { key });
      expect(fault.tripped, `${point} 必须在批准事务里、在写凭证之后执行`).toBe(1);
      await answer(failed, 50001);
      expect(await trace(f), point).toEqual(before);
      expect(await audits(f), `${point}：失败后 audit_logs 不变`).toEqual(auditsBefore);
      expect(await formNow(f, form.adjust_id)).toEqual(form);
      expect(await voucherByKey(f, `ADJ:${form.adjust_id}`)).toBeUndefined();
      expect(await userLines(f, userId)).toEqual(linesBefore);
      expect(await moneyOf(f, userId)).toEqual({ available: 1800n, frozen: 0n });

      const retried = await h.approve(form.adjust_id, { key });
      await expectApproved(f, retried, { caller: h.maker, form, amount: 1800n });
      await expectApproveAudit(f, { caller: h.maker, form, amount: 1800n });
      const after = await trace(f);
      const auditsAfter = await audits(f);
      expect(auditsAfter.filter((row) => row.action === APPROVE_ACTION)).toHaveLength(1);
      expect(auditsAfter).toHaveLength(auditsBefore.length + 1);
      expect((await adjustVouchers(f)).map((voucher) => voucher.uniq_key)).toEqual([
        `ADJ:${form.adjust_id}`,
      ]);
      const lines = await userLines(f, userId);
      expect(lines.filter((line) => line.uniq_key === `ADJ:${form.adjust_id}`)).toEqual([
        { uniq_key: `ADJ:${form.adjust_id}`, amount_fen: 1800n },
      ]);
      expect(lines).toHaveLength(2);

      const replay = await h.approve(form.adjust_id, { key });
      await answer(replay, 0, retried.json().data);
      expect(await trace(f)).toEqual(after);
      expect(await audits(f)).toEqual(auditsAfter);
      expect(await moneyOf(f, userId)).toEqual({ available: 0n, frozen: 0n });
    });
  },
  TIMEOUT,
);
