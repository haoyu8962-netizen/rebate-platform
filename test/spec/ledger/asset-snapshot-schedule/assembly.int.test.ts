// B2-04zo：生产组合根连真实库。worker 入口的定时器真的写快照、告警真的经入口的 EVENT_BUS 落 event_log；API 入口
// 不写；缺 EVENT_BUS 时 assembleAssetSnapshot 同步抛错、启动被拒；没有数据库或队列时惰性；预估走 settlement 的真实
// 来源，配置读取跟随传入的只读事务。缺 EVENT_BUS 与惰性两条只构建 app.module 给的真实模块与真实入参：worker 入口
// 其余模块有的在缺 EVENT_BUS 时也会各自处理，这里只判 ledger 自己的拒绝。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import * as pendingEarnings from '../../../../apps/api/src/modules/settlement/reads/pending-earnings.ts';
import { scope, seed } from '../../settlement/pending-earnings/fixtures.ts';
import {
  fakeQueue,
  ledgerCodes,
  rejection,
  rootLogger,
  workerContext,
} from '../daily-check-schedule/kit.ts';
import {
  ADVANCE_KEY,
  APP,
  DAY,
  OTHER,
  ROOT,
  TICK_MS,
  TIMEOUT,
  alertEvents,
  assembledBy,
  book,
  comparable,
  days,
  exposure,
  inWorkerTime,
  ledgerApp,
  pause,
  runAt,
  setConfig,
  snapshotModule,
  snapshotRows,
  union,
} from './kit.ts';

it(
  '[AC-B2-04zo#4] 生产组合根：worker 入口注册定时器并拿到 EVENT_BUS（快照写库、垫资告警落 event_log），不新增队列；API 入口同一个库同一时刻不写',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await book(db, await union(db, APP), DAY, 101n);
      await setConfig(db, APP, ADVANCE_KEY, 100);
      await withWorker({ now: runAt(DAY) }, async (worker) => {
        expect(
          await worker.tickUntil(() => comparable(db, APP, DAY)),
          'the worker entry wrote no snapshot',
        ).toBe(true);
        expect(await alertEvents(db, APP)).toEqual([exposure(APP, DAY, 101, 100)]);
        const queues = worker.queue.registered.map((item) => item.queue);
        expect(queues.filter((name) => /asset|snapshot/iu.test(name))).toEqual([]);
      });

      await ledgerApp(db, OTHER);
      await withWorker({ now: runAt(DAY), entry: 'api' }, async (worker) => {
        await worker.quiet();
        expect(await days(db, OTHER)).toEqual([]);
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#5] 缺 EVENT_BUS：有库有队列时 app.module 给的模块启动即被拒（LedgerError INVALID_INPUT），不写快照',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db }) => {
      await ledgerApp(db, APP);
      const calls = await assembledBy('worker');
      expect(calls).toHaveLength(1);
      const error = await rejection(
        workerContext(snapshotModule().forWorker(...calls[0]!), {
          clock: new FixedClock(runAt(DAY)),
          logger: rootLogger().logger,
          db,
          queue: fakeQueue(),
        }),
      );
      expect(ledgerCodes(error)).toContain('INVALID_INPUT');
      expect(await days(db, APP)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#6] 惰性：没有队列或没有数据库时不注册，启动不报错（此时也不要 EVENT_BUS），时间过去也不写、不发',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db }) => {
      await ledgerApp(db, APP);
      const calls = await assembledBy('worker');
      expect(calls).toHaveLength(1);
      const target = snapshotModule();
      const clock = new FixedClock(runAt(DAY));
      const { logger } = rootLogger();
      const queue = fakeQueue();
      const withoutQueue = await workerContext(target.forWorker(...calls[0]!), {
        clock,
        logger,
        db,
      });
      const withoutDatabase = await workerContext(target.forWorker(...calls[0]!), {
        clock,
        logger,
        queue,
      });
      try {
        await vi.advanceTimersByTimeAsync(3 * TICK_MS);
        await pause(200);
        expect(await days(db, APP)).toEqual([]);
        expect(queue.registered).toEqual([]);
        expect(queue.sent).toEqual([]);
      } finally {
        await withoutQueue.close();
        await withoutDatabase.close();
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zo#7] 预估走 settlement 的真实来源：waiting / estimated 为人工算出的份额；来源的配置读取落在快照传入的只读事务上，不开第二个连接',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      const f = await scope(db);
      await ledgerApp(db, f.appId);
      // N = 1000，预留 15% 后 850，本人 50% 得 425（期望值手写，不调用待测算法）。
      await seed(db, f);
      await seed(db, f, {
        order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', settle_period: '2026-10' },
      });
      const content = (await import(
        new URL('apps/api/src/modules/content/index.ts', ROOT).href
      )) as { createContentReader(options: { readonly db: unknown }): unknown };
      const reader = vi.spyOn(content, 'createContentReader');
      const original = pendingEarnings.createPendingEarningsSource;
      const onTransaction: boolean[] = [];
      const factory = vi
        .spyOn(pendingEarnings, 'createPendingEarningsSource')
        .mockImplementation((deps) => {
          const source = original(deps);
          return {
            ...source,
            async forApp(trx, input) {
              // 同一段时间里别的模块的定时器也会建 reader，所以只问这次读有没有落在 trx 上。
              const before = reader.mock.calls.length;
              await deps.config.get(input.appId, 'credit.enabled.taobao');
              const handles = reader.mock.calls.slice(before).map(([options]) => options.db);
              onTransaction.push(handles.includes(trx));
              return source.forApp(trx, input);
            },
          };
        });
      try {
        await withWorker({ now: runAt(DAY) }, async (worker) => {
          expect(
            await worker.tickUntil(() => comparable(db, f.appId, DAY)),
            'the worker entry wrote no snapshot',
          ).toBe(true);
        });
        expect(await snapshotRows(db, f.appId)).toEqual([
          expect.objectContaining({ total_waiting_fen: 425n, total_estimated_fen: 425n }),
        ]);
        expect(onTransaction.length).toBeGreaterThan(0);
        expect(onTransaction.every(Boolean), 'a config read left the read transaction').toBe(true);
      } finally {
        factory.mockRestore();
        reader.mockRestore();
      }
    });
  },
  TIMEOUT,
);
