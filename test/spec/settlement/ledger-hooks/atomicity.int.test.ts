// B2-04zn · 事件与解除都在记账事务里，跨 App 不串（ledger.post 的约定，02 §18）。
// 故障用生产总线上的一次发布失败注入：order.clawed_back、order.credited 都排在记账之后。失败前先在同一事务里读一次，
// 证明事件或解除确实发生过，再证明回滚后都没有；只看回滚后的结果，没接线的代码也会过。
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TIMEOUT, capture, close, invalidated, open, withWorker } from './kit.ts';

let h: Awaited<ReturnType<typeof open>>;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 180_000);
afterAll(async () => {
  await close(h);
}, 30_000);

it(
  '[AC-B2-04zn#9] 扣回事务失败：同事务里事件已写，回滚后 event_log、余额、订单都没有留下；重投后恰好一条',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const o = await w.waiting(app);
      await w.credit(app, o);
      await w.adjust(app, -200n);
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic bus failure');
      let inside = 0;
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.clawed_back') {
          inside = (await w.wentNegative(app, trx)).length;
          throw failure;
        }
        return publish(trx, event);
      });

      expect(await capture(() => o.report(invalidated()))).toEqual({ ok: false, error: failure });

      expect(inside).toBe(1);
      expect(await w.wentNegative(app)).toEqual([]);
      expect(await w.balance(app)).toEqual({ available: 300n, frozen: 0n });
      expect(await o.row()).toMatchObject({
        platform_status: 'RECEIVED',
        rebate_status: 'CREDITED',
      });
      bus.mockRestore();

      await w.clawback(o);
      expect(await w.balance(app)).toEqual({ available: -200n, frozen: 0n });
      expect(await w.wentNegative(app)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#10] 入账事务失败：同事务里拦截已解除，回滚后拦截、余额、订单都回到原样；接管重跑后才解除',
  async () => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const blocked = await w.blockedMember(app, 300n);
      const o = await w.waiting(app);
      const before = await w.withdrawalRow(app, blocked);
      const batchId = await w.orderBatch(app, o);
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic bus failure');
      let inside: string | null = 'not read';
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.credited') {
          inside = (await w.withdrawalRow(app, blocked, trx)).blocked_reason;
          throw failure;
        }
        return publish(trx, event);
      });

      await expect(w.execute(app, batchId)).rejects.toBe(failure);

      expect(inside).toBeNull();
      expect(await w.withdrawalRow(app, blocked)).toEqual(before);
      expect(await w.balance(app)).toEqual({ available: -300n, frozen: 100n });
      expect(await o.row()).toMatchObject({ rebate_status: 'WAITING', booked_n_fen: null });
      bus.mockRestore();

      await w.execute(app, batchId);
      expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED' });
      expect(await w.balance(app)).toEqual({ available: 200n, frozen: 100n });
      expect(await w.withdrawalRow(app, blocked)).toMatchObject({ blocked_reason: null });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#11] 跨 App 不串（变负）：A 的扣回只在 A 留事件；投递后 A 的提现被驳回，B 的提现、余额与事件不动',
  async () => {
    await withWorker(h, async (w) => {
      const [a, b] = [await w.app(), await w.app()];
      const ownOrder = await w.waiting(a);
      const otherOrder = await w.waiting(b);
      await w.credit(a, ownOrder);
      await w.credit(b, otherOrder);
      const own = await w.withdrawal(a, { amount: 300n, status: 'PENDING_REVIEW' });
      const other = await w.withdrawal(b, { amount: 300n, status: 'PENDING_REVIEW' });
      const otherBefore = await w.withdrawalRow(b, other);

      await w.clawback(ownOrder);

      expect(await w.wentNegative(a)).toMatchObject([
        { app_id: a.appId, payload: { data: { user_id: a.userId } } },
      ]);
      expect(await w.wentNegative(b)).toEqual([]);

      await w.deliver(a);

      expect(await w.withdrawalRow(a, own)).toMatchObject({
        status: 'REJECTED',
        reject_reason_code: 'NEGATIVE_BALANCE',
      });
      expect(await w.withdrawalRow(b, other)).toEqual(otherBefore);
      expect(await w.balance(b)).toEqual({ available: 200n, frozen: 300n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zn#12] 跨 App 不串（回正）：A 的入账只解除 A 的拦截，B 同样被拦的单与余额不动',
  async () => {
    await withWorker(h, async (w) => {
      const [a, b] = [await w.app(), await w.app()];
      const own = await w.blockedMember(a, 300n);
      const other = await w.blockedMember(b, 300n);
      const o = await w.waiting(a);
      const otherBefore = await w.withdrawalRow(b, other);

      await w.credit(a, o);

      expect(await w.balance(a)).toEqual({ available: 200n, frozen: 100n });
      expect(await w.withdrawalRow(a, own)).toMatchObject({ blocked_reason: null });
      expect(await w.withdrawalRow(b, other)).toEqual(otherBefore);
      expect(await w.balance(b)).toEqual({ available: -300n, frozen: 100n });
    });
  },
  TIMEOUT,
);
