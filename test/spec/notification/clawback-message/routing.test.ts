// B1-12zc wiring (D10-773 ①; task brief §9.3): one notification consumer subscribes to both
// order.clawed_back and order.settle_adjusted; its evt queue, the worker plan and the real
// AppModule's registration. Unit tests: no database (a dummy Kysely that records any statement).
// Top-level it() only.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import { EVENT_SUBSCRIPTIONS } from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { assembled } from '../risk-state-message/worker-kit.ts';

const CONSUMER = 'notification-clawback';
const QUEUE = 'evt.notification-clawback';
const NOW = '2026-11-07T09:08:07.006Z';

it('[AC-B1-12zc#26] order.clawed_back 与 order.settle_adjusted 各有且仅有本任务这一个订阅者（同一消费者两件事件）；evt 队列 standard、有死信；只有 worker 计划消费，并发 5', () => {
  expect(EVENT_SUBSCRIPTIONS.filter((sub) => sub.consumer === CONSUMER)).toEqual([
    { consumer: CONSUMER, events: ['order.clawed_back', 'order.settle_adjusted'] },
  ]);
  for (const name of ['order.clawed_back', 'order.settle_adjusted']) {
    const subscribers = EVENT_SUBSCRIPTIONS.filter((sub) => sub.events.includes(name));
    expect(subscribers.map((sub) => sub.consumer)).toEqual([CONSUMER]);
  }
  expect(QUEUE_CATALOG.filter((queue) => queue.name === QUEUE)).toEqual([
    expect.objectContaining({ name: QUEUE, policy: 'standard', deadLetter: `${QUEUE}.dead` }),
  ]);
  expect(QUEUE_CATALOG.filter((queue) => queue.name === `${QUEUE}.dead`)).toHaveLength(1);
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === QUEUE)).toEqual([
    { queue: QUEUE, concurrency: 5, pollingIntervalSeconds: 2 },
  ]);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(ENTRY_PLAN[entry].filter((work) => work.queue === QUEUE)).toEqual([]);
  }
});

it('[AC-B1-12zc#27] 真 AppModule 只在 worker 注册一次消费者，启动装配不发消息、不查业务库', async () => {
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
  try {
    const seen: Record<string, number> = {};
    for (const entry of ['worker', 'api', 'stream', 'admin', 'payout']) {
      const app = await assembled(entry, db, new FixedClock(NOW));
      try {
        seen[entry] = app.registrations.filter((r) => r.name === QUEUE).length;
        expect(app.sends).not.toHaveBeenCalled();
        expect(queries).toEqual([]);
      } finally {
        await app.close();
      }
    }
    expect(seen).toEqual({ worker: 1, api: 0, stream: 0, admin: 0, payout: 0 });
  } finally {
    await db.destroy();
  }
});
