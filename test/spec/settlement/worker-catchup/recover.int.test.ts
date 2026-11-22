// B2-04zg: the monthly bill caught up end to end (D10-476 / task brief §9.2; 08 BR-FUND-04 ③,
// BR-FUND-18). The catch-up (seedSettleBillCatchUp over createSettleCatchUpStore) sends on pg-boss
// of the test database; the job is run by the settle handler SettlementModule.forWorker registers
// (real bill job, production bill source; the other modules' ports synthetic), the test acting as
// the worker (take the job, run the handler, complete it or fail it into settle.dead). The module's
// own timer is held (fake timers): only the test sends. Checked:
// - a bill day missed entirely → the next day's catch-up generates bill month M once (bill_id = M),
//   the snapshot judged on the catch-up day; later catch-ups, a fresh store and a replay add
//   nothing; the earlier period is not sent;
// - a bill day whose bill failed all day → caught up later; a rerun that fails again stays one
//   failed settle_jobs row (what CouliSettleBillJobFailed counts) until a rerun succeeds.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, type JobHandler } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createSettleCatchUpStore,
  createSettleRunStore,
  seedSettleBillCatchUp,
  seedSettleBills,
  type SettlementWorkerPorts,
} from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  APP,
  BILL,
  BILL_DAY,
  BILL_DAY_NOW,
  BILL_DAY_START,
  BILL_MONTH,
  FAKE_CRYPTO,
  TAOBAO,
  TIMEOUT,
  billKey,
  fakeEventBus,
  jobsUnder,
  liveJobsUnder,
  memoryLogger,
  receivedJob,
  seedOrder,
  settleHandler,
  settlementModule,
  silentRootLogger,
  withDatabase,
  withRealQueue,
  workerContext,
  type FakeQueue,
  type NestContext,
  type PortCalls,
} from '../worker/kit.ts';
import {
  DAY_AFTER_NOW,
  NEXT_BILL_DAY,
  PREV_BILL_DAY,
  billRunsOf,
  billsOf,
  deliver,
  failedBillRunCount,
  outcomeOf,
  plainBillSend,
  plainView,
  recordingPorts,
} from './kit.ts';

const DONE_RUN = { job: 'bill', platform: TAOBAO, run_at: BILL_DAY_START, status: 'done' };
const FAILED_RUN = { job: 'bill', platform: TAOBAO, run_at: BILL_DAY_START, status: 'failed' };
const BILL_PAYLOAD = { app_id: APP, platform: TAOBAO, accounting_date: BILL_DAY };

/** The assembled worker module on pg-boss of `db`, its timer held; runs `body` with its handler. */
async function withAssembled(
  db: Kysely<DB>,
  clock: FixedClock,
  ports: SettlementWorkerPorts,
  calls: PortCalls,
  body: (h: { handler: JobHandler; queue: FakeQueue }) => Promise<void>,
): Promise<void> {
  const SettlementModule = await settlementModule();
  await withRealQueue(db, async (queue) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let context: NestContext | undefined;
    try {
      context = await workerContext(SettlementModule.forWorker(ports), {
        clock,
        logger: silentRootLogger(),
        db,
        queue,
        crypto: FAKE_CRYPTO,
        events: fakeEventBus(calls),
      });
      await body({ handler: settleHandler(queue), queue });
    } finally {
      if (context !== undefined) await context.close();
      vi.useRealTimers();
    }
  });
}

/** One catch-up round on `queue` with a fresh store (as a restarted worker would decide). */
async function catchUp(
  db: Kysely<DB>,
  clock: FixedClock,
  queue: FakeQueue,
  ports: SettlementWorkerPorts,
): Promise<void> {
  await seedSettleBillCatchUp({
    db,
    clock,
    queue,
    logger: memoryLogger().logger,
    runs: createSettleCatchUpStore(db),
    platforms: [TAOBAO],
    config: ports.config(db, clock),
  });
}

function rejectedWith(ran: Awaited<ReturnType<typeof deliver>>, text: string): boolean {
  return ran !== null && 'rejected' in ran.outcome && ran.outcome.rejected.includes(text);
}

it(
  '[AC-B2-04zg#9] 账单日整日停机：次日补出账补投 07-24 的 bill，快照前提按补跑当天（07-25 → 查 07-24 的快照）判定，生成账单月 2032-06 恰一次；同日再补、隔天补、新的存储都不再送，重放同一任务不重复生成；更早的 06-24 不补；到下个账单日才轮到 2032-07',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const order = await seedOrder(db, APP, TAOBAO);
      const clock = new FixedClock(DAY_AFTER_NOW);
      const { ports, calls, switches } = recordingPorts({
        snapshot: 'complete',
        config: new Map(),
      });
      await withAssembled(db, clock, ports, calls, async ({ handler, queue }) => {
        // The whole bill day was missed: nothing was queued or run for it.
        expect(await jobsUnder(db, billKey(APP, TAOBAO, BILL_DAY))).toStrictEqual([]);

        await catchUp(db, clock, queue, ports);
        const live = await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY));
        expect(live.map((job) => job.payload)).toStrictEqual([BILL_PAYLOAD]);
        expect(await jobsUnder(db, billKey(APP, TAOBAO, PREV_BILL_DAY))).toStrictEqual([]);

        const ran = await deliver(db, handler, billKey(APP, TAOBAO, BILL_DAY));
        expect(ran?.outcome).toStrictEqual({ resolved: true });
        expect(switches.snapshotDays.length).toBeGreaterThan(0);
        expect([...new Set(switches.snapshotDays)]).toStrictEqual(['2032-07-24']);
        expect(await billRunsOf(db, APP)).toStrictEqual([DONE_RUN]);
        const generated = [
          { billId: BILL_MONTH, generatedAt: DAY_AFTER_NOW, counts: { [TAOBAO]: 0 } },
        ];
        expect(await billsOf(db, APP)).toStrictEqual(generated);
        // B2-18a：无结算数据的单只计入应结未结数，补出账的 bill 不再登记 settle_missing。
        expect(
          calls.diffs.map((diff) => ({ type: diff.type, period: diff.period, refId: diff.refId })),
        ).not.toContainEqual({ type: 'settle_missing', period: BILL_MONTH, refId: order.key });
        expect(
          calls.diffs.map((diff) => ({ type: diff.type, period: diff.period, refId: diff.refId })),
        ).toStrictEqual([]);

        // Generated: the same day, the next day and the last day of the period send nothing.
        const sentBefore = queue.sent.length;
        for (const now of [DAY_AFTER_NOW, '2032-07-26T01:00:00.000Z', '2032-08-23T15:59:59.999Z']) {
          clock.set(now);
          await catchUp(db, clock, queue, ports);
        }
        expect(queue.sent.slice(sentBefore).map(plainView)).toStrictEqual([]);
        expect(await liveJobsUnder(db, billKey(APP, TAOBAO, BILL_DAY))).toStrictEqual([]);

        // A replayed delivery of the same bill: nothing generated again.
        clock.set(DAY_AFTER_NOW);
        expect(await outcomeOf(() => handler(receivedJob(BILL, BILL_PAYLOAD)))).toStrictEqual({
          resolved: true,
        });
        expect(await billRunsOf(db, APP)).toStrictEqual([DONE_RUN]);
        expect(await billsOf(db, APP)).toStrictEqual(generated);
        expect(calls.diffs).toHaveLength(0);

        // The next bill day: the 2032-07 period is the one looked back at.
        clock.set('2032-08-24T02:00:00.000Z');
        await catchUp(db, clock, queue, ports);
        expect(queue.sent.slice(sentBefore).map(plainView)).toStrictEqual([
          plainBillSend(APP, TAOBAO, NEXT_BILL_DAY),
        ]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zg#10] 账单日 bill 全失败（进死信、settle_jobs failed，CouliSettleBillJobFailed 计 1）→ 次日补出账再投同一期；补跑仍失败照旧是同一行 failed（告警计数仍 1）、不生成账单；之后补跑成功生成 2032-06，failed 清零，不再补送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      const clock = new FixedClock(BILL_DAY_NOW);
      const { ports, calls, switches } = recordingPorts({
        snapshot: 'complete',
        config: new Map(),
      });
      const { logger } = memoryLogger();
      await withAssembled(db, clock, ports, calls, async ({ handler, queue }) => {
        // The bill day: the daily seed sends the bill; it fails until it ends in settle.dead.
        switches.failUnion = true;
        await seedSettleBills({
          db,
          clock,
          queue,
          logger,
          runs: createSettleRunStore(db),
          platforms: [TAOBAO],
        });
        const onBillDay = await deliver(db, handler, billKey(APP, TAOBAO, BILL_DAY));
        expect(rejectedWith(onBillDay, 'synthetic union read failure')).toBe(true);
        expect(await billRunsOf(db, APP)).toStrictEqual([FAILED_RUN]);
        expect(await failedBillRunCount(db)).toBe(1);
        expect(await billsOf(db, APP)).toStrictEqual([]);

        // The next morning, still failing: the catch-up sends the same period; the rerun fails.
        clock.set('2032-07-25T01:00:00.000Z');
        await catchUp(db, clock, queue, ports);
        const rerun = await deliver(db, handler, billKey(APP, TAOBAO, BILL_DAY));
        expect(rerun?.payload).toStrictEqual(BILL_PAYLOAD);
        expect(rejectedWith(rerun, 'synthetic union read failure')).toBe(true);
        expect(await billRunsOf(db, APP)).toStrictEqual([FAILED_RUN]);
        expect(await failedBillRunCount(db)).toBe(1);
        expect(await billsOf(db, APP)).toStrictEqual([]);

        // Later that day the union read is back: the next catch-up generates 2032-06.
        switches.failUnion = false;
        clock.set(DAY_AFTER_NOW);
        await catchUp(db, clock, queue, ports);
        const healed = await deliver(db, handler, billKey(APP, TAOBAO, BILL_DAY));
        expect(healed?.outcome).toStrictEqual({ resolved: true });
        expect(await billRunsOf(db, APP)).toStrictEqual([DONE_RUN]);
        expect(await failedBillRunCount(db)).toBe(0);
        expect(
          (await billsOf(db, APP)).map((bill) => ({
            billId: bill.billId,
            generatedAt: bill.generatedAt,
          })),
        ).toStrictEqual([{ billId: BILL_MONTH, generatedAt: DAY_AFTER_NOW }]);

        // Generated: nothing more is sent.
        const sentBefore = queue.sent.length;
        await catchUp(db, clock, queue, ports);
        expect(queue.sent.slice(sentBefore).map(plainView)).toStrictEqual([]);
      });
    });
  },
  TIMEOUT,
);
