// B2-04zn · 结算入账使余额回到 ≥0：入账的账本带 payout 的回正钩子，同一笔入账解除 NEGATIVE_BALANCE（BR-WDR-05 (a)、BR-FUND-12）。
// 之前结算 worker 的账本没有钩子：余额已回正，拦截还在，提现一直卡住。入账都在真实 settle 处理器上执行（kit.ts）。
// 手算：N = 1000、reserve 0、本人 50 %，R5 与 R5a 都是 500。
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
  '[AC-B2-04zn#6] 结算入账（R5）使余额由 <0 回到 ≥0（边界：正好 0）：拦截解除，updated_at 取 worker 时钟、row_version + 1、状态不变；没被拦截的单不动，不发 account.went_negative',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      await w.adjust(app, 200n);
      const blocked = await w.withdrawal(app, {
        amount: 100n,
        status: 'APPROVED',
        blocked: true,
      });
      const plain = await w.withdrawal(app, { amount: 100n, status: 'APPROVED' });
      await w.adjust(app, -500n);
      const o = await w.waiting(app);
      const before = await w.withdrawalRow(app, blocked);
      const untouched = await w.withdrawalRow(app, plain);

      await w.credit(app, o);

      expect(await w.balance(app)).toEqual({ available: 0n, frozen: 200n });
      expect(await w.withdrawalRow(app, blocked)).toEqual({
        ...before,
        blocked_reason: null,
        updated_at: w.clock.now(),
        row_version: before.row_version + 1,
      });
      expect(await w.withdrawalRow(app, plain)).toEqual(untouched);
      expect(await w.wentNegative(app)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#7] 入账后仍 <0：不解除，行不动；下一笔回到 ≥0 才解除',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const blocked = await w.blockedMember(app, 501n);
      const first = await w.waiting(app);
      const second = await w.waiting(app);
      const before = await w.withdrawalRow(app, blocked);

      await w.credit(app, first);
      expect(await w.balance(app)).toEqual({ available: -1n, frozen: 100n });
      expect(await w.withdrawalRow(app, blocked)).toEqual(before);

      await w.credit(app, second);
      expect(await w.balance(app)).toEqual({ available: 499n, frozen: 100n });
      expect(await w.withdrawalRow(app, blocked)).toMatchObject({
        status: 'APPROVED',
        blocked_reason: null,
        row_version: before.row_version + 1,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#8] 补记（R5a）同样解除：冻结会员的 R5 不进余额、拦截不动；恢复正常后的补记 500 使余额回到 ≥0，拦截解除',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const blocked = await w.blockedMember(app, 300n);
      const o = await w.waiting(app);
      const before = await w.withdrawalRow(app, blocked);

      await w.setRisk(app, 'frozen');
      await w.credit(app, o);
      expect(await w.balance(app)).toEqual({ available: -300n, frozen: 100n });
      expect(await w.withdrawalRow(app, blocked)).toEqual(before);

      await w.setRisk(app, 'normal');
      expect(await w.supplement(app, o)).toMatchObject({ result: 'credited', amount_fen: 500n });

      expect(await w.balance(app)).toEqual({ available: 200n, frozen: 100n });
      expect(await w.withdrawalRow(app, blocked)).toEqual({
        ...before,
        blocked_reason: null,
        updated_at: w.clock.now(),
        row_version: before.row_version + 1,
      });
    });
  },
  TIMEOUT,
);
