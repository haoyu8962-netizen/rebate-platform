// B2-04zo：失败后的恢复，走真实 worker 入口（规则测试评审第 1 轮的裁定）。
// 补写：一个 app 内某天失败，本 tick 不继续写该 app 更新的天，下个 tick 从缺的最旧一天重来；判「缺」不只看最新一行，
// newest 之前 7 天窗口内的空洞也要补，窗口更早的只写一条 error 日志。
// 重放未确认：窗口内 waiting_comparable=false 的行，00:30 前一律重放确认；过了 00:30，只有 event_log 里还没有该
// (app, D) 的 asset_snapshot.timed_out 时重放一次让 runner 发告警；已有事件的行不再碰，每分钟不重复告警。
// 故障都是 Kysely 插件在真实语句上抛错，事务真实回滚。「最新快照」与未确认的行用夹具行表示。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { existingSnapshot } from '../asset-snapshot/kit.ts';
import {
  APP,
  BEFORE,
  DAY,
  LOG_ERROR,
  NEXT_DAY,
  OTHER,
  TIMEOUT,
  afterMidnight,
  alertEvents,
  book,
  comparable,
  days,
  eventLines,
  failConfirmOnce,
  failSnapshotDay,
  hasDay,
  inWorkerTime,
  ledgerApp,
  pause,
  receivablesOf,
  runAt,
  snapshotLogs,
  snapshotRows,
  timedOut,
  union,
} from './kit.ts';

const TIMEOUT_LOG = 'asset_snapshot_timeout';

it(
  '[AC-B2-04zo#25] 补写中较旧的一天写失败：本 tick 不写该 app 更新的天，别的 app 照写；故障解除后从缺的最旧一天起由旧到新补齐',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, BEFORE);
      await ledgerApp(db, OTHER);
      const fault = failSnapshotDay(APP, DAY);
      const handle = db.withPlugin(fault.plugin);
      await withWorker({ now: afterMidnight(NEXT_DAY, '20:00'), db: handle }, async (worker) => {
        expect(
          await worker.tickUntil(async () => fault.tripped() > 0),
          'no tick tried the older day',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP), 'a newer day passed the failed one').toEqual([BEFORE]);
        expect(fault.attempts()).not.toContain(NEXT_DAY);
        expect(await days(db, OTHER), 'one failed day stopped the other app').toEqual([NEXT_DAY]);

        fault.clear();
        expect(
          await worker.tickUntil(() => comparable(db, APP, NEXT_DAY)),
          'the failed day and the one after it were not written',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual([BEFORE, DAY, NEXT_DAY]);
        expect(fault.attempts().slice(-2)).toEqual([DAY, NEXT_DAY]);
        const rows = await snapshotRows(db, APP);
        expect(rows.map((row) => row.waiting_comparable)).toEqual([true, false, true]);
        expect(await alertEvents(db, APP)).toEqual([timedOut(APP, DAY)]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#26] newest 之前的空洞：最新一行已到最新到期的 D 也要补；金额照该日，迟到的不可比且 timed_out，别的行不动',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const receivable = await union(db, APP);
      await book(db, receivable, '2032-06-10', 5n);
      await book(db, receivable, NEXT_DAY, 7n);
      await existingSnapshot(db, APP, BEFORE);
      await existingSnapshot(db, APP, NEXT_DAY);
      await withWorker({ now: afterMidnight(NEXT_DAY, '05:00') }, async (worker) => {
        expect(
          await worker.tickUntil(() => hasDay(db, APP, DAY)),
          'the hole before the newest row was not filled',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual([BEFORE, DAY, NEXT_DAY]);
        const rows = await snapshotRows(db, APP);
        expect(rows.map((row) => row.waiting_comparable)).toEqual([true, false, true]);
        expect(await receivablesOf(db, APP, DAY)).toEqual([
          { platform: 'taobao', union_receivable_fen: 5n },
        ]);
        expect(await alertEvents(db, APP)).toEqual([timedOut(APP, DAY)]);
        expect(snapshotLogs(worker.logs(), APP, LOG_ERROR)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#27] 空洞跨出 7 天窗口：窗口内的补上，更早的不补，只写一条 error 日志',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, '2032-06-01');
      await existingSnapshot(db, APP, '2032-06-20');
      await withWorker({ now: afterMidnight('2032-06-20', '05:00') }, async (worker) => {
        expect(
          await worker.tickUntil(() => hasDay(db, APP, '2032-06-19')),
          'the hole inside the window was not filled',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual([
          '2032-06-01',
          '2032-06-14',
          '2032-06-15',
          '2032-06-16',
          '2032-06-17',
          '2032-06-18',
          '2032-06-19',
          '2032-06-20',
        ]);
        expect(snapshotLogs(worker.logs(), APP, LOG_ERROR)).toHaveLength(1);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#28] 确认事务失败：行已提交且不可比；00:30 前的下一次 tick 确认成可比，不写第二行，不发超时告警',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      const fault = failConfirmOnce();
      await withWorker({ now: runAt(DAY), db: db.withPlugin(fault.plugin) }, async (worker) => {
        expect(
          await worker.tickUntil(async () => fault.tripped() > 0),
          'no tick reached the confirmation',
        ).toBe(true);
        expect(await days(db, APP)).toEqual([DAY]);
        expect(await comparable(db, APP, DAY)).toBe(false);

        worker.clock.set(afterMidnight(DAY, '02:00'));
        expect(
          await worker.tickUntil(() => comparable(db, APP, DAY)),
          'a later tick did not confirm the committed row',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, APP)).toEqual([DAY]);
        expect(await alertEvents(db, APP)).toEqual([]);
        expect(eventLines(worker.logs(), TIMEOUT_LOG)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#29] 新进程在 00:29:59 看到未确认的行：照样确认成可比（看的是库里的行，不是进程内状态）',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, DAY, false);
      await withWorker({ now: afterMidnight(DAY, '29:59') }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, DAY)),
          'the unconfirmed row was left as it was',
        ).toBe(true);
        expect(await days(db, APP)).toEqual([DAY]);
        expect(await alertEvents(db, APP)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#30] 确认失败、过了 00:30 才恢复：行保持不可比，超时事件与日志各一条，之后的 tick 和新进程都不再碰',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      const fault = failConfirmOnce();
      await withWorker({ now: runAt(DAY), db: db.withPlugin(fault.plugin) }, async (worker) => {
        expect(
          await worker.tickUntil(async () => fault.tripped() > 0),
          'no tick reached the confirmation',
        ).toBe(true);
        // 等失败的这次 run 走完：它在 00:30 前失败，不该留下超时日志。
        await pause(200);

        worker.clock.set(afterMidnight(DAY, '31:00'));
        expect(
          await worker.tickUntil(async () => (await alertEvents(db, APP)).length > 0),
          'the timeout of the unconfirmed day was never alerted',
        ).toBe(true);
        const settled = await snapshotRows(db, APP);
        await worker.quiet();
        expect(await snapshotRows(db, APP)).toEqual(settled);
        expect(await alertEvents(db, APP)).toEqual([timedOut(APP, DAY)]);
        expect(eventLines(worker.logs(), TIMEOUT_LOG)).toHaveLength(1);
      });
      expect(await comparable(db, APP, DAY)).toBe(false);

      await withWorker({ now: afterMidnight(DAY, '31:00') }, async (next) => {
        await next.quiet();
        expect(await alertEvents(db, APP)).toEqual([timedOut(APP, DAY)]);
        expect(eventLines(next.logs(), TIMEOUT_LOG)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#31] 未确认行的窗口边界：窗口最旧一天（D−6）过了 00:30、没有事件的告警一次并保持不可比，窗口外（D−7）的不碰',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, '2032-06-04', false);
      await existingSnapshot(db, APP, '2032-06-05', false);
      for (const day of ['2032-06-06', '2032-06-07', '2032-06-08', '2032-06-09', '2032-06-10']) {
        await existingSnapshot(db, APP, day);
      }
      await withWorker({ now: afterMidnight('2032-06-11', '05:00') }, async (worker) => {
        expect(
          await worker.tickUntil(
            async () =>
              (await comparable(db, APP, '2032-06-11')) && (await alertEvents(db, APP)).length > 0,
          ),
          'the unconfirmed day of the window was never alerted',
        ).toBe(true);
        await worker.quiet();
        expect(await alertEvents(db, APP)).toEqual([timedOut(APP, '2032-06-05')]);
        expect(eventLines(worker.logs(), TIMEOUT_LOG)).toHaveLength(1);
        const rows = await snapshotRows(db, APP);
        expect(rows.map((row) => [row.day, row.waiting_comparable])).toEqual([
          ['2032-06-04', false],
          ['2032-06-05', false],
          ['2032-06-06', true],
          ['2032-06-07', true],
          ['2032-06-08', true],
          ['2032-06-09', true],
          ['2032-06-10', true],
          ['2032-06-11', true],
        ]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#35] 超时事件按 (app, D) 判：同 app 别的天、别的 app 同一天已有事件都挡不住；(APP, D+1) 与 (OTHER, D) 的事件与日志各新增一条',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      // (APP, D) 的既有事件走真实路径：迟到写入，事件随写事务落库，此时 OTHER 还没有账本账户。
      await ledgerApp(db, APP);
      await withWorker({ now: afterMidnight(DAY, '40:00') }, async (worker) => {
        expect(
          await worker.tickUntil(async () => (await alertEvents(db, APP)).length > 0),
          'the late day and its timeout event were not written',
        ).toBe(true);
      });
      expect(await alertEvents(db, APP)).toEqual([timedOut(APP, DAY)]);

      await existingSnapshot(db, APP, NEXT_DAY, false);
      await ledgerApp(db, OTHER);
      await existingSnapshot(db, OTHER, DAY, false);
      await existingSnapshot(db, OTHER, NEXT_DAY);

      await withWorker({ now: afterMidnight(NEXT_DAY, '31:00') }, async (worker) => {
        expect(
          await worker.tickUntil(
            async () =>
              (await alertEvents(db, APP)).length > 1 && (await alertEvents(db, OTHER)).length > 0,
          ),
          'an event of another day or another app hid an unconfirmed day',
        ).toBe(true);
        await worker.quiet();
        expect(await alertEvents(db, APP)).toEqual([timedOut(APP, DAY), timedOut(APP, NEXT_DAY)]);
        expect(await alertEvents(db, OTHER)).toEqual([timedOut(OTHER, DAY)]);
        const lines = eventLines(worker.logs(), TIMEOUT_LOG).map((line) => [
          line['app_id'],
          line['accounting_date'],
        ]);
        expect(lines).toHaveLength(2);
        expect(lines).toEqual(
          expect.arrayContaining([
            [APP, NEXT_DAY],
            [OTHER, DAY],
          ]),
        );
        const dayRows = async (appId: string) =>
          (await snapshotRows(db, appId)).map((row) => [row.day, row.waiting_comparable]);
        expect(await dayRows(APP)).toEqual([
          [DAY, false],
          [NEXT_DAY, false],
        ]);
        expect(await dayRows(OTHER)).toEqual([
          [DAY, false],
          [NEXT_DAY, true],
        ]);
      });
    });
  },
  TIMEOUT,
);
