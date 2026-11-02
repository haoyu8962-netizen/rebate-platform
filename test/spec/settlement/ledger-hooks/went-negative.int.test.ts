// B2-04zn · 扣回使余额跨过 0：真实 worker 入口的扣回发 account.went_negative，payout 的订阅真实跑到（BR-WDR-05 (a)）。
// 之前扣回的账本没有事件总线：余额变负收不到事件，W3 不触发，在途提现照走。这里不自注入账本（kit.ts）。
// 手算：每单 N = 1000、reserve 0、本人 50 %，入账与全额扣回都是 500。
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TIMEOUT, close, open, withWorker } from './kit.ts';

let h: Awaited<ReturnType<typeof open>>;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 180_000);
afterAll(async () => {
  await close(h);
}, 30_000);

it(
  '[AC-B2-04zn#1] 扣回使余额由 ≥0 变 <0：event_log 恰好一条 account.went_negative，负载是该用户；payout 订阅收到后，未发起转账的待审单被 W3 驳回（NEGATIVE_BALANCE，退回冻结），已发起转账的单被 blocked_reason 拦截',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const o = await w.waiting(app);
      await w.credit(app, o);
      const pending = await w.withdrawal(app, { amount: 300n, status: 'PENDING_REVIEW' });
      const sent = await w.withdrawal(app, { amount: 100n, status: 'APPROVED' });
      await w.transferAttempt(app, sent);
      expect(await w.balance(app)).toEqual({ available: 100n, frozen: 400n });

      await w.clawback(o);

      expect(await w.balance(app)).toEqual({ available: -400n, frozen: 400n });
      const events = await w.wentNegative(app);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        app_id: app.appId,
        payload: { v: 1, data: { user_id: app.userId } },
      });

      await w.deliver(app);

      expect(await w.withdrawalRow(app, pending)).toMatchObject({
        status: 'REJECTED',
        reject_reason_code: 'NEGATIVE_BALANCE',
        blocked_reason: null,
      });
      expect(await w.withdrawalRow(app, sent)).toMatchObject({
        status: 'APPROVED',
        blocked_reason: 'NEGATIVE_BALANCE',
      });
      expect(await w.balance(app)).toEqual({ available: -100n, frozen: 100n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#2] 余额本来已负的再次扣回：不重复发，只有跨过 0 的那次一条',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const first = await w.waiting(app);
      const second = await w.waiting(app);
      await w.credit(app, first);
      await w.credit(app, second);
      await w.adjust(app, -700n);

      await w.clawback(first);
      expect(await w.balance(app)).toEqual({ available: -200n, frozen: 0n });
      expect(await w.wentNegative(app)).toHaveLength(1);

      await w.clawback(second);
      expect(await w.balance(app)).toEqual({ available: -700n, frozen: 0n });
      expect(await w.wentNegative(app)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#3] 边界：扣回后正好 0 不发（0 不算变负）；再一笔扣到 -1 发一条',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const first = await w.waiting(app);
      await w.credit(app, first);
      await w.clawback(first);
      expect(await w.balance(app)).toEqual({ available: 0n, frozen: 0n });
      expect(await w.wentNegative(app)).toEqual([]);

      const second = await w.waiting(app);
      await w.credit(app, second);
      await w.adjust(app, -1n);
      await w.clawback(second);
      expect(await w.balance(app)).toEqual({ available: -1n, frozen: 0n });
      expect(await w.wentNegative(app)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#4] 没跨过 0 的入账和扣回：不发事件，不动拦截；同一会员之后真跨过 0 才发',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      await w.adjust(app, 300n);
      const blocked = await w.withdrawal(app, {
        amount: 100n,
        status: 'APPROVED',
        blocked: true,
      });
      const before = await w.withdrawalRow(app, blocked);
      const first = await w.waiting(app);
      const second = await w.waiting(app);

      await w.credit(app, first);
      await w.credit(app, second);
      expect(await w.balance(app)).toEqual({ available: 1200n, frozen: 100n });
      expect(await w.wentNegative(app)).toEqual([]);
      expect(await w.withdrawalRow(app, blocked)).toEqual(before);

      await w.clawback(first);
      expect(await w.balance(app)).toEqual({ available: 700n, frozen: 100n });
      expect(await w.wentNegative(app)).toEqual([]);
      expect(await w.withdrawalRow(app, blocked)).toEqual(before);

      await w.adjust(app, -600n);
      await w.clawback(second);
      expect(await w.balance(app)).toEqual({ available: -400n, frozen: 100n });
      expect(await w.wentNegative(app)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#5] 回正后再次变负是新的一次跨越：再发一条，共两条',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const first = await w.waiting(app);
      const second = await w.waiting(app);
      const third = await w.waiting(app);
      await w.credit(app, first);
      await w.credit(app, second);
      await w.adjust(app, -700n);

      await w.clawback(first);
      expect(await w.wentNegative(app)).toHaveLength(1);

      await w.credit(app, third);
      expect(await w.balance(app)).toEqual({ available: 300n, frozen: 0n });
      expect(await w.wentNegative(app)).toHaveLength(1);

      await w.clawback(second);
      expect(await w.balance(app)).toEqual({ available: -200n, frozen: 0n });
      expect(await w.wentNegative(app)).toHaveLength(2);
    });
  },
  TIMEOUT,
);
