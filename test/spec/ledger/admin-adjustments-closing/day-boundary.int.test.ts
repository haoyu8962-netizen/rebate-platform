// B2-12d accounting-day boundaries (claude-independent; spec-test r1 S1 on gate.int.test.ts:147):
// 细则「注销调减单被驳回与注销中的调账」(D10-590 ③: 每个会计日补建一张), BR-FUND-24 ⑧ (未完成告警), ledger
// AGENTS.md 硬规则 5 (会计日只用 @couli/domain 的函数) and ADR-0001 §4 (accounting day = Beijing time,
// +08:00). Every instant and every expected day below is written by hand; none is derived by the
// code under test.
// - 23:59:59 → 00:00:00 Beijing time (UTC 15:59:59 → 16:00:00, the same UTC date 11-30): the day of
//   the rejection gets no rebuilt form and one warn; the next second is a new accounting day (12-01):
//   exactly one rebuilt form and a new warn; while that form stays PENDING the following day gets a
//   warn but no second form.
// - 07:59:59 → 08:00:00 Beijing time (UTC 23:59:59 11-30 → 00:00:00 12-01): the UTC date changes but
//   the accounting day (12-01) does not: no rebuilt form and no second warn; the next Beijing
//   midnight (UTC 16:00 12-01) rebuilds.
// - Approvals at instants whose UTC and Beijing dates differ (and one second before a Beijing
//   midnight): the voucher's accounting_date is the Beijing day.
import { expect, it } from 'vitest';
import {
  ADJUST,
  ADJUSTMENT_PENDING,
  TIMEOUT,
  expectApproved,
  expectPrefilled,
  expectRejected,
  fixture,
  formsOf,
  member,
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
import { voucherByKey } from '../admin-adjustments/kit.ts';
import { advanceTo } from './kit-r2.ts';

const s = suite();
const REASON = '核对后金额有误，次日按补建的新单处理';

async function inDeletion(f: AdjustFixture, available: bigint, createdAtIso: string) {
  const userId = await member(f, { available, status: 'deleting' });
  const request = await seedRequest(f, userId);
  const form = await seedPrefill(f, userId, {
    refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
    createdAt: new Date(createdAtIso),
  });
  return { userId, request, form };
}

async function expectStillProcessing(f: AdjustFixture, requestId: string, userId: string) {
  expect((await requestNow(f, requestId)).status, requestId).toBe('processing');
  expect(await userStatusOf(f, userId)).toBe('deleting');
}

it(
  '[AC-B2-12d#28] 北京时间 23:59:59 → 次日 00:00:00（UTC 同为 11-30）：驳回当日 23:59:59 不补建、告警 1 次；00:00:00 起为 12-01 会计日，恰好补建一张并再告警；该单待批期间 12-02 只告警不再补建；批准后完成注销',
  async () => {
    // 2026-11-30 23:59:59 +08:00.
    const f = fixture(s, '2026-11-30T15:59:59.000Z');
    await settleOpenDeletions(f);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        // Prefilled 2026-11-30 23:00:00 +08:00, rejected 23:59:59 the same accounting day.
        const { userId, request, form } = await inDeletion(f, 1200n, '2026-11-30T15:00:00.000Z');
        await expectRejected(f, await h.reject(form.adjust_id, { reason: REASON }), {
          caller: h.maker,
          form,
          note: REASON,
          available: 1200n,
        });
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id), '11-30 warn').toHaveLength(1);
        expect(await formsOf(f, userId), 'no rebuild on 11-30').toHaveLength(1);
        expect(await pendingClosing(f, userId)).toEqual([]);

        // 2026-12-01 00:00:00 +08:00 = 2026-11-30T16:00:00Z.
        advanceTo(f, '2026-11-30T16:00:00.000Z');
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        const rebuilt = await pendingClosing(f, userId);
        expect(rebuilt, 'one rebuilt form on 12-01').toHaveLength(1);
        const fresh = expectPrefilled(f, rebuilt[0], {
          userId,
          requestId: request.id,
          at: new Date('2026-11-30T16:00:00.000Z'),
        });
        expect(await formsOf(f, userId)).toHaveLength(2);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id), '12-01 warn').toHaveLength(2);

        // 2026-12-01 23:59:59 +08:00: the same day, nothing new.
        advanceTo(f, '2026-12-01T15:59:59.000Z');
        await w.round();
        expect(await formsOf(f, userId)).toHaveLength(2);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(2);

        // 2026-12-02 00:00:00 +08:00: a new day while the rebuilt form is still PENDING → a warn,
        // no second rebuilt form.
        advanceTo(f, '2026-12-01T16:00:00.000Z');
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(await pendingClosing(f, userId)).toEqual([fresh]);
        expect(await formsOf(f, userId)).toHaveLength(2);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id), '12-02 warn').toHaveLength(3);

        // h.maker's token was issued at 2026-11-30T15:59:59Z, beyond the admin token lifetime by
        // now: a fresh fund.adjust session at the current clock approves (real auth, real step-up).
        const approver = await h.caller([ADJUST]);
        await expectApproved(f, await h.approve(fresh.adjust_id, { caller: approver }), {
          caller: approver,
          form: fresh,
          amount: 1200n,
        });
        expect((await voucherByKey(f, `ADJ:${fresh.adjust_id}`))?.accounting_date).toBe(
          '2026-12-02',
        );
        advanceTo(f, '2026-12-01T16:01:00.000Z');
        await w.round();
        expect((await requestNow(f, request.id)).status).toBe('done');
        expect(await userStatusOf(f, userId)).toBe('deleted');
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#29] UTC 跨日而北京会计日不变（北京时间 07:59:59 → 08:00:00，UTC 11-30 → 12-01）：不补建、不再告警；到北京时间 12-02 00:00:00（UTC 12-01 16:00）才补建一张并再告警',
  async () => {
    // 2026-12-01 07:59:59 +08:00 = 2026-11-30T23:59:59Z.
    const f = fixture(s, '2026-11-30T23:59:59.000Z');
    await settleOpenDeletions(f);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(f, async (w) => {
        // Prefilled 2026-12-01 07:00:00 +08:00 (UTC 11-30 23:00), rejected 07:59:59.
        const { userId, request, form } = await inDeletion(f, 900n, '2026-11-30T23:00:00.000Z');
        await expectRejected(f, await h.reject(form.adjust_id, { reason: REASON }), {
          caller: h.maker,
          form,
          note: REASON,
          available: 900n,
        });
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);
        expect(await formsOf(f, userId)).toHaveLength(1);

        // 2026-12-01 08:00:00 +08:00 = 2026-12-01T00:00:00Z: a new UTC date, the same accounting day.
        advanceTo(f, '2026-12-01T00:00:00.000Z');
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        expect(await formsOf(f, userId), 'no rebuild within 12-01 (Beijing)').toHaveLength(1);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id), 'one warn on 12-01').toHaveLength(1);

        // 2026-12-01 23:59:59 +08:00.
        advanceTo(f, '2026-12-01T15:59:59.000Z');
        await w.round();
        expect(await formsOf(f, userId)).toHaveLength(1);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id)).toHaveLength(1);

        // 2026-12-02 00:00:00 +08:00.
        advanceTo(f, '2026-12-01T16:00:00.000Z');
        await w.round();
        await expectStillProcessing(f, request.id, userId);
        const rebuilt = await pendingClosing(f, userId);
        expect(rebuilt, 'one rebuilt form on 12-02').toHaveLength(1);
        expectPrefilled(f, rebuilt[0], {
          userId,
          requestId: request.id,
          at: new Date('2026-12-01T16:00:00.000Z'),
        });
        expect(await formsOf(f, userId)).toHaveLength(2);
        expect(w.warnings(ADJUSTMENT_PENDING, request.id), '12-02 warn').toHaveLength(2);
      });
    });
  },
  TIMEOUT,
);

const APPROVALS: readonly { readonly at: string; readonly day: string; readonly label: string }[] =
  [
    { at: '2026-11-30T16:00:00.000Z', day: '2026-12-01', label: '北京 12-01 00:00:00 / UTC 11-30' },
    { at: '2026-11-30T23:59:59.000Z', day: '2026-12-01', label: '北京 12-01 07:59:59 / UTC 11-30' },
    { at: '2026-11-30T17:30:00.000Z', day: '2026-12-01', label: '北京 12-01 01:30:00 / UTC 11-30' },
    { at: '2026-11-30T15:59:59.000Z', day: '2026-11-30', label: '北京 11-30 23:59:59 / UTC 11-30' },
  ];

it.each(APPROVALS)(
  '[AC-B2-12d#30] 在 $label 批准：凭证 accounting_date 为北京会计日 $day，reviewed_at 为批准时刻',
  async ({ at, day }) => {
    const f = fixture(s, at);
    await withClosingAdmin(f, async (h) => {
      const { userId, form } = await inDeletion(f, 650n, '2026-11-30T01:30:00.000Z');
      const approved = await expectApproved(f, await h.approve(form.adjust_id), {
        caller: h.maker,
        form,
        amount: 650n,
      });
      expect(approved.reviewed_at).toEqual(new Date(at));
      const voucher = await voucherByKey(f, `ADJ:${form.adjust_id}`);
      expect(voucher?.accounting_date, `${at} → ${day}`).toBe(day);
      expect(approved.user_id).toBe(userId);
    });
  },
  TIMEOUT,
);
