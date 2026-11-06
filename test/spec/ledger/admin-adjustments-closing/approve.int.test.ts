// B2-12d approval (claude-independent): contracts/openapi.yaml adminApproveAdjustment with 08
// BR-FUND-24 ①⑥⑧ (金额在批准时按当时 available 取；借 USER_BALANCE.available / 贷 COMMISSION_REVENUE；注销
// 用户不发站内信) and its order of checks after the guard: unknown adjust_id or a form of another app
// (20001 data.fields=[adjust_id], no 404) → no longer PENDING (20902 data.resource=admin_adjustment)
// → the balance read again: not above 0 is 20001 data.reason=adjust_no_balance, nothing written,
// the form stays PENDING. Members are in deletion (users.status deleting, a processing request);
// the forms are prefilled as the system leaves them (B2-12c kit seedPrefill).
// Amounts by hand: prefilled at 2000, the balance moves to 2500 after the preview → the approval
// takes 2500 and leaves 0; a refused approval at 0 or −300 moves nothing; 0 → +100 later approves
// 100.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  TIMEOUT,
  answer,
  audits,
  conflict,
  expectApproveAudit,
  expectApproved,
  fixture,
  formNow,
  invalid,
  member,
  moneyOf,
  newAppId,
  noBalance,
  seedForm,
  seedPrefill,
  seedRequest,
  shift,
  suite,
  trace,
  withClosingAdmin,
  type AdjustFixture,
} from './kit.ts';

const s = suite();

async function inDeletion(f: AdjustFixture, available: bigint, appId?: string) {
  const fx = appId === undefined ? f : { ...f, appId };
  const userId = await member(fx, { available, status: 'deleting' });
  const request = await seedRequest(fx, userId);
  const form = await seedPrefill(fx, userId, {
    refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
  });
  return { userId, request, form };
}

it(
  '[AC-B2-12d#7] 批准预填单：金额取批准时的 available（预览后由 2000 变 2500 → 2500）；单变 APPROVED、reviewed_by / reviewed_at 写入、created_by 仍为空；凭证 ADJ:{adjust_id} 按 ADMIN_ADJUST:ACCOUNT_CLOSED（借用户 available / 贷 COMMISSION_REVENUE）；余额归 0；不发站内信；写一条 adjustment_approve 审计',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const { userId, form } = await inDeletion(f, 2000n);
      const preview = await h.detail(form.adjust_id);
      await answer(preview, 0);
      await shift(f, userId, 500n);
      expect(await moneyOf(f, userId)).toEqual({ available: 2500n, frozen: 0n });
      f.clock.advanceMs(5 * 60_000);

      const approved = await expectApproved(f, await h.approve(form.adjust_id), {
        caller: h.maker,
        form,
        amount: 2500n,
      });
      expect(approved.created_by).toBeNull();
      await expectApproveAudit(f, { caller: h.maker, form, amount: 2500n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#8] 批准时余额为 0 或为负（−300）→ 20001 fields=[adjust_id] reason=adjust_no_balance：不写凭证、不动余额、单保持 PENDING 且金额仍空、不写批准审计；余额变正（+100）后同一张单可批，金额 100',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const zero = await inDeletion(f, 0n);
      const negative = await inDeletion(f, 0n);
      await shift(f, negative.userId, -300n);
      const before = await trace(f);

      await noBalance(await h.approve(zero.form.adjust_id));
      await noBalance(await h.approve(negative.form.adjust_id));

      expect(await trace(f)).toEqual(before);
      expect(await formNow(f, zero.form.adjust_id)).toEqual(zero.form);
      expect(await formNow(f, negative.form.adjust_id)).toEqual(negative.form);
      expect(await moneyOf(f, negative.userId)).toEqual({ available: -300n, frozen: 0n });
      expect(await audits(f, APPROVE_ACTION)).toEqual([]);

      await shift(f, zero.userId, 100n);
      await expectApproved(f, await h.approve(zero.form.adjust_id), {
        caller: h.maker,
        form: zero.form,
        amount: 100n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#9] 已不是 PENDING 的单 → 20902 resource=admin_adjustment（已批准的 ACCOUNT_CLOSED 单、已驳回的预填单、人工一步提交的 RECON_FIX 单），什么都不写；同一会员的待批预填单之后照常可批',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const { userId, request, form } = await inDeletion(f, 800n);
      const approvedClosing = await seedForm(f, {
        userId,
        direction: 'decrease',
        amount: 300n,
        reason: 'ACCOUNT_CLOSED',
        refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
        contra: 'COMMISSION_REVENUE',
        note: null,
        status: 'APPROVED',
      });
      const rejected = await seedForm(f, {
        userId,
        direction: 'decrease',
        amount: null,
        reason: 'ACCOUNT_CLOSED',
        refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
        contra: 'COMMISSION_REVENUE',
        note: null,
        status: 'REJECTED',
        createdBy: null,
      });
      const manual = await seedForm(f, {
        userId,
        direction: 'increase',
        amount: 200n,
        reason: 'RECON_FIX',
        contra: 'COMMISSION_REVENUE',
      });
      // 800 + 200 (RECON_FIX) − 300 (ACCOUNT_CLOSED already approved) = 700.
      expect(await moneyOf(f, userId)).toEqual({ available: 700n, frozen: 0n });
      const before = await trace(f);
      for (const done of [approvedClosing, rejected, manual]) {
        await conflict(await h.approve(done.adjust_id));
      }
      expect(await trace(f)).toEqual(before);
      expect(await audits(f, APPROVE_ACTION)).toEqual([]);

      await expectApproved(f, await h.approve(form.adjust_id), {
        caller: h.maker,
        form,
        amount: 700n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#10] 不存在的 adjust_id、形状合法但不是 UUID 的 adjust_id、别的 app 的待批预填单 → 20001 fields=[adjust_id]（不回 404），什么都不写；别的 app 的单仍 PENDING',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const otherApp = newAppId();
      const foreign = await inDeletion(f, 900n, otherApp);
      const mine = await inDeletion(f, 400n);
      const before = await trace(f);
      for (const id of [randomUUID(), 'not-a-uuid', foreign.form.adjust_id]) {
        await invalid(await h.approve(id), ['adjust_id']);
      }
      expect(await trace(f)).toEqual(before);
      expect(await formNow(f, foreign.form.adjust_id, otherApp)).toEqual(foreign.form);
      expect(await formNow(f, mine.form.adjust_id)).toEqual(mine.form);
    });
  },
  TIMEOUT,
);
