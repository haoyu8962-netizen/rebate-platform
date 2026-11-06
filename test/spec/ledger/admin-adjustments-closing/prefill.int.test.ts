// B2-12d prefill (claude-independent): BR-FUND-24 ⑧ (用户进入注销 processing 时，available > 0 的，系统
// 预填 ACCOUNT_CLOSED 调减单，金额在批准时按当时 available 取) and BR-ID-28, on the real worker entry: the
// cooling-period expiry of the worker's deletion runner moves the request to processing, and the
// same transaction prefills the form; a balance of 0 gets none; later rounds never add a second
// one while one is PENDING. Same transaction: a failing prefill insert leaves the request in
// cooling and the member normal, and the next round does both.
// Amounts by hand: 2000 → one form without amount, the balance stays 2000 (nothing is posted until
// approval); 0 → no form.
import { expect, it } from 'vitest';
import {
  ADJUSTMENT_PENDING,
  DAY_MS,
  EXPIRY_ROW_FAILED,
  TIMEOUT,
  adjustVouchers,
  expectPrefilled,
  fixture,
  formInsertFault,
  formsOf,
  inboxOf,
  markCleaned,
  member,
  moneyOf,
  requestNow,
  seedRequest,
  settleOpenDeletions,
  suite,
  userStatusOf,
  withDeletionWorker,
} from './kit.ts';

const s = suite();

it(
  '[AC-B2-12d#5] 冷静期满进 processing 的同一轮：available=2000 的生成 1 张 PENDING 的 ACCOUNT_CLOSED 调减单（无金额、无发起人、关联注销单、对方 COMMISSION_REVENUE），不记账、不发站内信；available=0 的不生成；之后同日、次日的轮次（单仍待批）都不重复生成，注销停在 processing 并告警',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    const rich = await member(f, { available: 2000n });
    const poor = await member(f);
    const richRequest = await seedRequest(f, rich, 'cooling');
    const poorRequest = await seedRequest(f, poor, 'cooling');
    await withDeletionWorker(f, async (w) => {
      await w.round();
      const entered = f.clock.now();
      for (const [userId, requestId] of [
        [rich, richRequest.id],
        [poor, poorRequest.id],
      ] as const) {
        expect((await requestNow(f, requestId)).status, requestId).toBe('processing');
        expect(await userStatusOf(f, userId)).toBe('deleting');
      }
      const forms = await formsOf(f, rich);
      expect(forms, 'one prefilled form').toHaveLength(1);
      const form = expectPrefilled(f, forms[0], {
        userId: rich,
        requestId: richRequest.id,
        at: entered,
      });
      expect(await formsOf(f, poor), 'available 0 gets no form').toEqual([]);
      expect(await moneyOf(f, rich)).toEqual({ available: 2000n, frozen: 0n });
      expect(await adjustVouchers(f), 'nothing is posted before approval').toEqual([]);
      expect(await inboxOf(f, rich)).toEqual([]);

      // The cleanup and the Apple step as they finish (fixture), then more rounds.
      await markCleaned(f, richRequest.id);
      await markCleaned(f, poorRequest.id);
      f.clock.advanceMs(3_600_000);
      await w.round();
      f.clock.advanceMs(DAY_MS);
      await w.round();
      expect(await formsOf(f, rich), 'still the one form').toEqual([form]);
      expect(await formsOf(f, poor)).toEqual([]);
      expect((await requestNow(f, richRequest.id)).status).toBe('processing');
      expect(await userStatusOf(f, rich)).toBe('deleting');
      expect(w.warnings(ADJUSTMENT_PENDING, richRequest.id)).toHaveLength(2);
      // available 0, nothing to approve: the deletion completes.
      expect((await requestNow(f, poorRequest.id)).status).toBe('done');
      expect(await userStatusOf(f, poor)).toBe('deleted');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-12d#6] 预填与进 processing 在同一事务：预填写入失败 → 注销单仍是 cooling、users 仍 normal、无单（该行告警后本轮继续）；下一轮两者一起完成，恰好 1 张',
  async () => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    const userId = await member(f, { available: 1500n });
    const request = await seedRequest(f, userId, 'cooling');
    const { fault, plugin } = formInsertFault(userId);
    await withDeletionWorker(
      f,
      async (w) => {
        await w.round();
        expect(fault.tripped, 'the prefill insert of this member was attempted').toBe(1);
        expect((await requestNow(f, request.id)).status).toBe('cooling');
        expect(await userStatusOf(f, userId)).toBe('normal');
        expect(await formsOf(f, userId)).toEqual([]);
        expect(w.anyWarnings(EXPIRY_ROW_FAILED).length).toBeGreaterThanOrEqual(1);

        f.clock.advanceMs(60_000);
        await w.round();
        expect((await requestNow(f, request.id)).status).toBe('processing');
        expect(await userStatusOf(f, userId)).toBe('deleting');
        const forms = await formsOf(f, userId);
        expect(forms).toHaveLength(1);
        expectPrefilled(f, forms[0], { userId, requestId: request.id, at: f.clock.now() });
        expect(await moneyOf(f, userId)).toEqual({ available: 1500n, frozen: 0n });
      },
      [plugin],
    );
  },
  TIMEOUT,
);
