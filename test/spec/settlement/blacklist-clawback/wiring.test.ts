// B2-04zzl wiring (claude-independent, SPEC_REF d5713bf4): the real AppModule registers the handler of
// evt.settlement-blacklist-after-credit once, on the worker entry only (the queue, the subscription
// and the plan are in the trunk already, B2-04zzlt; here is what makes them consume). Unit test: no
// database, no port. Top-level it() only (规划/11 §4.3).
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
import { assembled, handlersOf } from '../../risk/appeal-restore/worker-kit.ts';

const QUEUE = 'evt.settlement-blacklist-after-credit';
const NOW = '2032-07-24T10:00:00+08:00';

it('[AC-B2-04zzl#11] 真 AppModule 只在 worker 入口注册一次 evt.settlement-blacklist-after-credit 处理器，其余入口不注册；装配不查库、不发消息', async () => {
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
