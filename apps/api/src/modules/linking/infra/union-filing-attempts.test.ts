// B1-04zzzzn r2: unit tests of the filing attempt recorder's lock lifecycle (application/
// union-filing-attempts.ts) on a scripted Kysely (DummyDriver: no database, no network).
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  createFilingRecorder,
  filingLockKey,
  FilingLockUnavailable,
  FilingRequestOver,
} from '../application/union-filing-attempts.ts';

const SCOPE = {
  appId: 'couli',
  userId: '0199a3b4-5c6d-7000-8000-000000000001',
  platform: 'taobao',
  unionAccountId: '0199a3b4-5c6d-7000-8000-0000000000a1',
  state: 'synthetic-state',
  traceId: 'synthetic-trace',
} as const;

async function scripted(refuseLock = false, updated = 1n) {
  const queries: string[] = [];
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
    queries.push(query.sql);
    if (refuseLock && query.sql.includes('pg_advisory_lock(')) {
      throw Object.assign(new Error('synthetic lock timeout'), { code: '55P03' });
    }
    return {
      rows: [],
      numAffectedRows: query.sql.startsWith('update "union_filing_attempts"') ? updated : 1n,
    };
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
  const warn = vi.fn();
  const recorder = createFilingRecorder(
    db,
    new FixedClock('2032-04-01T00:00:00.000Z'),
    { warn },
    SCOPE,
  );
  const count = (pattern: RegExp) => queries.filter((sql) => pattern.test(sql)).length;
  return { db, queries, recorder, warn, count };
}

const LOCK = /pg_advisory_lock\(/;
const UNLOCK = /pg_advisory_unlock\(/;
const INSERT = /^insert into "union_filing_attempts"/;
const UPDATE = /^update "union_filing_attempts"/;

it('[AC-B1-04zzzzn#8] 锁按应用、用户、平台、联盟账号取，等到适配器结束且请求事务结束才释放', async () => {
  const { db, recorder, count } = await scripted();
  expect(filingLockKey(SCOPE)).toBe(
    `linking.union_filing_attempts:couli:${SCOPE.userId}:taobao:${SCOPE.unionAccountId}`,
  );
  await recorder.started();
  expect([count(LOCK), count(INSERT)]).toEqual([1, 1]);
  expect(recorder.current()).not.toBeNull();
  // The request ends first (its call timed out); the save may still be in flight.
  await recorder.requestEnded(false);
  expect(count(UNLOCK)).toBe(0);
  recorder.done();
  await vi.waitFor(() => expect(count(UNLOCK)).toBe(1));
  await db.destroy();
});

it('[AC-B1-04zzzzn#5] 请求已结束或信号已取消时不落尝试', async () => {
  const over = await scripted();
  await over.recorder.requestEnded(true);
  await expect(over.recorder.started()).rejects.toBeInstanceOf(FilingRequestOver);
  expect(over.queries).toEqual([]);
  await over.db.destroy();

  const cancelled = await scripted();
  const controller = new AbortController();
  controller.abort();
  await cancelled.recorder.started(controller.signal);
  expect(cancelled.count(INSERT)).toBe(0);
  expect(cancelled.recorder.current()).toBeNull();
  cancelled.recorder.done();
  await cancelled.recorder.requestEnded(false);
  expect(cancelled.count(UNLOCK)).toBe(1);
  await cancelled.db.destroy();
});

it('[AC-B1-04zzzzn#5] 等不到锁时不落尝试、不持有锁', async () => {
  const { db, recorder, count, warn } = await scripted(true);
  await expect(recorder.started()).rejects.toBeInstanceOf(FilingLockUnavailable);
  expect(count(INSERT)).toBe(0);
  expect(recorder.current()).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'linking.bindings.filing_lock_unavailable' }),
    expect.any(String),
  );
  await db.destroy();
});

it.each([
  { stored: false, rewrites: 1 },
  { stored: true, rewrites: 0 },
])(
  '[AC-B1-04zzzzn#15] saved 写在绑定事务后，答复不入库（stored=$stored）时独立补写 saved',
  async ({ stored, rewrites }) => {
    const { db, recorder, count } = await scripted();
    await recorder.started();
    recorder.done();
    await db.transaction().execute((trx) => recorder.markSaved(trx));
    expect(count(UPDATE)).toBe(1);
    await recorder.requestEnded(stored);
    expect(count(UPDATE)).toBe(1 + rewrites);
    expect(count(UNLOCK)).toBe(1);
    await db.destroy();
  },
);

it.each([
  { outcome: 'duplicate', updated: 1n, settled: true },
  { outcome: 'duplicate', updated: 0n, settled: false },
  { outcome: 'rejected', updated: 1n, settled: false },
] as const)(
  '[AC-B1-04zzzzn#22] 本次尝试已落库为 duplicate 才算已确认重复（$outcome，更新 $updated 行）',
  async ({ outcome, updated, settled }) => {
    const { db, recorder } = await scripted(false, updated);
    await recorder.started();
    expect(recorder.duplicateSettled()).toBe(false);
    await recorder.settled(outcome);
    expect(recorder.duplicateSettled()).toBe(settled);
    recorder.done();
    await recorder.requestEnded(false);
    await db.destroy();
  },
);
