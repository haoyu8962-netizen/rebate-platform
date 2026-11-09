// B2-09gd rule tests, the producer (claude-independent, SPEC_REF d5713bf4): 08 BR-FUND-22 申诉恢复 ①
// and task brief 9.2 A — appeal.resolved of a revoked order appeal registers, on the event's
// transaction and under the order key's lock, one appeal_restore difference of the order's VOID /
// BLACKLIST entry. Registration changes no order, voucher, balance or audit row. Every delivery goes
// through the handler the real worker registered. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { track } from '../../payment/orders/kit.ts';
import { fixture, suite } from '../admin-recon-restore/kit.ts';
import { addRebateStep, orderRow, refIdOf, world } from '../platform-restore/kit.ts';
import {
  CONSUMER,
  QUEUE,
  RECEIVED_AT,
  TIMEOUT,
  appealDiffs,
  appealEvent,
  dedupeKeyOf,
  expectUnchangedByRegistration,
  holdOpen,
  jobOf,
  lockOrder,
  moveIntoVoid,
  moveOffVoid,
  processedOf,
  rawEvent,
  seedAppealDiff,
  seedVoid,
  untilBlockedBy,
  warnings,
  withWorker,
} from './kit.ts';

const s = suite();

it(
  '[AC-B2-09gd#1] 撤销的订单申诉登记一张差错单：type appeal_restore、source R3、period 为处理时刻的中国月份、ref_type order、ref_id `{order_key}#RESTORE#{entry_id}`、expected_fen 为有效联盟佣金正数部分（结算额优先于预估，负数记 0）、actual 0、diff 同 expected、open、dedupe_key `appeal_restore:order:{app_id}:{order_key}:{entry_id}`、resolution 六键；订单、状态历史、受益人事件、分录、余额、审计都不变；消费者记 processed_events',
  async () => {
    const f = await fixture(s);
    const settled = await seedVoid(f, {
      est: 800n,
      settle: 1500n,
      platformStatus: 'SETTLED',
      receivedAt: RECEIVED_AT,
    });
    const negative = await seedVoid(f, { est: -30n });
    await withWorker(f, async (worker) => {
      const handler = worker.handlerOn(QUEUE);
      const before = await world(f);
      const appealId = randomUUID();
      const event = appealEvent(f, {
        targetId: settled.orderId,
        userId: settled.userId,
        appealId,
      });
      await handler(jobOf(event));
      await handler(jobOf(appealEvent(f, { targetId: negative.orderId, userId: negative.userId })));

      const rows = await appealDiffs(f);
      expect(rows).toHaveLength(2);
      const row = rows.find((r) => r.ref_id === refIdOf(settled.orderKey, settled.entryId));
      expect(row, JSON.stringify(rows.map((r) => r.ref_id))).toBeDefined();
      expect(row).toMatchObject({
        app_id: f.appId,
        type: 'appeal_restore',
        source: 'R3',
        period: '2026-10',
        ref_type: 'order',
        ref_id: refIdOf(settled.orderKey, settled.entryId),
        expected_fen: 1500n,
        actual_fen: 0n,
        diff_fen: 1500n,
        status: 'open',
        handler_id: null,
        closed_at: null,
        dedupe_key: dedupeKeyOf(f, settled),
      });
      expect(row!.resolution).toEqual({
        reason_code: 'BLACKLIST',
        appeal_id: appealId,
        order_id: settled.orderId,
        order_key: settled.orderKey,
        user_id: settled.userId,
        rebate_status: 'VOID',
        platform_status: 'SETTLED',
      });
      const zero = rows.find((r) => r.ref_id === refIdOf(negative.orderKey, negative.entryId));
      expect(zero).toMatchObject({ expected_fen: 0n, actual_fen: 0n, diff_fen: 0n });

      expectUnchangedByRegistration(before, await world(f));
      expect(await processedOf(event.eventId, f)).toEqual([
        { consumer: CONSUMER, event_id: event.eventId },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#2] 不登记也不算失败：账户申诉、upheld、被拦截请求申诉直接确认；订单已不是 VOID、VOID 而 reason 不是 BLACKLIST 记 warn order_appeal_restore_skipped 并确认。拒绝（重试后死信，不记 processed_events）：载荷错、订单不存在（含别的应用的订单）、订单没有进入 VOID 的历史行',
  async () => {
    const f = await fixture(s);
    const other = await fixture(s);
    const voided = await seedVoid(f);
    const moved = await seedVoid(f, { rebate: 'ESTIMATED', reason: null });
    const refunded = await seedVoid(f, { reason: 'REFUND' });
    const damaged = await seedVoid(f, { noEntry: true });
    const foreign = await seedVoid(other);
    await withWorker(f, async (worker) => {
      const handler = worker.handlerOn(QUEUE);
      const before = await world(f);

      const acknowledged = [
        appealEvent(f, {
          targetType: 'account',
          targetId: voided.userId!,
          userId: voided.userId,
        }),
        appealEvent(f, { targetId: voided.orderId, userId: voided.userId, status: 'upheld' }),
        appealEvent(f, {
          targetType: 'blocked_request',
          targetId: randomUUID(),
          userId: null,
        }),
      ];
      for (const event of acknowledged) {
        await handler(jobOf(event));
        expect(await processedOf(event.eventId, f)).toEqual([
          { consumer: CONSUMER, event_id: event.eventId },
        ]);
      }
      expect(warnings(worker)).not.toContain('order_appeal_restore_skipped');

      for (const order of [moved, refunded]) {
        const event = appealEvent(f, { targetId: order.orderId, userId: order.userId });
        await handler(jobOf(event));
        expect(await processedOf(event.eventId, f)).toEqual([
          { consumer: CONSUMER, event_id: event.eventId },
        ]);
      }
      expect(warnings(worker)).toContain('order_appeal_restore_skipped');
      expect(await appealDiffs(f)).toEqual([]);

      const good = {
        app_id: f.appId,
        appeal_id: randomUUID(),
        user_id: voided.userId,
        target_type: 'order',
        target_id: voided.orderId,
        status: 'revoked',
        need_reauth: false,
      };
      const rejected = [
        rawEvent(f, { ...good, app_id: 'another-app' }),
        rawEvent(f, { ...good, appeal_id: undefined }),
        rawEvent(f, { ...good, status: 'nonsense' }),
        rawEvent(f, { ...good, target_id: randomUUID() }),
        rawEvent(f, { ...good, target_id: foreign.orderId, user_id: foreign.userId }),
        rawEvent(f, { ...good, target_id: damaged.orderId, user_id: damaged.userId }),
      ];
      for (const event of rejected) {
        await expect(handler(jobOf(event)), JSON.stringify(event.payload)).rejects.toThrow();
        expect(await processedOf(event.eventId, f)).toEqual([]);
      }
      expect(await appealDiffs(f)).toEqual([]);
      expectUnchangedByRegistration(before, await world(f));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#3] 幂等按进入 VOID 的历史行：同一事件重投、新 event id、第二次申诉撤销同一次作废（跨月，新的 period 也不再开一张）都只有一张，原行不变；订单再次作废后又撤销，是新的 entry_id、新的一张，period 取当时月份',
  async () => {
    const f = await fixture(s);
    const order = await seedVoid(f);
    await withWorker(f, async (worker) => {
      const handler = worker.handlerOn(QUEUE);
      const event = appealEvent(f, { targetId: order.orderId, userId: order.userId });
      await handler(jobOf(event));
      const first = await appealDiffs(f);
      expect(first).toHaveLength(1);

      await handler(jobOf({ ...event, attempt: 2 }));
      await handler(
        jobOf(
          appealEvent(f, {
            targetId: order.orderId,
            userId: order.userId,
            appealId: (event.payload as unknown as { appeal_id: string }).appeal_id,
          }),
        ),
      );
      expect(await appealDiffs(f)).toEqual(first);

      // Into the next month: a second appeal of the same voiding.
      f.clock.set('2026-11-03T08:00:00.000Z');
      await handler(jobOf(appealEvent(f, { targetId: order.orderId, userId: order.userId })));
      expect(await appealDiffs(f)).toEqual(first);
      expect(first[0]).toMatchObject({ period: '2026-10' });

      // Restored, voided by the blacklist again, the new voiding appealed and revoked.
      await addRebateStep(f, order.orderId, {
        from: 'VOID',
        event: 'ADMIN_RESTORE',
        to: 'ESTIMATED',
        source: 'admin',
      });
      const entryId = await addRebateStep(f, order.orderId, {
        from: 'ESTIMATED',
        event: 'BLACKLIST_HIT',
        to: 'VOID',
      });
      await handler(jobOf(appealEvent(f, { targetId: order.orderId, userId: order.userId })));
      const rows = await appealDiffs(f);
      expect(rows).toHaveLength(2);
      const second = rows.find((r) => r.ref_id === refIdOf(order.orderKey, entryId));
      expect(second).toMatchObject({
        period: '2026-11',
        dedupe_key: dedupeKeyOf(f, order, entryId),
        status: 'open',
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#13] 锁内重读（订单先被改走）：另一事务持订单 advisory 锁并把订单改离 VOID、尚未提交时，撤销事件的消费者在这把锁上等待；锁释放后按最新状态跳过登记，记 warn order_appeal_restore_skipped 并确认，没有差错单',
  async () => {
    const f = await fixture(s);
    const order = await seedVoid(f);
    await withWorker(f, async (worker) => {
      const handler = worker.handlerOn(QUEUE);
      const event = appealEvent(f, { targetId: order.orderId, userId: order.userId });
      const mover = await holdOpen(s.holder(), async (trx) => {
        await lockOrder(trx, order);
        await moveOffVoid(f, trx, order);
      });
      const delivery = track(handler(jobOf(event)));
      try {
        await untilBlockedBy(f.db, mover.pid, 'advisory', delivery);
        expect(await appealDiffs(f)).toEqual([]);

        await mover.finish('commit');
        await delivery.promise;
        expect(await appealDiffs(f)).toEqual([]);
        expect(warnings(worker)).toContain('order_appeal_restore_skipped');
        expect(await processedOf(event.eventId, f)).toEqual([
          { consumer: CONSUMER, event_id: event.eventId },
        ]);
      } finally {
        await Promise.allSettled([mover.finish('rollback'), delivery.promise]);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#13] 锁内重读（订单后进入 VOID）：另一事务持订单 advisory 锁并把 ESTIMATED 的订单改成 VOID / BLACKLIST、尚未提交时，消费者在这把锁上等待；锁释放后按最新状态登记一张差错单，entry_id 是这次新进入 VOID 的历史行',
  async () => {
    const f = await fixture(s);
    const order = await seedVoid(f, { rebate: 'ESTIMATED', reason: null, noEntry: true });
    await withWorker(f, async (worker) => {
      const handler = worker.handlerOn(QUEUE);
      const event = appealEvent(f, { targetId: order.orderId, userId: order.userId });
      let entryId = 0n;
      const mover = await holdOpen(s.holder(), async (trx) => {
        await lockOrder(trx, order);
        entryId = await moveIntoVoid(f, trx, order);
      });
      const delivery = track(handler(jobOf(event)));
      try {
        await untilBlockedBy(f.db, mover.pid, 'advisory', delivery);
        expect(await appealDiffs(f)).toEqual([]);

        await mover.finish('commit');
        await delivery.promise;
        const rows = await appealDiffs(f);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          ref_id: refIdOf(order.orderKey, entryId),
          dedupe_key: dedupeKeyOf(f, order, entryId),
          expected_fen: 800n,
          status: 'open',
        });
        expect(rows[0]!.resolution).toMatchObject({
          reason_code: 'BLACKLIST',
          rebate_status: 'VOID',
        });
        expect(warnings(worker)).not.toContain('order_appeal_restore_skipped');
      } finally {
        await Promise.allSettled([mover.finish('rollback'), delivery.promise]);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#13] 相反顺序（消费者先拿到锁）：消费者持订单 advisory 锁、登记尚未提交时，要改走订单的事务在这把锁上等待；消费者提交后差错单按改走之前的 VOID 登记，那个事务才把订单改走',
  async () => {
    const f = await fixture(s);
    const order = await seedVoid(f);
    await withWorker(f, async (worker) => {
      const handler = worker.handlerOn(QUEUE);
      const event = appealEvent(f, { targetId: order.orderId, userId: order.userId });
      // An uncommitted row on the difference's dedupe key stops the consumer at its INSERT, after
      // it took the order's lock; rolling that row back lets the consumer's own INSERT through.
      const parker = await holdOpen(s.holder(), async (trx) => {
        await seedAppealDiff({ ...f, db: trx }, order);
      });
      const delivery = track(handler(jobOf(event)));
      const running: Promise<unknown>[] = [delivery.promise];
      try {
        const consumer = await untilBlockedBy(f.db, parker.pid, 'transactionid', delivery);
        const moving = track(
          f.db.transaction().execute(async (trx) => {
            await lockOrder(trx, order);
            await moveOffVoid(f, trx, order);
          }),
        );
        running.push(moving.promise);
        await untilBlockedBy(f.db, consumer, 'advisory', moving);
        expect(await orderRow(f, order.orderId)).toMatchObject({
          rebate_status: 'VOID',
          reason: 'BLACKLIST',
        });

        await parker.finish('rollback');
        await delivery.promise;
        await moving.promise;
        const rows = await appealDiffs(f);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          ref_id: refIdOf(order.orderKey, order.entryId),
          dedupe_key: dedupeKeyOf(f, order),
          status: 'open',
        });
        expect(rows[0]!.resolution).toMatchObject({
          reason_code: 'BLACKLIST',
          rebate_status: 'VOID',
        });
        expect(await orderRow(f, order.orderId)).toMatchObject({
          rebate_status: 'ESTIMATED',
          reason: null,
        });
        expect(warnings(worker)).not.toContain('order_appeal_restore_skipped');
      } finally {
        await Promise.allSettled([parker.finish('rollback'), ...running]);
      }
    });
  },
  TIMEOUT,
);
