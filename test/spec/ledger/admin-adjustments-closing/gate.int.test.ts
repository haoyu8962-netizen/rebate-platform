// B2-12d closing gate (claude-independent): BR-FUND-24 ⑧ (须在注销 done 前完成，未完成告警), 细则「注销调减
// 单被驳回与注销中的调账」(D10-590 ③: 驳回后注销完成门继续 pending 并照常告警；处理轮次发现门为 pending 且该用户
// 没有待批的 ACCOUNT_CLOSED 单时，每个会计日补建一张（同一预填口径）；只允许红冲 ACCOUNT_CLOSED 调减单本身：红冲后
// 余额回来、门转 pending，次日按上句补建), adminRejectAdjustment (the next accounting day the deletion
// processing prefills a new form while none is PENDING) and BR-ID-28. The worker entry's deletion
// runner judges the gate with whatever port app.module assembles; approvals, rejections and the
// reversal go through the admin entry. Requests are processing with cleanup and Apple finished
// (fixture), so each round goes straight to the completion transaction. Accounting days: NOW is
// 2026-11-30 10:30 +08:00; prefilled forms of the fixture were created at 09:30 the same day.
// Amounts by hand in each test.
import { expect, it } from 'vitest';
import {
  ADJUST,
  ADJUSTMENT_PENDING,
  DAY_MS,
  TIMEOUT,
  answer,
  balanceOf,
  expectApproved,
  expectPrefilled,
  expectRejected,
  fixture,
  formsOf,
  inboxOf,
  member,
  moneyOf,
  pendingClosing,
  requestNow,
  seedPrefill,
  seedRequest,
  settleOpenDeletions,
  suite,
  userStatusOf,
  withClosingAdmin,
  withDeletionWorker,
  type AdjustFixture,
} from './kit.ts';

const s = suite();
const REASON = '核对后金额有误，次日按补建的新单处理';

async function inDeletion(f: AdjustFixture, available: bigint, prefilled = true) {
  const userId = await member(f, { available, status: 'deleting' });
  const request = await seedRequest(f, userId);
  const form = prefilled
    ? await seedPrefill(f, userId, {
        refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
      })
    : undefined;
  return { userId, request, form };
}

async function expectStillProcessing(f: AdjustFixture, requestId: string, userId: string) {
  expect((await requestNow(f, requestId)).status, requestId).toBe('processing');
  expect(await userStatusOf(f, userId)).toBe('deleting');
}

async function expectDone(f: AdjustFixture, requestId: string, userId: string) {
  expect((await requestNow(f, requestId)).status, requestId).toBe('done');
  expect(await userStatusOf(f, userId)).toBe('deleted');
  expect(await moneyOf(f, userId)).toEqual({ available: 0n, frozen: 0n });
}

it(
  '[AC-B2-12d#19] 预填单未批：注销不到 done，每个会计日告警一次，单仍只有一张；批准（余额 2000 → 0，不发站内信）后下一轮完成注销',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        const { userId, request, form } = await inDeletion(f, 2000n);
        await w.round();
        f.clock.advanceMs(3_600_000);
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);
        f.clock.advanceMs(DAY_MS);
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(2);
        expect(await formsOf(f, userId)).toEqual([form]);

        // h.maker's session is past its idle / absolute limit by now: a fresh fund.adjust session.
        const approver = await h.caller([ADJUST]);
        await expectApproved(f, await h.approve(form!.adjust_id, { caller: approver }), {
          caller: approver,
          form: form!,
          amount: 2000n,
        });
        f.clock.advanceMs(60_000);
        await w.round();
        await expectDone(f, request.id, userId);
        expect(await inboxOf(f, userId)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#20] 门看待批单而不只看余额：余额已为 0 但还有待批的 ACCOUNT_CLOSED 单 → 注销不到 done 并告警；驳回该单后（余额 0、无待批单）下一轮完成，且不补建',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        const { userId, request, form } = await inDeletion(f, 0n);
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);

        await expectRejected(f, await h.reject(form!.adjust_id, { reason: REASON }), {
          caller: h.maker,
          form: form!,
          note: REASON,
          available: 0n,
        });
        f.clock.advanceMs(60_000);
        await w.round();
        await expectDone(f, request.id, userId);
        expect(await pendingClosing(f, userId)).toEqual([]);
        expect(await formsOf(f, userId)).toHaveLength(1);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#21] D10-590 ③ 驳回后：门继续 pending 并告警；当日不补建；次日补建恰好一张（同一预填口径），同日再跑不重复；再驳回，当日仍不补建、再次日又补建一张；批准后完成注销',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        const { userId, request, form } = await inDeletion(f, 1500n);
        await expectRejected(f, await h.reject(form!.adjust_id, { reason: REASON }), {
          caller: h.maker,
          form: form!,
          note: REASON,
          available: 1500n,
        });
        f.clock.advanceMs(60_000);
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);
        expect(await formsOf(f, userId), 'no new form the day of the rejection').toHaveLength(1);

        // The next accounting day (2026-12-01).
        f.clock.advanceMs(DAY_MS);
        await w.round();
        const rebuiltAt = f.clock.now();
        await expectStillProcessing(f, request.id, userId);
        const second = await pendingClosing(f, userId);
        expect(second, 'one rebuilt form').toHaveLength(1);
        const rebuilt = expectPrefilled(f, second[0], {
          userId,
          requestId: request.id,
          at: rebuiltAt,
        });
        f.clock.advanceMs(3_600_000);
        await w.round();
        expect(await formsOf(f, userId)).toHaveLength(2);
        expect(await pendingClosing(f, userId)).toEqual([rebuilt]);

        // A fresh fund.adjust session after the clock moved (admin session: 30 min idle, 8 h).
        const rejecter = await h.caller([ADJUST]);
        await expectRejected(
          f,
          await h.reject(rebuilt.adjust_id, { reason: REASON }, { caller: rejecter }),
          {
            caller: rejecter,
            form: rebuilt,
            note: REASON,
            available: 1500n,
          },
        );
        f.clock.advanceMs(60_000);
        await w.round();
        expect(
          await formsOf(f, userId),
          'no new form the day of the second rejection',
        ).toHaveLength(2);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(2);

        // 2026-12-02.
        f.clock.advanceMs(DAY_MS);
        await w.round();
        const third = await pendingClosing(f, userId);
        expect(third).toHaveLength(1);
        const last = expectPrefilled(f, third[0], {
          userId,
          requestId: request.id,
          at: f.clock.now(),
        });
        expect(await formsOf(f, userId)).toHaveLength(3);
        await expectStillProcessing(f, request.id, userId);

        const approver = await h.caller([ADJUST]);
        await expectApproved(f, await h.approve(last.adjust_id, { caller: approver }), {
          caller: approver,
          form: last,
          amount: 1500n,
        });
        f.clock.advanceMs(60_000);
        await w.round();
        await expectDone(f, request.id, userId);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#22] 本单上线前已进 processing、从没有预填单的注销（available=800）：处理轮次补建一张预填单并告警、不完成；同日再跑不重复；批准后完成',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        const { userId, request } = await inDeletion(f, 800n, false);
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);
        const forms = await formsOf(f, userId);
        expect(forms).toHaveLength(1);
        const form = expectPrefilled(f, forms[0], {
          userId,
          requestId: request.id,
          at: f.clock.now(),
        });
        f.clock.advanceMs(3_600_000);
        await w.round();
        expect(await formsOf(f, userId)).toEqual([form]);
        expect(await moneyOf(f, userId)).toEqual({ available: 800n, frozen: 0n });

        const approver = await h.caller([ADJUST]);
        await expectApproved(f, await h.approve(form.adjust_id, { caller: approver }), {
          caller: approver,
          form,
          amount: 800n,
        });
        f.clock.advanceMs(60_000);
        await w.round();
        await expectDone(f, request.id, userId);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#23] 批准后被红冲（B2-12c 的提交接口，余额 0 → 2000）：门回到 pending、注销不完成并告警；当日不补建，次日补建一张；批准新单后完成注销',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        const { userId, request, form } = await inDeletion(f, 2000n);
        await expectApproved(f, await h.approve(form!.adjust_id), {
          caller: h.maker,
          form: form!,
          amount: 2000n,
        });
        const reversed = await h.create({
          reverses_adjust_id: form!.adjust_id,
          note: '注销调减单误批，整笔冲回',
        });
        await answer(reversed, 0);
        expect((await balanceOf(f, userId))?.available_fen).toBe(2000n);

        f.clock.advanceMs(60_000);
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);
        expect(await pendingClosing(f, userId), 'no new form the day of the reversal').toEqual([]);
        expect(await formsOf(f, userId)).toHaveLength(2);

        f.clock.advanceMs(DAY_MS);
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        const rebuilt = await pendingClosing(f, userId);
        expect(rebuilt).toHaveLength(1);
        const fresh = expectPrefilled(f, rebuilt[0], {
          userId,
          requestId: request.id,
          at: f.clock.now(),
        });
        expect(await formsOf(f, userId)).toHaveLength(3);

        const approver = await h.caller([ADJUST]);
        await expectApproved(f, await h.approve(fresh.adjust_id, { caller: approver }), {
          caller: approver,
          form: fresh,
          amount: 2000n,
        });
        f.clock.advanceMs(60_000);
        await w.round();
        await expectDone(f, request.id, userId);
      });
    });
  },
  TIMEOUT,
);
