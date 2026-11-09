// B2-09gd wiring (task brief 9.2 A, 9.3 第 11 条): settlement's appeal.resolved consumer
// `settlement-order-appeal-restore`, its standard event queue with the catalog defaults, run by the
// worker entry only (concurrency 1, polling 2 s), registered once by the real AppModule on the
// worker, with an assembly that runs no statement and sends nothing. Unit test: no database, no port.
// The constants are written here because ./kit.ts reaches the test-database base. Top-level it() only.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { EVENT_SUBSCRIPTIONS } from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { assembled, handlersOf } from '../../risk/appeal-restore/worker-kit.ts';

const CONSUMER = 'settlement-order-appeal-restore';
const QUEUE = 'evt.settlement-order-appeal-restore';
const NOW = '2026-10-29T08:00:00.000Z';

it('[AC-B2-09gd#11] 装配：appeal.resolved 有生产订阅 settlement-order-appeal-restore，事件队列 evt.settlement-order-appeal-restore 为目录默认值的 standard 队列（死信 .dead），只由 worker 以并发 1、轮询 2 秒消费；真 AppModule 只在 worker 入口注册一次处理器，其余入口不注册；装配不查库、不发消息', async () => {
  expect(EVENT_SUBSCRIPTIONS.filter((sub) => sub.consumer === CONSUMER)).toEqual([
    { consumer: CONSUMER, events: ['appeal.resolved'] },
  ]);
  expect(QUEUE_CATALOG.filter((queue) => queue.name === QUEUE)).toStrictEqual([
    {
      name: QUEUE,
      policy: 'standard',
      retryLimit: 5,
      retryDelaySeconds: 10,
      retryBackoff: true,
      retryDelayMaxSeconds: 600,
      expireInSeconds: 900,
      retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800,
      deadLetter: `${QUEUE}.dead`,
    },
  ]);
  expect(QUEUE_CATALOG.filter((queue) => queue.name === `${QUEUE}.dead`)).toHaveLength(1);
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === QUEUE)).toEqual([
    { queue: QUEUE, concurrency: 1, pollingIntervalSeconds: 2 },
  ]);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].filter((work) => work.queue === QUEUE)).toEqual([]);
  }

  const queries: string[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(query) {
      queries.push(query.query.sql);
    },
  });
  const seen: Record<string, number> = {};
  try {
    for (const entry of ['worker', 'api', 'stream', 'admin', 'payout']) {
      const app = await assembled(entry, db, new FixedClock(NOW));
      try {
        seen[entry] = handlersOf(app, QUEUE).length;
        expect(app.sends).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  } finally {
    await db.destroy();
  }
  expect(seen).toStrictEqual({ worker: 1, api: 0, stream: 0, admin: 0, payout: 0 });
  expect(queries).toEqual([]);
});
