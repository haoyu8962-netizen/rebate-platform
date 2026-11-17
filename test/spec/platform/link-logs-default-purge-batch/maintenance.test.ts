// CT-13o / D10-1874; BR-ID-30 每日 04:00（+08:00）清理。
// 用真正的维护入口和 SQL 编译器；仅驱动返回各批结果，不模拟维护循环。
// 不固定实现方的批次上限。10,000 只是测试防失控的调用预算，不是生产参数。
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

import { fakeDb, NOW, workerAt } from '../events-retention/kit.ts';
import { reduceLine } from '../maintenance/kit.ts';

const PURGE = 'app.purge_expired_link_logs_default(';
const EVIDENCE = 'app.purge_expired_link_log_evidence(';
const CALL_BUDGET = 10_000;

interface Call {
  readonly query: CompiledQuery;
  readonly transaction: number | undefined;
}

async function batchFake() {
  const inner = await fakeDb();
  const calls: Call[] = [];
  const trace: string[] = [];
  const control = {
    replies: [1n, 1n, 0n],
    fallback: 0n,
    failAt: 0,
    error: Object.assign(new Error('synthetic second batch timeout'), { code: '57014' }),
  };
  let transaction: number | undefined;
  let sequence = 0;
  let purges = 0;
  let budgetUsed = 0;
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  driver.beginTransaction = async () => {
    transaction = ++sequence;
    trace.push(`begin:${transaction}`);
  };
  driver.commitTransaction = async () => {
    trace.push(`commit:${transaction}`);
    transaction = undefined;
  };
  driver.rollbackTransaction = async () => {
    trace.push(`rollback:${transaction}`);
    transaction = undefined;
  };
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    calls.push({ query, transaction });
    if (query.sql.includes(PURGE)) {
      purges += 1;
      budgetUsed += 1;
      trace.push(`purge:${transaction}`);
      await Promise.resolve();
      if (purges === control.failAt) throw control.error;
      // 即使错误实现没有循环上限，也能走到断言失败，而不是测试超时。
      const deleted = budgetUsed > CALL_BUDGET ? 0n : (control.replies.shift() ?? control.fallback);
      return { rows: [{ deleted }] as R[] };
    }
    if (query.sql.includes(EVIDENCE)) return { rows: [{ deleted: 0n }] as R[] };
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
  return {
    db,
    calls,
    trace,
    control,
    resetBudget: () => {
      budgetUsed = 0;
    },
    purges: () => calls.filter((call) => call.query.sql.includes(PURGE)),
    destroy: async () => {
      await db.destroy();
      await inner.db.destroy();
    },
  };
}

/** 其他维护步骤也有事务，只检查包含 DEFAULT 清理的事务及其先后顺序。 */
function purgeTrace(fake: Awaited<ReturnType<typeof batchFake>>): string[] {
  const transactions = new Set(fake.purges().map((call) => String(call.transaction)));
  return fake.trace.filter((entry) => transactions.has(entry.split(':')[1]!));
}

function expectShortTransactions(fake: Awaited<ReturnType<typeof batchFake>>): void {
  const purges = fake.purges();
  expect(new Set(purges.map((call) => call.transaction)).size).toBe(purges.length);
  for (const call of purges) {
    expect(call.transaction).toBeTypeOf('number');
    const preceding = fake.calls.slice(0, fake.calls.indexOf(call));
    const settings = preceding.filter(
      (entry) =>
        entry.transaction === call.transaction && entry.query.sql.includes('statement_timeout'),
    );
    expect(settings).toHaveLength(1);
    const setting = settings[0]!.query;
    expect(setting.sql).toMatch(/set_config\('statement_timeout',\s*\$\d+::text,\s*true\)/);
    expect(setting.parameters).toEqual(['60s']);
  }
}

it('[AC-CT-13o#1] 04:00 起非零短批仍继续直到 0；每批独立短事务设 60s，删净后当天停、次日 04:00 再清', async () => {
  const fake = await batchFake();
  try {
    const run = workerAt(fake.db, '2026-10-08T19:59:59.999Z');
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(0);
    run.clock.set(NOW);
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(3);
    expect(run.clock.calls()).toBe(2);
    expect(fake.purges().map((call) => call.query.parameters[0])).toEqual([
      new Date(NOW),
      new Date(NOW),
      new Date(NOW),
    ]);
    expectShortTransactions(fake);
    expect(purgeTrace(fake)).toEqual(
      fake
        .purges()
        .flatMap((call) => [
          `begin:${call.transaction}`,
          `purge:${call.transaction}`,
          `commit:${call.transaction}`,
        ]),
    );
    const drop = fake.calls.findIndex(
      (call) =>
        call.query.sql.includes('app.drop_expired_day_partitions(') &&
        call.query.parameters[0] === 'link_logs',
    );
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(fake.calls.indexOf(fake.purges()[0]!)).toBeGreaterThan(drop);
    expect(fake.calls.findIndex((call) => call.query.sql.includes(EVIDENCE))).toBeGreaterThan(
      fake.calls.indexOf(fake.purges()[2]!),
    );
    for (const at of ['2026-10-08T21:00:00Z', '2026-10-09T19:59:59.999Z']) {
      run.clock.set(at);
      await run.maintenance.runOnce();
      expect(fake.purges()).toHaveLength(3);
    }
    run.clock.set('2026-10-09T20:00:00Z');
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(4);
  } finally {
    await fake.destroy();
  }
});

it('[AC-CT-13o#2] 持续积压到本轮批次上限即停；同日后续轮继续，只有实际返回 0 才标记当天已清', async () => {
  const fake = await batchFake();
  try {
    fake.control.replies = [];
    fake.control.fallback = 1n;
    const run = workerAt(fake.db, NOW);
    await run.maintenance.runOnce();
    const limit = fake.purges().length;
    expect(limit).toBeGreaterThan(1);
    expect(limit).toBeLessThanOrEqual(CALL_BUDGET);
    fake.resetBudget();
    run.clock.set('2026-10-08T21:00:00Z');
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(limit * 2);
    expect(
      fake
        .purges()
        .slice(limit)
        .every(
          (call) => (call.query.parameters[0] as Date).toISOString() === '2026-10-08T21:00:00.000Z',
        ),
    ).toBe(true);
    fake.control.replies = [1n, 0n];
    fake.resetBudget();
    run.clock.set('2026-10-08T22:00:00Z');
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(limit * 2 + 2);
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(limit * 2 + 2);
    expectShortTransactions(fake);
  } finally {
    await fake.destroy();
  }
});

it('[AC-CT-13o#3] 第二批超时只回滚该批，保留首批提交；其余维护继续，记录原错误且同日下一轮续清', async () => {
  const fake = await batchFake();
  try {
    fake.control.failAt = 2;
    const run = workerAt(fake.db, NOW);
    await expect(run.maintenance.runOnce()).rejects.toBe(fake.control.error);
    expect(fake.purges()).toHaveLength(2);
    expect(purgeTrace(fake)).toEqual(
      fake
        .purges()
        .flatMap((call, index) => [
          `begin:${call.transaction}`,
          `purge:${call.transaction}`,
          `${index === 0 ? 'commit' : 'rollback'}:${call.transaction}`,
        ]),
    );
    expect(fake.calls.some((call) => call.query.sql.includes(EVIDENCE))).toBe(true);
    expect(fake.calls.some((call) => call.query.sql.includes('app.partition_default_rows()'))).toBe(
      true,
    );
    const records = run.lines.map(reduceLine);
    expect(records).toContainEqual(
      expect.objectContaining({
        msg: 'retention_purge_failed',
        table: 'link_logs_default',
        sqlstate: '57014',
      }),
    );
    expect(records).toContainEqual(expect.objectContaining({ msg: 'partition_maintenance_done' }));
    fake.control.failAt = 0;
    fake.control.replies = [1n, 0n];
    run.clock.set('2026-10-08T21:00:00Z');
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(4);
    expectShortTransactions(fake);
    await run.maintenance.runOnce();
    expect(fake.purges()).toHaveLength(4);
  } finally {
    await fake.destroy();
  }
});
