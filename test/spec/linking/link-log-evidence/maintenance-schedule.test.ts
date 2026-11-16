// CT-13m S1 (spec-test r1; orchestrator ruling D10-1649): the worker's maintenance schedules the
// evidence purge. Basis: BR-ID-30 正文（每日 04:00（+08:00）删除任务）and ② (link_log_evidence 工单关闭后
// 180 天); D10-1625 (purge function `app.purge_expired_link_log_evidence(p_now)`, contract in ./kit.ts).
// No database, no listen: the real createWorkerMaintenance runs on the fake of
// test/spec/platform/events-retention/kit.ts, wrapped so that the evidence purge call is recorded and
// can be made to fail; every other statement is answered by that fake unchanged.
//
// Contract held here (createWorkerMaintenance, i.e. createPartitionMaintenance with dayPartitions):
// - `SELECT app.purge_expired_link_log_evidence(<now>)`, its own statement, with the run's single
//   `now` (the clock is read once per run); result alias `deleted` (as the module's other purge
//   functions; the fake answers one row { deleted: 0n }).
// - Gate: +08:00 time of day 04:00:00.000 or later; at most one successful call per +08:00 day per
//   instance; issued after the link_logs day-partition drop (`app.drop_expired_day_partitions(
//   'link_logs', now)`) of the same run.
// - A failing call does not stop the run: the rest of it (events cleanup, DEFAULT check, done line)
//   still runs, the day is not marked as purged (the next run of the same day calls again), and
//   runOnce then rejects with that very error.
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

import {
  cleanupQueries,
  fakeDb,
  NOW,
  STEPS,
  stepOf,
  workerAt,
} from '../../platform/events-retention/kit.ts';
import { reduceLine } from '../../platform/maintenance/kit.ts';

/** The SQL function the worker must call (D10-1625). */
const EVIDENCE = 'app.purge_expired_link_log_evidence(';

interface EvidenceControl {
  fail: boolean;
  readonly error: Error;
}

/** The events-retention fake behind a driver that records every statement and owns the purge call. */
async function evidenceFake() {
  const inner = await fakeDb();
  const queries: CompiledQuery[] = [];
  const control: EvidenceControl = {
    fail: false,
    error: Object.assign(new Error('synthetic evidence purge failure'), { code: '55P03' }),
  };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    if (query.sql.includes(EVIDENCE)) {
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

function isEvidencePurge(query: CompiledQuery): boolean {
  return query.sql.includes(EVIDENCE);
}

function isLinkLogsDrop(query: CompiledQuery): boolean {
  const drop = query.sql.includes('app.drop_expired_day_partitions(');
  return drop && query.parameters[0] === 'link_logs';
}

/** The parameters of every evidence purge call so far, in order. */
function evidenceCalls(queries: readonly CompiledQuery[]): (readonly unknown[])[] {
  return queries.filter(isEvidencePurge).map((query) => query.parameters);
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
  /** The `now` of every evidence purge call expected after this run. */
  readonly calls: readonly string[];
}

const SECOND = '2026-10-09T20:00:00.000Z'; // 10-10 04:00 (+08:00)

const SCHEDULE: readonly Round[] = [
  { at: '2026-10-08T19:59:59.999Z', calls: [] }, // 10-09 03:59:59.999
  { at: NOW, calls: [NOW] }, // 10-09 04:00
  { at: '2026-10-08T21:00:00.000Z', calls: [NOW] },
  { at: '2026-10-09T15:59:59.999Z', calls: [NOW] }, // 10-09 23:59:59.999
  { at: '2026-10-09T16:00:00.000Z', calls: [NOW] }, // 10-10 00:00
  { at: '2026-10-09T19:59:59.999Z', calls: [NOW] }, // 10-10 03:59:59.999
  { at: SECOND, calls: [NOW, SECOND] }, // 10-10 04:00
  { at: '2026-10-09T23:00:00.000Z', calls: [NOW, SECOND] },
];

it('[BR-ID-30 每日 04:00（+08:00）删除任务; CT-13m S1] 04:00 的一轮调用一次证据清理，参数是本次注入时钟的 now，位置在删 link_logs 日分区之后', async () => {
  const fake = await evidenceFake();
  try {
    const run = workerAt(fake.db, NOW);
    await run.maintenance.runOnce();
    expect(run.clock.calls()).toBe(1);
    expect(evidenceCalls(fake.queries)).toEqual([[new Date(NOW)]]);
    const drop = fake.queries.findIndex(isLinkLogsDrop);
    const purge = fake.queries.findIndex(isEvidencePurge);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(purge).toBeGreaterThan(drop);
  } finally {
    await fake.destroy();
  }
});

it('[BR-ID-30 每日 04:00（+08:00）删除任务; CT-13m S1] +08:00 的 04:00 前不调用；当天第一轮调用一次、后续轮次不再调用；跨到下一天后等到 04:00 再调用一次', async () => {
  const fake = await evidenceFake();
  try {
    // Each round sets the clock before it runs.
    const run = workerAt(fake.db, NOW);
    for (const round of SCHEDULE) {
      run.clock.set(round.at);
      await run.maintenance.runOnce();
      const expected = round.calls.map((at) => [new Date(at)]);
      expect(evidenceCalls(fake.queries), round.at).toEqual(expected);
    }
  } finally {
    await fake.destroy();
  }
});

it('[BR-ID-30 每日 04:00（+08:00）删除任务; CT-13m S1] 证据清理失败：其余部分照常跑完，runOnce 以原错误拒绝；当天不记为已清，同日下一轮再调用，成功后不再调用', async () => {
  const fake = await evidenceFake();
  try {
    const run = workerAt(fake.db, NOW);
    fake.control.fail = true;
    await expect(run.maintenance.runOnce()).rejects.toBe(fake.control.error);
    expect(evidenceCalls(fake.queries)).toEqual([[new Date(NOW)]]);
    // The rest of the run still went on: events cleanup, DEFAULT check, done line.
    expect(cleanupQueries(fake.queries).map(stepOf)).toEqual(STEPS);
    expect(issued(fake.queries, 'app.partition_default_rows()')).toBe(1);
    expect(doneLines(run.lines)).toBe(1);

    const retry = '2026-10-08T21:00:00.000Z';
    fake.control.fail = false;
    run.clock.set(retry);
    await run.maintenance.runOnce();
    expect(evidenceCalls(fake.queries)).toEqual([[new Date(NOW)], [new Date(retry)]]);

    run.clock.set('2026-10-08T22:00:00.000Z');
    await run.maintenance.runOnce();
    expect(evidenceCalls(fake.queries)).toEqual([[new Date(NOW)], [new Date(retry)]]);
  } finally {
    await fake.destroy();
  }
});
