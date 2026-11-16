// Rule test f (CT-13l; orchestrator rulings D10-1649 / D10-1693): the worker's maintenance calls the
// DEFAULT purge. Basis: BR-ID-30 正文（每日 04:00（+08:00）删除任务，删除条件按运行当日 00:00（+08:00）截断）
// and ② (link_logs 90 天); the SQL contract in ./kit.ts. No database, no listen: the real
// createWorkerMaintenance runs on the fake of test/spec/platform/events-retention/kit.ts, wrapped so
// that the DEFAULT purge call is recorded and can be made to fail; every other statement is answered
// by that fake unchanged (the way of CT-13m's maintenance-schedule.test.ts).
//
// Contract held here (createWorkerMaintenance, i.e. createPartitionMaintenance with dayPartitions):
// - `SELECT app.purge_expired_link_logs_default(<now>)`, its own statement, with the run's single
//   `now` (the clock is read once per run); result alias `deleted` (as the module's other purge
//   functions; the fake answers one row { deleted: 0n }).
// - Gate: +08:00 time of day 04:00:00.000 or later; at most one successful call per +08:00 day per
//   instance; issued after the link_logs day-partition drop (`app.drop_expired_day_partitions(
//   'link_logs', now)`) of the same run.
// - A failing call does not stop the run: the rest of it (evidence purge, events cleanup, DEFAULT
//   check, done line) still runs, the day is not marked as purged (the next run of the same day
//   calls again), and runOnce then rejects with that very error.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';

import { cleanupQueries, fakeDb, NOW, STEPS, stepOf, workerAt } from '../events-retention/kit.ts';
import { reduceLine } from '../maintenance/kit.ts';

/** The SQL function the worker must call (D10-1693). */
const PURGE = 'app.purge_expired_link_logs_default(';

/** CT-13m's evidence purge, which must still run when the DEFAULT purge fails. */
const EVIDENCE = 'app.purge_expired_link_log_evidence(';

interface PurgeControl {
  fail: boolean;
  readonly error: Error;
}

/** The events-retention fake behind a driver that records every statement and owns the purge call. */
async function purgeFake() {
  const inner = await fakeDb();
  const queries: CompiledQuery[] = [];
  const control: PurgeControl = {
    fail: false,
    error: Object.assign(new Error('synthetic DEFAULT purge failure'), { code: '55P03' }),
  };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    if (query.sql.includes(PURGE)) {
      await Promise.resolve();
      if (control.fail) throw control.error;
      return { rows: [{ deleted: 0n }] as R[] };
    }
    const result = await inner.db.executeQuery(query);
    return { rows: result.rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const destroy = async (): Promise<void> => {
    await db.destroy();
    await inner.db.destroy();
  };
  return { db, queries, control, destroy };
}

function isPurge(query: CompiledQuery): boolean {
  return query.sql.includes(PURGE);
}

function isLinkLogsDrop(query: CompiledQuery): boolean {
  const drop = query.sql.includes('app.drop_expired_day_partitions(');
  return drop && query.parameters[0] === 'link_logs';
}

/** The parameters of every DEFAULT purge call so far, in order. */
function purgeCalls(queries: readonly CompiledQuery[]): (readonly unknown[])[] {
  return queries.filter(isPurge).map((query) => query.parameters);
}

function issued(queries: readonly CompiledQuery[], text: string): number {
  return queries.filter((query) => query.sql.includes(text)).length;
}

function isDoneLine(record: Record<string, unknown> | string): boolean {
  return typeof record !== 'string' && record.msg === 'partition_maintenance_done';
}

function doneLines(lines: readonly string[]): number {
  const records = lines.map(reduceLine);
  return records.filter(isDoneLine).length;
}

interface Round {
  readonly at: string;
  /** The `now` of every DEFAULT purge call expected after this run. */
  readonly calls: readonly string[];
}

const SECOND = '2026-10-09T20:00:00.000Z'; // 10-10 04:00 (+08:00)

/** 10-09 00:00, 03:00 and 03:59:59.999 (+08:00): the day of NOW before its 04:00. */
const BEFORE_FOUR = [
  '2026-10-08T16:00:00.000Z',
  '2026-10-08T19:00:00.000Z',
  '2026-10-08T19:59:59.999Z',
] as const;

// NOW is 10-09 04:00 (+08:00). Every round: called only at 04:00 or later of its +08:00 day, and at
// most once per day.
const SCHEDULE: readonly Round[] = [
  { at: '2026-10-08T19:59:59.999Z', calls: [] }, // 10-09 03:59:59.999
  { at: NOW, calls: [NOW] }, // 10-09 04:00
  { at: '2026-10-08T21:00:00.000Z', calls: [NOW] }, // 10-09 05:00
  { at: '2026-10-09T15:59:59.999Z', calls: [NOW] }, // 10-09 23:59:59.999
  { at: '2026-10-09T16:00:00.000Z', calls: [NOW] }, // 10-10 00:00
  { at: '2026-10-09T19:59:59.999Z', calls: [NOW] }, // 10-10 03:59:59.999
  { at: SECOND, calls: [NOW, SECOND] }, // 10-10 04:00
  { at: '2026-10-09T23:00:00.000Z', calls: [NOW, SECOND] }, // 10-10 07:00
];

it('[BR-ID-30 每日 04:00（+08:00）删除任务; CT-13l f] 04:00 的一轮调用一次 DEFAULT 清理，参数是本次注入时钟的 now（时钟只读一次），位置在删 link_logs 日分区之后', async () => {
  const fake = await purgeFake();
  try {
    const run = workerAt(fake.db, NOW);
    await run.maintenance.runOnce();
    expect(run.clock.calls()).toBe(1);
    expect(purgeCalls(fake.queries)).toEqual([[new Date(NOW)]]);
    const drop = fake.queries.findIndex(isLinkLogsDrop);
    const purge = fake.queries.findIndex(isPurge);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(purge).toBeGreaterThan(drop);
  } finally {
    await fake.destroy();
  }
});

it('[BR-ID-30 每日 04:00（+08:00）删除任务; CT-13l f] +08:00 的 04:00 前不调用（00:00、03:00、03:59:59.999）；04:00 起才调用', async () => {
  const fake = await purgeFake();
  try {
    const run = workerAt(fake.db, BEFORE_FOUR[0]);
    for (const at of BEFORE_FOUR) {
      run.clock.set(at);
      await run.maintenance.runOnce();
      expect(purgeCalls(fake.queries), at).toEqual([]);
    }
    run.clock.set(NOW);
    await run.maintenance.runOnce();
    expect(purgeCalls(fake.queries)).toEqual([[new Date(NOW)]]);
  } finally {
    await fake.destroy();
  }
});

it('[BR-ID-30 每日 04:00（+08:00）删除任务; CT-13l f] 当天第一轮（04:00 起）调用一次、后续轮次不再调用；跨到下一天后等到 04:00 再调用一次', async () => {
  const fake = await purgeFake();
  try {
    // Each round sets the clock before it runs.
    const run = workerAt(fake.db, NOW);
    for (const round of SCHEDULE) {
      run.clock.set(round.at);
      await run.maintenance.runOnce();
      const expected = round.calls.map((at) => [new Date(at)]);
      expect(purgeCalls(fake.queries), round.at).toEqual(expected);
    }
  } finally {
    await fake.destroy();
  }
});

it('[BR-ID-30 每日 04:00（+08:00）删除任务; CT-13l f] DEFAULT 清理失败：其余部分（证据清理、events 清理、DEFAULT 检查、完成日志）照常跑完，runOnce 以原错误拒绝；当天不记为已清，同日下一轮再调用，成功后不再调用', async () => {
  const fake = await purgeFake();
  try {
    const run = workerAt(fake.db, NOW);
    fake.control.fail = true;
    await expect(run.maintenance.runOnce()).rejects.toBe(fake.control.error);
    expect(purgeCalls(fake.queries)).toEqual([[new Date(NOW)]]);
    expect(issued(fake.queries, EVIDENCE)).toBe(1);
    expect(cleanupQueries(fake.queries).map(stepOf)).toEqual(STEPS);
    expect(issued(fake.queries, 'app.partition_default_rows()')).toBe(1);
    expect(doneLines(run.lines)).toBe(1);

    const retry = '2026-10-08T21:00:00.000Z'; // 10-09 05:00
    fake.control.fail = false;
    run.clock.set(retry);
    await run.maintenance.runOnce();
    expect(purgeCalls(fake.queries)).toEqual([[new Date(NOW)], [new Date(retry)]]);

    run.clock.set('2026-10-08T22:00:00.000Z'); // 10-09 06:00
    await run.maintenance.runOnce();
    expect(purgeCalls(fake.queries)).toEqual([[new Date(NOW)], [new Date(retry)]]);
  } finally {
    await fake.destroy();
  }
});
