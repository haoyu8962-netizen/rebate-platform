// B2-04zo：定时器走真实 worker 入口。首次延迟与 60 秒间隔；D+1 00:00:59 不写 D、00:01:00 写 D，字段照 BR-FUND-18、
// 余额按 accounting_date ≤ D；再次 tick 不重复写、不重复告警；两个进程并发只有一行；销毁等在途 tick、之后不再写，
// 新进程起来从快照行接着写（没有进程内状态）。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { account, entry, pair, platform, voucher } from '../../db/ledger/invariants/kit.ts';
import { scope, seed } from '../../settlement/pending-earnings/fixtures.ts';
import {
  ADVANCE_KEY,
  APP,
  BEFORE,
  DAY,
  FIRST_TICK_MS,
  NEXT_DAY,
  OTHER,
  LOG_ERROR,
  TICK_MS,
  TIMEOUT,
  afterMidnight,
  alertEvents,
  book,
  comparable,
  days,
  exposure,
  hasDay,
  inWorkerTime,
  ledgerApp,
  pause,
  receivablesOf,
  runAt,
  setConfig,
  snapshotGate,
  snapshotLogs,
  snapshotRows,
  timedOut,
  union,
  waitFor,
} from './kit.ts';

it(
  '[AC-B2-04zo#8] 定时：启动时不立刻跑，约 15 秒后首次 tick，之后每 60 秒一次',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await withWorker({ now: runAt(DAY) }, async (worker) => {
        await pause(200);
        expect(await days(db, APP), 'a tick ran before the first delay').toEqual([]);
        await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 1_000);
        expect(
          await waitFor(() => comparable(db, APP, DAY)),
          'no first tick about 15 seconds after bootstrap',
        ).toBe(true);
        await pause(200);
        worker.clock.set(runAt(NEXT_DAY));
        await vi.advanceTimersByTimeAsync(TICK_MS);
        expect(
          await waitFor(() => comparable(db, APP, NEXT_DAY)),
          'no tick within 60 seconds of the last one',
        ).toBe(true);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#9] 到点：D+1 00:00:59 不写 D，00:01:00 写 D；字段照 BR-FUND-18，余额与应收按 accounting_date ≤ D，waiting / estimated 取运行时刻',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = await scope(db);
      const appId = f.appId;
      const alice = await account(db, { app_id: appId });
      const bob = await account(db, { app_id: appId });
      const cash = await platform(db, 'CASH_ALIPAY', appId);
      const taobao = await union(db, appId);
      const jd = await union(db, appId, 'jd');
      const early = await voucher(db, { app_id: appId, accounting_date: '2032-06-01' });
      const dated = await voucher(db, { app_id: appId, accounting_date: DAY });
      const later = await voucher(db, { app_id: appId, accounting_date: NEXT_DAY });
      // 用户余额是分录合计的相反数：alice 1000 − 250 = 750，bob 100 − 400 = −300。
      await pair(db, alice, cash, early, -1000n);
      await pair(db, alice, cash, dated, 250n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await pair(db, bob, cash, early, -100n);
      await pair(db, bob, cash, dated, 400n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await pair(db, alice, cash, dated, -80n, { sub_account: 'frozen', account_version: 3n });
      await pair(db, alice, cash, later, -900n, { account_version: 4n });
      await entry(db, taobao, early, 700n);
      await entry(db, jd, dated, -30n);
      await entry(db, taobao, later, 5000n);
      // 每单 N = 1000 得 425；结算佣金 2001 得 850；hold 的 WAITING 也计入（BR-FUND-18）。
      await seed(db, f);
      await seed(db, f, { order: { est_commission_fen: 9999n, settle_commission_fen: 2001n } });
      const waiting = {
        rebate_status: 'WAITING',
        platform_status: 'RECEIVED',
        settle_period: '2026-10',
      };
      await seed(db, f, { order: waiting });
      await seed(db, f, { order: { ...waiting, hold: true } });

      await withWorker({ now: afterMidnight(DAY, '00:59') }, async (worker) => {
        // 没有历史的 app：这一刻最新到期的是 D−1，它写完才算这轮 tick 走到了 D 的判断。
        expect(
          await worker.tickUntil(() => hasDay(db, appId, BEFORE)),
          'no snapshot of the newest due day',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, appId)).toEqual([BEFORE]);

        worker.clock.set(runAt(DAY));
        expect(
          await worker.tickUntil(() => comparable(db, appId, DAY)),
          'D was not written at D+1 00:01:00',
        ).toBe(true);
        expect(await days(db, appId)).toEqual([BEFORE, DAY]);
        const [first, second] = await snapshotRows(db, appId);
        expect(first).toMatchObject({
          total_available_positive_fen: 1100n,
          total_negative_fen: 0n,
          total_frozen_fen: 0n,
          total_waiting_fen: 850n,
          total_estimated_fen: 1275n,
          waiting_comparable: false,
        });
        expect(second).toMatchObject({
          total_available_positive_fen: 750n,
          total_negative_fen: 300n,
          total_frozen_fen: 80n,
          total_waiting_fen: 850n,
          total_estimated_fen: 1275n,
          waiting_comparable: true,
          created_at: worker.clock.now(),
        });
        expect(await receivablesOf(db, appId, BEFORE)).toEqual([
          { platform: 'taobao', union_receivable_fen: 700n },
        ]);
        expect(await receivablesOf(db, appId, DAY)).toEqual([
          { platform: 'jd', union_receivable_fen: -30n },
          { platform: 'taobao', union_receivable_fen: 700n },
        ]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#10] 再次 tick：迟到的一天与准点的一天都不重复写、不重复告警（行不变，事件与告警日志各 1 条）',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await book(db, await union(db, APP), DAY, 101n);
      await setConfig(db, APP, ADVANCE_KEY, 100);
      await withWorker({ now: afterMidnight(DAY, '40:00') }, async (worker) => {
        expect(
          await worker.tickUntil(async () => (await alertEvents(db, APP)).length === 2),
          'the late day and its two alerts were not written',
        ).toBe(true);
        expect(await alertEvents(db, APP)).toEqual(
          expect.arrayContaining([exposure(APP, DAY, 101, 100), timedOut(APP, DAY)]),
        );
        const late = await snapshotRows(db, APP);
        await worker.quiet();
        expect(await snapshotRows(db, APP)).toEqual(late);
        expect(await alertEvents(db, APP)).toHaveLength(2);
        const logged = (event: string) =>
          worker.logs().filter((line) => line['event'] === event).length;
        expect(logged('ledger_advance_exposure')).toBe(1);
        expect(logged('asset_snapshot_timeout')).toBe(1);

        worker.clock.set(runAt(NEXT_DAY));
        expect(
          await worker.tickUntil(() => comparable(db, APP, NEXT_DAY)),
          'the next day was not written',
        ).toBe(true);
        const both = await snapshotRows(db, APP);
        await worker.quiet();
        expect(await snapshotRows(db, APP)).toEqual(both);
        expect(await days(db, APP)).toEqual([DAY, NEXT_DAY]);
        expect((await alertEvents(db, APP)).slice(2)).toEqual([exposure(APP, NEXT_DAY, 101, 100)]);
        expect(logged('ledger_advance_exposure')).toBe(2);
        expect(logged('asset_snapshot_timeout')).toBe(1);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#11] 两个进程同一时刻 tick：同一天只有一行、一套应收、一条告警，两边都不报错',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, boot }) => {
      await book(db, await union(db, APP), DAY, 101n);
      await setConfig(db, APP, ADVANCE_KEY, 100);
      const clock = new FixedClock(runAt(DAY));
      const left = await boot({ clock });
      const right = await boot({ clock });
      // 两个进程的定时器在同一批假时钟上，同一次推进里一起触发。
      expect(
        await left.tickUntil(() => comparable(db, APP, DAY)),
        'neither process wrote the day',
      ).toBe(true);
      await left.quiet();
      expect(await days(db, APP)).toEqual([DAY]);
      expect(await receivablesOf(db, APP, DAY)).toEqual([
        { platform: 'taobao', union_receivable_fen: 101n },
      ]);
      expect(await alertEvents(db, APP)).toEqual([exposure(APP, DAY, 101, 100)]);
      expect(snapshotLogs(left.logs(), APP, LOG_ERROR)).toEqual([]);
      expect(snapshotLogs(right.logs(), APP, LOG_ERROR)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#12] 在途 tick：慢 tick 期间不重入，销毁等它写完；销毁后不再写，新进程从快照行接着写下一天',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, boot, withWorker }) => {
      await ledgerApp(db, OTHER);
      const gate = snapshotGate();
      const clock = new FixedClock(runAt(DAY));
      const worker = await boot({ clock, db: db.withPlugin(gate.plugin) });
      try {
        expect(
          await worker.tickUntil(async () => gate.entered()),
          'no tick reached the snapshot write',
        ).toBe(true);
        for (let round = 0; round < 3; round += 1) {
          await vi.advanceTimersByTimeAsync(TICK_MS);
          await pause(100);
        }
        expect(gate.attempts(), 'a tick started over the one in flight').toBe(1);
        const closing = worker.beginClose();
        await pause(300);
        expect(closing.done, 'destroy did not wait for the tick in flight').toBe(false);
      } finally {
        gate.release();
      }
      await worker.close();
      expect(await waitFor(() => hasDay(db, OTHER, DAY)), 'the tick in flight was lost').toBe(true);

      clock.set(runAt(NEXT_DAY));
      await vi.advanceTimersByTimeAsync(3 * TICK_MS);
      await pause(300);
      expect(await days(db, OTHER), 'a destroyed module wrote').toEqual([DAY]);

      await withWorker({ clock }, async (next) => {
        expect(
          await next.tickUntil(() => comparable(db, OTHER, NEXT_DAY)),
          'the next process did not continue from the snapshot rows',
        ).toBe(true);
      });
      expect(await days(db, OTHER)).toEqual([DAY, NEXT_DAY]);
    });
  },
  TIMEOUT,
);
