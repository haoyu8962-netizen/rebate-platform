// B2-04zo：跨 App 不串，一个 app 失败不影响其他 app。枚举口径与日终校验相同：有账本账户的 app；只有订单没有账户的 app 不写。
// 失败用 Kysely 插件在该 app 的快照 INSERT 上抛错（真实事务回滚），报错文本带一段合成的个人数据：日志里不能出现。
// 失败的 app 放在中间，升序、降序枚举都能看出「一个失败就中断」。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { account, pair, platform, voucher } from '../../db/ledger/invariants/kit.ts';
import { existingSnapshot } from '../asset-snapshot/kit.ts';
import { scope, seed } from '../../settlement/pending-earnings/fixtures.ts';
import {
  ADVANCE_KEY,
  APP,
  BEFORE,
  DAY,
  LOG_WARN,
  OTHER,
  THIRD,
  TIMEOUT,
  alertEvents,
  book,
  comparable,
  days,
  exposure,
  failSnapshotWrite,
  inWorkerTime,
  ledgerApp,
  receivablesOf,
  runAt,
  setConfig,
  snapshotLogs,
  snapshotRows,
  timedOut,
  union,
} from './kit.ts';

const PRIVATE_DETAIL = 'synthetic-phone-13800000000';

it(
  '[AC-B2-04zo#22] 跨 App 不串：各 app 的金额、应收、阈值与补写进度各算各的；只有订单没有账本账户的 app 不写',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const first = await account(db, { app_id: APP });
      const second = await account(db, { app_id: OTHER });
      await pair(
        db,
        first,
        await platform(db, 'CASH_ALIPAY', APP),
        await voucher(db, { app_id: APP, accounting_date: DAY }),
        -500n,
      );
      await pair(
        db,
        second,
        await platform(db, 'CASH_ALIPAY', OTHER),
        await voucher(db, { app_id: OTHER, accounting_date: DAY }),
        -7n,
      );
      await book(db, await union(db, APP), DAY, 300n);
      await book(db, await union(db, OTHER), DAY, 50n);
      await setConfig(db, APP, ADVANCE_KEY, 100);
      await existingSnapshot(db, APP, '2032-06-13');
      const orderOnly = await scope(db);
      await seed(db, orderOnly);

      await withWorker({ now: runAt(DAY) }, async (worker) => {
        expect(
          await worker.tickUntil(
            async () => (await comparable(db, APP, DAY)) && (await comparable(db, OTHER, DAY)),
          ),
          'the two apps were not written',
        ).toBe(true);
        await worker.quiet();
      });

      expect(await days(db, APP)).toEqual(['2032-06-13', BEFORE, DAY]);
      expect(await days(db, OTHER)).toEqual([DAY]);
      expect(await days(db, orderOnly.appId)).toEqual([]);
      const own = (await snapshotRows(db, APP)).at(-1);
      const theirs = (await snapshotRows(db, OTHER)).at(-1);
      expect(own).toMatchObject({ total_available_positive_fen: 500n });
      expect(theirs).toMatchObject({ total_available_positive_fen: 7n });
      expect(await receivablesOf(db, APP, DAY)).toEqual([
        { platform: 'taobao', union_receivable_fen: 300n },
      ]);
      expect(await receivablesOf(db, OTHER, DAY)).toEqual([
        { platform: 'taobao', union_receivable_fen: 50n },
      ]);
      const events = await alertEvents(db, APP);
      expect(events).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining([timedOut(APP, BEFORE), exposure(APP, DAY, 300, 100)]),
      );
      expect(await alertEvents(db, OTHER)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#23] 一个 app 抛错其余照写；下个 tick 自然重试；日志只记 app，不含报错文本里的个人数据',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      for (const appId of [APP, OTHER, THIRD]) await ledgerApp(db, appId);
      const failing = new Set([OTHER]);
      const handle = db.withPlugin(failSnapshotWrite(failing, PRIVATE_DETAIL));
      await withWorker({ now: runAt(DAY), db: handle }, async (worker) => {
        expect(
          await worker.tickUntil(
            async () => (await comparable(db, APP, DAY)) && (await comparable(db, THIRD, DAY)),
          ),
          'a failing app stopped the others',
        ).toBe(true);
        await worker.quiet();
        expect(await days(db, OTHER)).toEqual([]);
        expect(snapshotLogs(worker.logs(), OTHER, LOG_WARN).length).toBeGreaterThan(0);

        failing.clear();
        expect(
          await worker.tickUntil(() => comparable(db, OTHER, DAY)),
          'the failed app was not written by a later tick',
        ).toBe(true);
        expect(await days(db, APP)).toEqual([DAY]);
        expect(await days(db, THIRD)).toEqual([DAY]);
        expect(JSON.stringify(worker.logs())).not.toContain(PRIVATE_DETAIL);
      });
    });
  },
  TIMEOUT,
);
