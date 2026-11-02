// B2-04zo：BR-FUND-20 垫资告警走真实 worker 入口。getAdvanceAlertFen 经 content 的 configValue 读
// ledger.advance_alert_fen；合计 > 阈值的每一天告警 1 次，等于阈值不告警，未设置不告警，占位值 0 是阈值而不是未设置，
// 阈值改了下一日立即生效。config_items 行由测试自己写，不依赖种子。每条都先断言当天的快照已写：否则「不告警」没有含义。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  ADVANCE_KEY,
  APP,
  DAY,
  NEXT_DAY,
  OTHER,
  THIRD,
  TIMEOUT,
  alertEvents,
  book,
  comparable,
  exposure,
  inWorkerTime,
  runAt,
  setConfig,
  union,
} from './kit.ts';

const THIRD_DAY = '2032-06-17';
const FOURTH_DAY = '2032-06-18';

it(
  '[AC-B2-04zo#13] 合计 > 阈值：按各平台合计判定，告警一次（sum_fen、threshold_fen 为整数分），之后的 tick 不再告警',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      // 单看哪个平台都不超过阈值，合计 101 超过。
      await book(db, await union(db, APP), DAY, 60n);
      await book(db, await union(db, APP, 'jd'), DAY, 41n);
      await setConfig(db, APP, ADVANCE_KEY, 100);
      await withWorker({ now: runAt(DAY) }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, DAY)),
          'the day was not written',
        ).toBe(true);
        expect(await alertEvents(db, APP)).toEqual([exposure(APP, DAY, 101, 100)]);
        await worker.quiet();
        expect(await alertEvents(db, APP)).toEqual([exposure(APP, DAY, 101, 100)]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#14] 等于阈值不告警；未设置不告警；占位值 0 是有效阈值，合计 1 分即告警',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await book(db, await union(db, APP), DAY, 100n);
      await setConfig(db, APP, ADVANCE_KEY, 100);
      await book(db, await union(db, OTHER), DAY, 100n);
      await book(db, await union(db, THIRD), DAY, 1n);
      await setConfig(db, THIRD, ADVANCE_KEY, 0);
      await withWorker({ now: runAt(DAY) }, async (worker) => {
        expect(
          await worker.tickUntil(async () => {
            const written = await Promise.all(
              [APP, OTHER, THIRD].map((appId) => comparable(db, appId, DAY)),
            );
            return written.every(Boolean);
          }),
          'the three apps were not written',
        ).toBe(true);
      });
      expect(await alertEvents(db, APP)).toEqual([]);
      expect(await alertEvents(db, OTHER)).toEqual([]);
      expect(await alertEvents(db, THIRD)).toEqual([exposure(THIRD, DAY, 1, 0)]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#15] 阈值改了下一日立即生效，超过的每一天各告警一次',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await book(db, await union(db, APP), DAY, 150n);
      await setConfig(db, APP, ADVANCE_KEY, 200);
      await withWorker({ now: runAt(DAY) }, async (worker) => {
        const written = (day: string) => () => comparable(db, APP, day);
        expect(await worker.tickUntil(written(DAY)), 'D was not written').toBe(true);
        expect(await alertEvents(db, APP)).toEqual([]);

        await setConfig(db, APP, ADVANCE_KEY, 100);
        worker.clock.set(runAt(NEXT_DAY));
        expect(await worker.tickUntil(written(NEXT_DAY)), 'D+1 was not written').toBe(true);
        expect(await alertEvents(db, APP)).toEqual([exposure(APP, NEXT_DAY, 150, 100)]);

        await setConfig(db, APP, ADVANCE_KEY, 1000);
        worker.clock.set(runAt(THIRD_DAY));
        expect(await worker.tickUntil(written(THIRD_DAY)), 'D+2 was not written').toBe(true);
        expect(await alertEvents(db, APP)).toEqual([exposure(APP, NEXT_DAY, 150, 100)]);

        await setConfig(db, APP, ADVANCE_KEY, 149);
        worker.clock.set(runAt(FOURTH_DAY));
        expect(await worker.tickUntil(written(FOURTH_DAY)), 'D+3 was not written').toBe(true);
        expect(await alertEvents(db, APP)).toEqual([
          exposure(APP, NEXT_DAY, 150, 100),
          exposure(APP, FOURTH_DAY, 150, 149),
        ]);
      });
    });
  },
  TIMEOUT,
);
