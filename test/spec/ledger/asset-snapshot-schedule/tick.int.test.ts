// B2-04zo：tick 本身的健壮性，走真实 worker 入口（规则测试评审第 1 轮）。每次 tick 重新枚举 app，启动后才开第一个账户的
// app 也会写；枚举失败不把定时器卡死，下一次 tick 照常；定时的下界：首次不早于约 15 秒，之后不早于约 60 秒。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  APP,
  DAY,
  FIRST_TICK_MS,
  NEXT_DAY,
  OTHER,
  TICK_MS,
  TIMEOUT,
  comparable,
  days,
  failAppListing,
  hasDay,
  inWorkerTime,
  ledgerApp,
  pause,
  runAt,
  waitFor,
} from './kit.ts';

/** How far short of a tick the lower bounds stop. */
const MARGIN_MS = 1_000;

it(
  '[AC-B2-04zo#32] 每次 tick 重新枚举 app：一轮 tick 跑完之后才开第一个账户的 app，下一次 tick 写它最新到期的 D',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await withWorker({ now: runAt(DAY) }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, DAY)),
          'the first app was not written',
        ).toBe(true);
        await worker.quiet();

        await ledgerApp(db, OTHER);
        expect(
          await worker.tickUntil(() => comparable(db, OTHER, DAY)),
          'an app opened after boot was not listed',
        ).toBe(true);
        expect(await days(db, OTHER)).toEqual([DAY]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#33] 枚举 app 失败：不写、不把定时器卡死，故障解除后下一次 tick 写该写的天',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      const fault = failAppListing();
      await withWorker({ now: runAt(DAY), db: db.withPlugin(fault.plugin) }, async (worker) => {
        expect(
          await worker.tickUntil(async () => fault.tripped() > 0),
          'no tick listed the apps',
        ).toBe(true);
        // 三次 tick 都落在故障里：日终校验的枚举同样会触发 tripped，它不证明快照的 tick 跑到了这里。
        await worker.quiet();
        expect(await days(db, APP)).toEqual([]);

        fault.clear();
        expect(
          await worker.tickUntil(() => comparable(db, APP, DAY)),
          'a failed list stopped the later ticks',
        ).toBe(true);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#34] 定时的下界：差 1 秒到首次延迟时没有 tick；首次 tick 之后差 1 秒到 60 秒时也没有',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await withWorker({ now: runAt(DAY) }, async (worker) => {
        await vi.advanceTimersByTimeAsync(FIRST_TICK_MS - MARGIN_MS);
        await pause(300);
        expect(await days(db, APP), 'a tick ran before the first delay').toEqual([]);

        await vi.advanceTimersByTimeAsync(2 * MARGIN_MS);
        expect(
          await waitFor(() => comparable(db, APP, DAY)),
          'no first tick about 15 seconds after bootstrap',
        ).toBe(true);
        await pause(200);

        // 假时钟现在是首次 tick 之后 1 秒，再推 58 秒就是差 1 秒到 60 秒。
        worker.clock.set(runAt(NEXT_DAY));
        await vi.advanceTimersByTimeAsync(TICK_MS - 2 * MARGIN_MS);
        await pause(300);
        expect(await hasDay(db, APP, NEXT_DAY), 'a tick ran before 60 seconds').toBe(false);

        await vi.advanceTimersByTimeAsync(3 * MARGIN_MS);
        expect(
          await waitFor(() => comparable(db, APP, NEXT_DAY)),
          'no tick after the 60 seconds',
        ).toBe(true);
      });
    });
  },
  TIMEOUT,
);
