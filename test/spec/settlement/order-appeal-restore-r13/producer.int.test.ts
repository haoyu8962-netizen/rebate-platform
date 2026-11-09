// B2-09gg rule tests, the producer (claude-independent, SPEC_REF 03383a10): 08 BR-FUND-22 申诉恢复 ②,
// 编排 D10-1180 — appeal.resolved of a revoked order appeal on a CLAWED_BACK / BLACKLIST order registers
// one appeal_restore difference named by the history row that entered CLAWED_BACK, and nothing else
// changes (处理前不入账). Every delivery goes through the handler the real worker registered; the orders
// reach CLAWED_BACK through the real credit and blacklist confirmation. Top-level it() only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CONSUMER,
  NEXT_MONTH,
  PERIOD,
  QUEUE,
  TIMEOUT,
  allButDiffs,
  app,
  appealDiffs,
  clawedOrder,
  dedupeKeyOf,
  jobOf,
  processedOf,
  refId,
  refundClawback,
  resolvedEvent,
  setOrderFigures,
  suite,
  withConsoleAndWorker,
  type Worker,
} from './kit.ts';

const s = suite();

/** The worker's warning lines naming the skip (a skipped registration logs exactly one each). */
function skipLines(worker: Worker) {
  return worker.lines.filter(
    (line) => line['level'] === 40 && JSON.stringify(line).includes('order_appeal_restore_skipped'),
  );
}

it(
  '[AC-B2-09gg#3] 撤销的订单申诉（CLAWED_BACK + BLACKLIST）登记一张差错单：appeal_restore、R3、period 为处理时刻的中国月份、ref_type order、ref_id `{order_key}#RESTORE#{entry_id}`、expected_fen 为当前有效佣金正数部分（结算额 1000；结算额改成 777 取 777；结算额 −50 记 0）、actual 0、diff 同 expected、open、dedupe_key、resolution 七键（reason_code BLACKLIST、rebate_status CLAWED_BACK）；订单、状态历史、分录、余额、审计都不变，事件确认',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const settled = await clawedOrder(a, admin);
      const changed = await clawedOrder(a, admin);
      await setOrderFigures(a, changed.order, { settleFen: 777n });
      const negative = await clawedOrder(a, admin);
      await setOrderFigures(a, negative.order, { settleFen: -50n });

      const before = await allButDiffs(a);
      const appealId = randomUUID();
      const event = resolvedEvent(a, settled.order, { appealId });
      const handler = worker.handlerOn(QUEUE);
      await handler(jobOf(event));
      await handler(jobOf(resolvedEvent(a, changed.order)));
      await handler(jobOf(resolvedEvent(a, negative.order)));

      const rows = await appealDiffs(a.f);
      expect(rows).toHaveLength(3);
      const byRef = (ref: string) => rows.find((r) => r.ref_id === ref);
      const row = byRef(refId(settled.order, settled.entryId));
      expect(row).toMatchObject({
        app_id: a.h.appId,
        type: 'appeal_restore',
        source: 'R3',
        period: PERIOD,
        ref_type: 'order',
        expected_fen: 1000n,
        actual_fen: 0n,
        diff_fen: 1000n,
        status: 'open',
        handler_id: null,
        closed_at: null,
        dedupe_key: dedupeKeyOf(a, settled.order, settled.entryId),
      });
      expect(row!.resolution).toEqual({
        reason_code: 'BLACKLIST',
        appeal_id: appealId,
        order_id: settled.order.orderId,
        order_key: settled.order.orderKey,
        user_id: settled.order.user('self'),
        rebate_status: 'CLAWED_BACK',
        platform_status: 'SETTLED',
      });
      expect(byRef(refId(changed.order, changed.entryId))).toMatchObject({
        expected_fen: 777n,
        actual_fen: 0n,
        diff_fen: 777n,
      });
      expect(byRef(refId(negative.order, negative.entryId))).toMatchObject({
        expected_fen: 0n,
        actual_fen: 0n,
        diff_fen: 0n,
      });

      expect(await allButDiffs(a)).toEqual(before);
      expect(await processedOf(event.eventId, a.f)).toEqual([
        { consumer: CONSUMER, event_id: event.eventId },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#4] 不登记也不算失败：维持（upheld）的 CLAWED_BACK + BLACKLIST 不登记、事件确认；退款扣回的 CLAWED_BACK（原因不是 BLACKLIST）撤销也不登记，只记一行 order_appeal_restore_skipped、事件确认；同一单随后撤销才登记',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const { order, entryId } = await clawedOrder(a, admin);
      const refunded = await refundClawback(a);
      const handler = worker.handlerOn(QUEUE);

      const upheld = resolvedEvent(a, order, { status: 'upheld' });
      await handler(jobOf(upheld));
      expect(await processedOf(upheld.eventId, a.f)).toEqual([
        { consumer: CONSUMER, event_id: upheld.eventId },
      ]);
      expect(await appealDiffs(a.f)).toEqual([]);
      expect(skipLines(worker)).toEqual([]);

      const skipped = resolvedEvent(a, refunded);
      await handler(jobOf(skipped));
      expect(await processedOf(skipped.eventId, a.f)).toEqual([
        { consumer: CONSUMER, event_id: skipped.eventId },
      ]);
      expect(await appealDiffs(a.f)).toEqual([]);
      expect(skipLines(worker)).toHaveLength(1);

      await handler(jobOf(resolvedEvent(a, order)));
      const rows = await appealDiffs(a.f);
      expect(rows.map((r) => r.ref_id)).toEqual([refId(order, entryId)]);
      expect(skipLines(worker)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#5] 去重按进入 CLAWED_BACK 的历史行：同一事件重投、新事件 id、第二次申诉撤销同一次扣回（跨月，新的 period 也不再开一张）都落同一张差错单，原行不变（appeal_id 仍是第一次的）',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const { order, entryId } = await clawedOrder(a, admin);
      const handler = worker.handlerOn(QUEUE);
      const firstAppeal = randomUUID();
      const event = resolvedEvent(a, order, { appealId: firstAppeal });

      await handler(jobOf(event));
      const first = await appealDiffs(a.f);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        ref_id: refId(order, entryId),
        dedupe_key: dedupeKeyOf(a, order, entryId),
        period: PERIOD,
      });

      await handler(jobOf({ ...event, attempt: 2 }));
      await handler(jobOf(resolvedEvent(a, order, { appealId: firstAppeal })));
      expect(await appealDiffs(a.f)).toEqual(first);

      a.h.clock.set(NEXT_MONTH);
      await handler(jobOf(resolvedEvent(a, order)));
      expect(await appealDiffs(a.f)).toEqual(first);
      expect(first[0]!.resolution).toMatchObject({ appeal_id: firstAppeal });
    });
  },
  TIMEOUT,
);
