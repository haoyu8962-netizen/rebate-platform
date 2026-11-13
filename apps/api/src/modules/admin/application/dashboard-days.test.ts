import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
  type TransactionSettings,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, createRootLogger } from '../../platform/index.ts';
import {
  aggregateDashboardDay,
  dueWindow,
  newestDueDay,
  shiftDay,
  tickDashboardDays,
  yesterdayOf,
  type DashboardDayRange,
  type DashboardDaySources,
} from './dashboard-days.ts';

const at = (instant: string): Date => new FixedClock(instant).now();

it('[AC-B1-34q-UNIT#1] D 在 D+1 00:10:00 +08:00 到期：前一毫秒最新到期日仍是 D−1', () => {
  // 2032-06-16 00:09:59.999 +08:00 / 00:10:00.000 +08:00.
  expect(newestDueDay(at('2032-06-15T16:09:59.999Z'))).toBe('2032-06-14');
  expect(newestDueDay(at('2032-06-15T16:10:00.000Z'))).toBe('2032-06-15');
});

it('[AC-B1-34q-UNIT#2] 窗口是最近 7 个到期日，从早到晚，跨月照算', () => {
  expect(dueWindow(at('2032-07-02T18:00:00.000Z'))).toEqual([
    '2032-06-26',
    '2032-06-27',
    '2032-06-28',
    '2032-06-29',
    '2032-06-30',
    '2032-07-01',
    '2032-07-02',
  ]);
});

it('[AC-B1-34q-UNIT#3] 昨天按 now 的 +08:00 会计日取', () => {
  expect(yesterdayOf(at('2032-06-15T15:59:59.999Z'))).toBe('2032-06-14');
  expect(yesterdayOf(at('2032-06-15T16:00:00.000Z'))).toBe('2032-06-15');
  // 2033-01-01 00:00 +08:00: yesterday is the last day of 2032.
  expect(yesterdayOf(at('2032-12-31T16:00:00.000Z'))).toBe('2032-12-31');
});

it('[AC-B1-34q-UNIT#4] shiftDay 跨月、跨年、闰日', () => {
  const like = at('2032-01-01T00:00:00.000Z');
  expect(shiftDay('2032-03-01', -1, like)).toBe('2032-02-29');
  expect(shiftDay('2032-12-31', 1, like)).toBe('2033-01-01');
  expect(shiftDay('2032-06-15', -6, like)).toBe('2032-06-09');
  expect(() => shiftDay('2032-02-30', 0, like)).toThrow(RangeError);
});

/**
 * A Kysely over a recording driver (no database): every statement and transaction step is logged in
 * order, and `answer` gives each statement's rows.
 */
function recordingDb(answer: (sql: string) => readonly Record<string, unknown>[]): {
  readonly db: Kysely<DB>;
  readonly log: string[];
} {
  const log: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery: <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      log.push(query.sql);
      return Promise.resolve({ rows: answer(query.sql) as R[] });
    },
    streamQuery: () => {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: (_c, settings: TransactionSettings) => {
      log.push(`BEGIN ${settings.isolationLevel ?? '-'} ${settings.accessMode ?? '-'}`);
      return Promise.resolve();
    },
    commitTransaction: () => {
      log.push('COMMIT');
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      log.push('ROLLBACK');
      return Promise.resolve();
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, log };
}

/** Sources that record the handle each figure was read on, without any statement. */
function recordingSources(seen: { name: string; trx: Transaction<DB> }[]): DashboardDaySources {
  const read =
    (name: string, value: bigint) =>
    (trx: Transaction<DB>, appId: string, range: DashboardDayRange): Promise<bigint> => {
      expect(appId).toBe('couli');
      expect(range.start < range.end).toBe(true);
      seen.push({ name, trx });
      return Promise.resolve(value);
    };
  return {
    countLinks: read('links', 1n),
    countPaidOrders: read('orders', 2n),
    countNewUsers: read('new_users', 3n),
    sumEstimatedRebateFen: read('est_rebate_fen', 425n),
  };
}

const AS_OF = '2032-06-15T19:00:00.000Z';

it('[AC-B1-34q-UNIT#9] 四项取数共用同一个只读 REPEATABLE READ 事务；行在快照事务结束后写入、覆盖写', async () => {
  const stored = {
    date: '2032-06-15',
    links: 1n,
    orders: 2n,
    est_rebate_fen: 425n,
    new_users: 3n,
    as_of: new FixedClock(AS_OF).now(),
  };
  const { db, log } = recordingDb((text) => (/^\s*INSERT/.test(text) ? [stored] : []));
  const seen: { name: string; trx: Transaction<DB> }[] = [];

  const row = await aggregateDashboardDay(
    { db, clock: new FixedClock(AS_OF), sources: recordingSources(seen) },
    { appId: 'couli', day: '2032-06-15' },
  );

  expect(seen.map((s) => s.name)).toEqual(['links', 'orders', 'new_users', 'est_rebate_fen']);
  const first = seen[0]!.trx;
  expect(first.isTransaction).toBe(true);
  for (const { trx } of seen) expect(trx).toBe(first);
  expect(log[0]).toBe('BEGIN repeatable read read only');
  expect(log[1]).toBe('COMMIT');
  expect(log).toHaveLength(3);
  expect(log[2]).toMatch(/^\s*INSERT INTO app\.admin_dashboard_days/);
  expect(log[2]).toContain('DO UPDATE SET');
  expect(log[2]).not.toContain('DO NOTHING');
  expect(row).toEqual({ app_id: 'couli', ...stored });
});

it('[AC-B1-34q-UNIT#10] tick 只补缺：写入走 ON CONFLICT DO NOTHING，别的 worker 先写的行不被覆盖、不报错', async () => {
  // 2032-06-16 02:00 +08:00: the window is 06-09 … 06-15; every day but 06-15 is stored.
  const now = '2032-06-15T18:00:00.000Z';
  const storedDays = dueWindow(new FixedClock(now).now()).slice(0, -1);
  const { db, log } = recordingDb((text) => {
    if (text.includes('"admin_users"')) return [{ app_id: 'couli' }];
    if (text.includes('SELECT stat_date::text AS date'))
      return storedDays.map((date) => ({ date }));
    // INSERT: another worker stored 06-15 first, the conflict returns no row.
    return [];
  });
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );

  await tickDashboardDays({
    db,
    clock: new FixedClock(now),
    logger,
    sources: recordingSources([]),
  });

  const inserts = log.filter((text) => /^\s*INSERT/.test(text));
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toContain('ON CONFLICT (app_id, stat_date) DO NOTHING');
  expect(inserts[0]).not.toContain('DO UPDATE');
  expect(lines.filter((line) => line.includes('admin_dashboard_day_failed'))).toEqual([]);
});
