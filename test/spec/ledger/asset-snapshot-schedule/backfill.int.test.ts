// B2-04zo：漏跑补写走真实 worker 入口。从该 app 最新快照的下一天补到最新到期的 D，最多 7 天，由旧到新；更早的缺口写一条
// error 日志不补；一行快照都没有的 app 只写最新到期的 D，不造历史。迟到的写入由现有 run 判 timed_out、
// waiting_comparable=false，00:30 内的 comparable。「最新快照」用夹具行表示停机前写到哪一天。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { getAssetSnapshotStatus } from '../../../../apps/api/src/modules/ledger/index.ts';
import { existingSnapshot } from '../asset-snapshot/kit.ts';
import {
  ADVANCE_KEY,
  APP,
  BEFORE,
  DAY,
  LOG_ERROR,
  NEXT_DAY,
  TIMEOUT,
  afterMidnight,
  alertEvents,
  book,
  comparable,
  days,
  hasDay,
  inWorkerTime,
  ledgerApp,
  runAt,
  setConfig,
  snapshotLogs,
  snapshotRows,
  timedOut,
  union,
} from './kit.ts';

it(
  '[AC-B2-04zo#16] 停机两天后恢复：补两天，由旧到新；00:30 后写的 waiting_comparable=false 且 timed_out（状态仍 complete），00:30 内写的 comparable',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await existingSnapshot(db, APP, BEFORE);
      await book(db, await union(db, APP), '2032-06-10', 5n);
      await setConfig(db, APP, ADVANCE_KEY, 0);
      await withWorker({ now: afterMidnight(NEXT_DAY, '20:00') }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, NEXT_DAY)),
          'the two missed days were not written',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual([BEFORE, DAY, NEXT_DAY]);
        const rows = await snapshotRows(db, APP);
        expect(rows.map((row) => row.waiting_comparable)).toEqual([true, false, true]);

        const events = await alertEvents(db, APP);
        // 写入顺序：先 D（垫资、超时两条），后 D+1（垫资一条）。
        expect(events.map((event) => event.data['accounting_date'])).toEqual([DAY, DAY, NEXT_DAY]);
        expect(events.filter((event) => event.name === timedOut(APP, DAY).name)).toEqual([
          timedOut(APP, DAY),
        ]);

        expect(
          await getAssetSnapshotStatus(db, { appId: APP, accountingDate: DAY }, worker.clock),
        ).toEqual({ state: 'complete', snapshotId: rows[1]!.id, waitingComparable: false });
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#17] 00:30 的边界：00:29:59 写的 comparable，00:30:00 写的 waiting_comparable=false 且 timed_out',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, BEFORE);
      await withWorker({ now: afterMidnight(DAY, '29:59') }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, DAY)),
          'a write at 00:29:59 is in time',
        ).toBe(true);
        expect(await alertEvents(db, APP)).toEqual([]);

        worker.clock.set(afterMidnight(NEXT_DAY, '30:00'));
        expect(
          await worker.tickUntil(() => hasDay(db, APP, NEXT_DAY)),
          'the next day was not written',
        ).toBe(true);
        await worker.quiet();
        expect(await comparable(db, APP, NEXT_DAY)).toBe(false);
        expect(await alertEvents(db, APP)).toEqual([timedOut(APP, NEXT_DAY)]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#18] 没有历史的 app 不造历史：只写最新到期的 D，之后的 tick 也不往前补',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await withWorker({ now: afterMidnight('2032-06-20', '05:00') }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, '2032-06-20')),
          'the newest due day was not written',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual(['2032-06-20']);
        expect(snapshotLogs(worker.logs(), APP, LOG_ERROR)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#19] 缺口正好 7 天：全部补上，不报错',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, '2032-06-01');
      await withWorker({ now: afterMidnight('2032-06-08', '05:00') }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, '2032-06-08')),
          'the 7-day gap was not filled',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual([
          '2032-06-01',
          '2032-06-02',
          '2032-06-03',
          '2032-06-04',
          '2032-06-05',
          '2032-06-06',
          '2032-06-07',
          '2032-06-08',
        ]);
        expect(snapshotLogs(worker.logs(), APP, LOG_ERROR)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#20] 缺口超过 7 天：只补最新的 7 天，更早的不补，只写一条 error 日志，之后的 tick 不再报也不再补',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, '2032-06-01');
      await withWorker({ now: afterMidnight('2032-06-11', '05:00') }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, '2032-06-11')),
          'the newest due day was not written',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual([
          '2032-06-01',
          '2032-06-05',
          '2032-06-06',
          '2032-06-07',
          '2032-06-08',
          '2032-06-09',
          '2032-06-10',
          '2032-06-11',
        ]);
        expect(snapshotLogs(worker.logs(), APP, LOG_ERROR)).toHaveLength(1);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#21] 补写跨月、跨闰日：按日历逐日写，迟到的不可比、最新一天可比',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, '2032-02-27');
      await withWorker({ now: runAt('2032-03-01') }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, '2032-03-01')),
          'the gap over the leap day was not filled',
        ).toBe(true);
        await worker.quiet();
        const rows = await snapshotRows(db, APP);
        expect(rows.map((row) => [row.day, row.waiting_comparable])).toEqual([
          ['2032-02-27', true],
          ['2032-02-28', false],
          ['2032-02-29', false],
          ['2032-03-01', true],
        ]);
      });
    });
  },
  TIMEOUT,
);
