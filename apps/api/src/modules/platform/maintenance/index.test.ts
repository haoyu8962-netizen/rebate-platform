import { MONTH_PARTITIONED_TABLES, MONTHS_AHEAD, type DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/clock.ts';
import type { RootLogger } from '../logging/logger.ts';
import {
  DAY_PARTITIONED_TABLES,
  DAYS_AHEAD,
  OPEN_ATTEMPTS_BATCH_SIZE,
  OPEN_ATTEMPTS_MAX_BATCHES,
  createPartitionMaintenance,
  type PartitionMaintenance,
} from './index.ts';
import { createWorkerMaintenance } from './worker.ts';

// Partition counts derive from the partition lists (B1-04n), so adding a month-partitioned table
// does not rewrite these tests: every month table × (this month + MONTHS_AHEAD), plus every day
// table × (today + DAYS_AHEAD) when day partitions are on.
const MONTH_ENSURED = MONTH_PARTITIONED_TABLES.length * (MONTHS_AHEAD + 1);
const ALL_ENSURED = MONTH_ENSURED + DAY_PARTITIONED_TABLES.length * (DAYS_AHEAD + 1);
/** The UTC months a run at the default fixture instant (2026-11-20) ensures, as `p_month`. */
const FIXTURE_MONTHS = ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'];

/** The nine rows of app.delete_expired_agent_traces, in its fixed order (section M). */
const AGENT_TRACE_TABLES = [
  'agent_tool_calls',
  'agent_cards',
  'agent_result_deliveries',
  'agent_messages',
  'agent_result_sets',
  'agent_runs',
  'agent_clarify_asks',
  'agent_result_chains',
  'agent_sessions',
] as const;

const instances: PartitionMaintenance[] = [];
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop()));
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
  vi.useRealTimers();
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database.
async function fixture(instant = '2026-11-20T03:04:05Z', dayPartitions = false) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  const transactions: { queries: CompiledQuery[]; outcome: string }[] = [];
  let transaction: (typeof transactions)[number] | undefined;
  driver.beginTransaction = async () => {
    if (transaction) throw new Error('overlapping transactions');
    transaction = { queries: [], outcome: 'pending' };
    transactions.push(transaction);
  };
  driver.commitTransaction = async () => {
    transaction!.outcome = 'committed';
    transaction = undefined;
  };
  driver.rollbackTransaction = async () => {
    transaction!.outcome = 'rolled back';
    transaction = undefined;
  };
  const control: { respond: (query: CompiledQuery) => Promise<unknown[] | undefined> } = {
    respond: async () => undefined,
  };
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    transaction?.queries.push(query);
    let rows = await control.respond(query);
    if (rows === undefined) {
      if (query.sql.includes('current_user')) rows = [{ role: 'couli_maint' }];
      else if (/ensure_(month|day)_partition/.test(query.sql)) {
        rows = [{ partition: `${String(query.parameters[0])}:${String(query.parameters[1])}` }];
      } else if (/drop_expired_(month|day|union_raw_payload)_partitions/.test(query.sql)) {
        rows = [{ partitions: [] }];
      } else if (query.sql.includes('delete_expired_agent_traces')) {
        rows = AGENT_TRACE_TABLES.map((table_name) => ({ table_name, deleted: 0n }));
      } else if (query.sql.includes('delete_expired_')) rows = [{ deleted: 0n }];
      else if (query.sql.includes('read_retention_settings')) rows = [];
      else if (query.sql.includes('partition_default_rows')) rows = [];
      else if (query.sql.includes('set_config')) rows = [];
      else throw new Error('unexpected statement');
    }
    return { rows: rows as R[] };
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
  handles.push(db);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = new FixedClock(instant);
  const now = vi.spyOn(clock, 'now');
  const maintenance = createPartitionMaintenance({
    db,
    logger: logger as unknown as RootLogger,
    clock,
    intervalMs: 100,
    dayPartitions,
  });
  instances.push(maintenance);
  return { db, maintenance, queries, transactions, control, logger, clock, now };
}

it.each(['23514', '55P03'])(
  '[AC-B1-01s#1] 日预建失败 %s 后完成其余步骤，下一轮重新尝试，日志不泄露错误内容',
  async (code) => {
    const f = await fixture('2026-11-20T03:04:05Z', true);
    f.control.respond = async (query) => {
      if (query.sql.includes('ensure_day_partition') && query.parameters[1] === '2026-11-22') {
        throw { code, message: 'private SQL', detail: 'private row data' };
      }
      return undefined;
    };
    const report = await f.maintenance.runOnce();
    expect(report.failed).toBe(1);
    expect(report.ensured).toHaveLength(code === '55P03' ? MONTH_ENSURED + 2 : ALL_ENSURED - 1);
    expect(f.logger.error.mock.calls).toEqual([
      [{ table: 'link_logs', day: '2026-11-22', sqlstate: code }, 'partition_ensure_failed'],
    ]);
    expect(f.queries.filter((q) => q.sql.includes('ensure_day_partition'))).toHaveLength(
      code === '55P03' ? 3 : 15,
    );
    expect(f.queries.some((q) => q.sql.includes('drop_expired_day_partitions'))).toBe(true);
    expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
    f.control.respond = async () => undefined;
    expect(await f.maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(f.logger.info.mock.calls.at(-1)).toEqual([
      { ensured: ALL_ENSURED, dropped: 0, failed: 0 },
      'partition_maintenance_done',
    ]);
    expect(f.now).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ['2026-10-08T19:59:59.999Z', true, false],
  ['2026-10-08T20:00:00.000Z', true, true],
  ['2026-10-08T20:00:00.000Z', false, false],
] as const)(
  '[AC-B1-01s#2] 日删除遵守 04:00 门槛和开关（%s，启用=%s，删除=%s），月删除在前且共用 now',
  async (instant, enabled, shouldDrop) => {
    const f = await fixture(instant, enabled);
    f.control.respond = async (query) => {
      if (query.sql.includes('drop_expired_month_partitions')) {
        return [{ partitions: ['event_log_p202603'] }];
      }
      if (query.sql.includes('drop_expired_day_partitions')) {
        return [{ partitions: ['link_logs_p20260710'] }];
      }
      return undefined;
    };
    const report = await f.maintenance.runOnce();
    const drops = f.queries.filter((q) => q.sql.includes('drop_expired_'));
    expect(drops.filter((q) => q.sql.includes('drop_expired_day_partitions'))).toHaveLength(
      shouldDrop ? 1 : 0,
    );
    if (shouldDrop) {
      expect(drops.map((q) => q.parameters)).toEqual([
        ['event_log', f.now.mock.results[0]!.value],
        ['link_logs', f.now.mock.results[0]!.value],
        [f.now.mock.results[0]!.value, 180],
      ]);
      expect(report.dropped).toEqual(['event_log_p202603', 'link_logs_p20260710']);
      expect(f.logger.info.mock.calls.slice(0, 2)).toEqual([
        [{ table: 'event_log', partition: 'event_log_p202603' }, 'partition_dropped'],
        [{ table: 'link_logs', partition: 'link_logs_p20260710' }, 'partition_dropped'],
      ]);
    }
    expect(report.ensured).toHaveLength(enabled ? ALL_ENSURED : MONTH_ENSURED);
    expect(f.now).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-01s#3] 日删除锁超时只记一次失败，DEFAULT 仍告警，下一定时轮成功', async () => {
  vi.useFakeTimers();
  const f = await fixture('2026-11-20T03:04:05Z', true);
  let attempts = 0;
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_day_partitions')) {
      attempts += 1;
      if (attempts === 1) throw { code: '55P03', detail: 'private row data' };
      return [{ partitions: ['link_logs_p20260710'] }];
    }
    if (query.sql.includes('partition_default_rows')) {
      return [{ table_name: 'link_logs', default_partition: 'link_logs_default', row_count: 1n }];
    }
    return undefined;
  };
  await f.maintenance.start();
  expect(attempts).toBe(1);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'link_logs', sqlstate: '55P03' }, 'partition_drop_failed'],
  ]);
  expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
    { table: 'link_logs', partition: 'link_logs_default', rows: 1 },
    'partition_default_has_rows',
  );
  expect(f.logger.info.mock.calls.at(-1)).toEqual([
    { ensured: ALL_ENSURED, dropped: 0, failed: 1 },
    'partition_maintenance_done',
  ]);
  await vi.advanceTimersByTimeAsync(100);
  expect(attempts).toBe(2);
  expect(f.logger.error).toHaveBeenCalledTimes(1);
  expect(f.logger.info.mock.calls.at(-1)).toEqual([
    { ensured: ALL_ENSURED, dropped: 1, failed: 0 },
    'partition_maintenance_done',
  ]);
});

it('[AC-B1-01n#5] worker 按契约 8 预建 23 个分区，link_logs 与 orders 的 DEFAULT 数据均告警', async () => {
  const f = await fixture();
  f.control.respond = async (query) =>
    query.sql.includes('partition_default_rows')
      ? [
          { table_name: 'link_logs', default_partition: 'link_logs_default', row_count: 2n },
          { table_name: 'orders', default_partition: 'orders_default', row_count: 3n },
          { table_name: 'event_log', default_partition: 'event_log_default', row_count: 0n },
        ]
      : undefined;
  const worker = createWorkerMaintenance({
    db: f.db,
    logger: f.logger as unknown as RootLogger,
    clock: f.clock,
  });
  instances.push(worker);
  const report = await worker.runOnce();
  expect(report.ensured).toHaveLength(ALL_ENSURED);
  expect(report.defaultRows).toEqual([
    { table: 'link_logs', partition: 'link_logs_default', rows: 2 },
    { table: 'orders', partition: 'orders_default', rows: 3 },
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: ALL_ENSURED, dropped: 0, failed: 0 }, 'partition_maintenance_done'],
  ]);
  expect(f.logger.warn.mock.calls).toEqual([
    [report.defaultRows[0], 'partition_default_has_rows'],
    [report.defaultRows[1], 'partition_default_has_rows'],
  ]);
});

it('[AC-B1-01n#6] 创建后修改 quietDefaultTables 不影响日志分级', async () => {
  const f = await fixture();
  const tables = ['link_logs'];
  const maintenance = createPartitionMaintenance({
    db: f.db,
    logger: f.logger as unknown as RootLogger,
    clock: f.clock,
    quietDefaultTables: tables,
  });
  instances.push(maintenance);
  tables.splice(0, 1, 'orders');
  f.control.respond = async (query) =>
    query.sql.includes('partition_default_rows')
      ? [
          { table_name: 'link_logs', default_partition: 'link_logs_default', row_count: 1n },
          { table_name: 'orders', default_partition: 'orders_default', row_count: 1n },
        ]
      : undefined;
  await maintenance.runOnce();
  expect(f.logger.info).toHaveBeenCalledWith(
    { table: 'link_logs', partition: 'link_logs_default', rows: 1 },
    'partition_default_rows_expected',
  );
  expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
    { table: 'orders', partition: 'orders_default', rows: 1 },
    'partition_default_has_rows',
  );
});

it('[AC-B1-01j#1] 独立参数化语句使用同一次时钟读数，失败月份不阻断后续建分区和 DEFAULT 告警', async () => {
  const f = await fixture();
  f.control.respond = async (query) => {
    if (query.sql.includes('ensure_month_partition') && query.parameters[1] === '2026-12-01') {
      throw { code: '23514', message: 'private row data', detail: 'private SQL' };
    }
    if (query.sql.includes('partition_default_rows')) {
      return [
        { table_name: 'event_log', default_partition: 'event_log_default', row_count: 0n },
        { table_name: 'orders', default_partition: 'orders_default', row_count: 3n },
      ];
    }
    return undefined;
  };
  const report = await f.maintenance.runOnce();
  expect(report).toEqual({
    ensured: MONTH_PARTITIONED_TABLES.flatMap((table) =>
      FIXTURE_MONTHS.filter((month) => month !== '2026-12-01').map((month) => `${table}:${month}`),
    ),
    dropped: [],
    defaultRows: [{ table: 'orders', partition: 'orders_default', rows: 3 }],
    failed: MONTH_PARTITIONED_TABLES.length,
  });
  expect(f.queries.filter((q) => !q.sql.includes('set_config')).map((q) => q.parameters)).toEqual([
    [],
    ...MONTH_PARTITIONED_TABLES.flatMap((table) => FIXTURE_MONTHS.map((month) => [table, month])),
    ['event_log', new Date('2026-11-20T03:04:05Z')],
    [],
  ]);
  expect(f.now).toHaveBeenCalledTimes(1);
  expect(f.logger.error.mock.calls).toEqual(
    MONTH_PARTITIONED_TABLES.map((table) => [
      { table, month: '2026-12-01', sqlstate: '23514' },
      'partition_ensure_failed',
    ]),
  );
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'orders', partition: 'orders_default', rows: 3 }, 'partition_default_has_rows'],
  ]);
  expect(f.transactions.map((transaction) => transaction.outcome)).toEqual([
    ...MONTH_PARTITIONED_TABLES.flatMap(() =>
      FIXTURE_MONTHS.map((month) => (month === '2026-12-01' ? 'rolled back' : 'committed')),
    ),
    'committed',
  ]);
});

it('[AC-B1-01j#2] 删除和 DEFAULT 检查失败分别计数，日志不泄漏错误对象', async () => {
  const f = await fixture();
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_month_partitions'))
      throw { code: '55P03', detail: 'private' };
    if (query.sql.includes('partition_default_rows')) throw { code: 'secret', message: 'private' };
    return undefined;
  };
  expect(await f.maintenance.runOnce()).toMatchObject({ dropped: [], defaultRows: [], failed: 2 });
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'event_log', sqlstate: '55P03' }, 'partition_drop_failed'],
    [{ sqlstate: null }, 'partition_default_check_failed'],
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: MONTH_ENSURED, dropped: 0, failed: 2 }, 'partition_maintenance_done'],
  ]);
});

it('[AC-B1-01j#3] 行数超过安全整数时报告检查失败，不输出舍入后的计数', async () => {
  const f = await fixture();
  f.control.respond = async (query) =>
    query.sql.includes('partition_default_rows')
      ? [
          {
            table_name: 'orders',
            default_partition: 'orders_default',
            row_count: 9_007_199_254_740_993n,
          },
        ]
      : undefined;
  expect(await f.maintenance.runOnce()).toMatchObject({ defaultRows: [], failed: 1 });
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.error.mock.calls).toEqual([
    [{ sqlstate: null }, 'partition_default_check_failed'],
  ]);
});

it('[AC-B1-01j#4] 删除门槛跨越北京时间 04:00 与午夜，时钟中途改变不改变本轮参数', async () => {
  const f = await fixture('2026-10-08T19:59:59.999Z');
  expect((await f.maintenance.runOnce()).dropped).toEqual([]);
  expect(f.queries.some((q) => q.sql.includes('drop_expired'))).toBe(false);
  f.clock.set('2026-10-08T20:00:00Z');
  f.control.respond = async (query) => {
    if (query.sql.includes('ensure_month_partition')) f.clock.set('2026-10-09T16:00:00Z');
    return query.sql.includes('drop_expired') ? [{ partitions: ['event_log_p202603'] }] : undefined;
  };
  expect((await f.maintenance.runOnce()).dropped).toEqual(['event_log_p202603']);
  const drops = () => f.queries.filter((q) => q.sql.includes('drop_expired'));
  expect(drops().map((q) => q.parameters)).toEqual([
    ['event_log', new Date('2026-10-08T20:00:00Z')],
  ]);
  expect(f.logger.info).toHaveBeenCalledWith(
    { table: 'event_log', partition: 'event_log_p202603' },
    'partition_dropped',
  );
  await f.maintenance.runOnce();
  expect(drops()).toHaveLength(1);
  expect(f.now).toHaveBeenCalledTimes(3);
});

it('[AC-B1-01j#5] 错误角色立即拒绝，不读时钟不写日志，start 不再安排后续轮次', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.control.respond = async () => [{ role: 'couli_app' }];
  await expect(f.maintenance.start()).rejects.toMatchObject({ code: 'wrong_role' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.queries).toHaveLength(1);
  expect(f.now).not.toHaveBeenCalled();
  expect(f.logger.info).not.toHaveBeenCalled();
  expect(f.logger.error).not.toHaveBeenCalled();
  await expect(f.maintenance.stop()).resolves.toBeUndefined();
});

it('[AC-B1-01j#6] 连接错误由 runOnce 原样抛出，定时运行记录后继续调度', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const error = Object.assign(new Error('private connection data'), { code: 'ECONNREFUSED' });
  f.control.respond = async () => {
    throw error;
  };
  await expect(f.maintenance.runOnce()).rejects.toBe(error);
  await expect(f.maintenance.start()).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.logger.error.mock.calls).toEqual([
    [{ sqlstate: null }, 'partition_maintenance_failed'],
    [{ sqlstate: null }, 'partition_maintenance_failed'],
  ]);
  f.control.respond = async () => undefined;
  await vi.advanceTimersByTimeAsync(100);
  expect(f.logger.info).toHaveBeenCalledWith(
    { ensured: MONTH_ENSURED, dropped: 0, failed: 0 },
    'partition_maintenance_done',
  );
});

it('[AC-B1-01j#7] 慢轮次不重叠，结束后才计算间隔；stop 等待后续进行中的轮次', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.control.respond = async (query) => {
    if (query.sql.includes('current_user')) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const starting = f.maintenance.start();
  await entered.promise;
  await expect(f.maintenance.start()).rejects.toMatchObject({ code: 'already_started' });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.queries).toHaveLength(1);
  release.resolve();
  await starting;
  const completedQueries = f.queries.length;
  release = Promise.withResolvers<void>();
  await vi.advanceTimersByTimeAsync(99);
  expect(f.queries).toHaveLength(completedQueries);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.queries).toHaveLength(completedQueries + 1);
  const settled = vi.fn();
  const stopping = f.maintenance.stop().then(settled);
  await vi.advanceTimersByTimeAsync(500);
  expect(settled).not.toHaveBeenCalled();
  expect(f.queries).toHaveLength(completedQueries + 1);
  release.resolve();
  await stopping;
  const afterStop = f.queries.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(f.queries).toHaveLength(afterStop);
  expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
});

it.each([false, true])(
  '[AC-B1-01j#8] 首轮阻塞时并发 stop 均等待首轮结束（失败=%s）',
  async (fail) => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.control.respond = async (query) => {
      if (query.sql.includes('current_user')) {
        entered.resolve();
        await release.promise;
        if (fail) throw new Error('connection failed');
      }
      return undefined;
    };
    const starting = f.maintenance.start();
    await entered.promise;
    const stopped = vi.fn();
    const stopping = Promise.all([f.maintenance.stop(), f.maintenance.stop()]).then(stopped);
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).not.toHaveBeenCalled();
    release.resolve();
    await starting;
    await stopping;
    const queryCount = f.queries.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.queries).toHaveLength(queryCount);
    expect(stopped).toHaveBeenCalledExactlyOnceWith([undefined, undefined]);
    await expect(f.maintenance.start()).rejects.toMatchObject({ code: 'already_started' });
  },
);

it('[AC-B1-01j#9] stop 不等待直接调用的 runOnce，停止后仍可手动运行', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.control.respond = async () => {
    entered.resolve();
    await release.promise;
    return undefined;
  };
  const running = f.maintenance.runOnce();
  await entered.promise;
  await expect(f.maintenance.stop()).resolves.toBeUndefined();
  expect(f.logger.info).not.toHaveBeenCalled();
  release.resolve();
  await expect(running).resolves.toMatchObject({ failed: 0 });
  await expect(f.maintenance.runOnce()).resolves.toMatchObject({ failed: 0 });
});

it('[AC-B1-01j#10] 删除锁超时只记一次失败，继续 DEFAULT 告警，下一轮重试成功', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let attempts = 0;
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_month_partitions')) {
      attempts += 1;
      if (attempts === 1) {
        throw {
          code: '55P03',
          message: 'canceling statement due to lock timeout',
          detail: 'private connection and row data',
        };
      }
      return [{ partitions: ['event_log_p202603'] }];
    }
    if (query.sql.includes('partition_default_rows')) {
      return [{ table_name: 'orders', default_partition: 'orders_default', row_count: 2n }];
    }
    return undefined;
  };
  await f.maintenance.start();
  expect(attempts).toBe(1);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'event_log', sqlstate: '55P03' }, 'partition_drop_failed'],
  ]);
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'orders', partition: 'orders_default', rows: 2 }, 'partition_default_has_rows'],
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: MONTH_ENSURED, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  await vi.advanceTimersByTimeAsync(99);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toBe(2);
  expect(f.logger.error).toHaveBeenCalledTimes(1);
  expect(f.logger.info.mock.calls.slice(1)).toEqual([
    [{ table: 'event_log', partition: 'event_log_p202603' }, 'partition_dropped'],
    [{ ensured: MONTH_ENSURED, dropped: 1, failed: 0 }, 'partition_maintenance_done'],
  ]);
});

it('[AC-B1-01j#11] stop 等待中的删除收到锁超时后完成，且不再调度', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_month_partitions')) {
      entered.resolve();
      await release.promise;
      throw { code: '55P03', message: 'canceling statement due to lock timeout' };
    }
    return undefined;
  };
  const starting = f.maintenance.start();
  await entered.promise;
  const stopped = vi.fn();
  const stopping = f.maintenance.stop().then(stopped);
  await vi.advanceTimersByTimeAsync(100);
  expect(stopped).not.toHaveBeenCalled();
  release.resolve();
  await starting;
  await stopping;
  expect(stopped).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'event_log', sqlstate: '55P03' }, 'partition_drop_failed'],
  ]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: MONTH_ENSURED, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
  const queryCount = f.queries.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.queries).toHaveLength(queryCount);
});

it('[AC-B1-01j#12] 每次预建和 DEFAULT 计数独占短事务，首句设置事务级 5 秒锁超时', async () => {
  const f = await fixture();
  expect(await f.maintenance.runOnce()).toMatchObject({ failed: 0 });
  const boundedQueries = f.queries.filter(
    (q) => q.sql.includes('ensure_month_partition') || q.sql.includes('partition_default_rows'),
  );
  expect(boundedQueries).toHaveLength(MONTH_ENSURED + 1);
  expect(f.transactions).toHaveLength(MONTH_ENSURED + 1);
  for (const [index, transaction] of f.transactions.entries()) {
    expect(transaction.outcome).toBe('committed');
    expect(transaction.queries).toHaveLength(2);
    expect(transaction.queries[0]?.sql).toBe("SELECT set_config('lock_timeout', '5s', true)");
    expect(transaction.queries[1]).toBe(boundedQueries[index]);
  }
});

it.each([['event_log'], ['event_log', 'orders']])(
  '[AC-B1-01j#13] 锁超时每表只失败一次，跳过剩余月份、其他表继续，下轮重新预建（%j）',
  async (...blockedTables) => {
    const f = await fixture();
    f.control.respond = async (query) => {
      if (
        query.sql.includes('ensure_month_partition') &&
        blockedTables.includes(String(query.parameters[0])) &&
        query.parameters[1] === '2027-01-01'
      ) {
        throw { code: '55P03', message: 'private SQL', detail: 'private row data' };
      }
      return undefined;
    };
    const allNames = MONTH_PARTITIONED_TABLES.flatMap((table) =>
      FIXTURE_MONTHS.map((month) => `${table}:${month}`),
    );
    expect(await f.maintenance.runOnce()).toEqual({
      ensured: allNames.filter(
        (name) => !blockedTables.some((table) => name.startsWith(`${table}:2027`)),
      ),
      dropped: [],
      defaultRows: [],
      failed: blockedTables.length,
    });
    expect(f.logger.error.mock.calls).toEqual(
      blockedTables.map((table) => [
        { table, month: '2027-01-01', sqlstate: '55P03' },
        'partition_ensure_failed',
      ]),
    );
    expect(
      f.queries
        .filter(
          (q) =>
            q.sql.includes('ensure_month_partition') &&
            blockedTables.includes(String(q.parameters[0])),
        )
        .some((q) => q.parameters[1] === '2027-02-01'),
    ).toBe(false);
    expect(f.transactions.filter((t) => t.outcome === 'rolled back')).toHaveLength(
      blockedTables.length,
    );
    expect(f.queries.some((q) => q.sql.includes('drop_expired_month_partitions'))).toBe(true);
    expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
    f.control.respond = async () => undefined;
    expect(await f.maintenance.runOnce()).toEqual({
      ensured: allNames,
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
  },
);

it('[AC-B1-01j#14] DEFAULT 锁超时回滚并记一次失败，下一定时轮恢复计数告警', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let attempts = 0;
  f.control.respond = async (query) => {
    if (query.sql.includes('partition_default_rows')) {
      attempts += 1;
      if (attempts === 1) throw { code: '55P03', detail: 'private row data' };
      return [{ table_name: 'orders', default_partition: 'orders_default', row_count: 2n }];
    }
    return undefined;
  };
  await f.maintenance.start();
  expect(f.transactions.at(-1)?.outcome).toBe('rolled back');
  expect(f.logger.error.mock.calls).toEqual([
    [{ sqlstate: '55P03' }, 'partition_default_check_failed'],
  ]);
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: MONTH_ENSURED, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  await vi.advanceTimersByTimeAsync(99);
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toBe(2);
  expect(f.transactions.at(-1)?.outcome).toBe('committed');
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'orders', partition: 'orders_default', rows: 2 }, 'partition_default_has_rows'],
  ]);
  expect(f.logger.info.mock.calls.at(-1)).toEqual([
    { ensured: MONTH_ENSURED, dropped: 0, failed: 0 },
    'partition_maintenance_done',
  ]);
});

it.each(['ensure_month_partition', 'partition_default_rows'])(
  '[AC-B1-01j#15] stop 等待 %s 锁超时后完成回滚，不再调度',
  async (functionName) => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.control.respond = async (query) => {
      if (query.sql.includes(functionName)) {
        entered.resolve();
        await release.promise;
        throw { code: '55P03' };
      }
      return undefined;
    };
    const starting = f.maintenance.start();
    await entered.promise;
    const stopped = vi.fn();
    const stopping = f.maintenance.stop().then(stopped);
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).not.toHaveBeenCalled();
    release.resolve();
    await starting;
    await stopping;
    expect(stopped).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.transactions.every((t) => t.outcome !== 'pending')).toBe(true);
    expect(f.transactions.filter((t) => t.outcome === 'rolled back')).toHaveLength(
      functionName === 'ensure_month_partition' ? MONTH_PARTITIONED_TABLES.length : 1,
    );
    const queryCount = f.queries.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.queries).toHaveLength(queryCount);
  },
);

const OPEN_ATTEMPTS = 'delete_expired_link_open_attempts';

it.each([
  ['2026-10-08T19:59:59.999Z', true, 0],
  ['2026-10-08T20:00:00.000Z', true, 4],
  ['2026-10-08T20:00:00.000Z', false, 0],
] as const)(
  '[AC-B1-01zk#5] 打开尝试按 04:00 门槛与开关分批删除到返回 0（%s，启用=%s，调用 %i 次），共用 now、不开显式事务',
  async (instant, enabled, calls) => {
    const f = await fixture(instant, enabled);
    const deleted = [1000n, 1000n, 1n, 0n];
    f.control.respond = async (query) =>
      query.sql.includes(OPEN_ATTEMPTS) ? [{ deleted: deleted.shift() }] : undefined;
    const report = await f.maintenance.runOnce();
    const batches = f.queries.filter((q) => q.sql.includes(OPEN_ATTEMPTS));
    expect(batches).toHaveLength(calls);
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ dropped: [], failed: 0 });
    expect(f.transactions.some((t) => t.queries.some((q) => q.sql.includes(OPEN_ATTEMPTS)))).toBe(
      false,
    );
    if (calls > 0) {
      const now = f.now.mock.results[0]!.value;
      expect(batches.map((q) => q.parameters)).toEqual(
        Array.from({ length: calls }, () => [now, OPEN_ATTEMPTS_BATCH_SIZE]),
      );
      const order = f.queries.map((q) => q.sql);
      const lastDayDrop = order.findLastIndex((sql) => sql.includes('drop_expired_day_partitions'));
      const firstBatch = order.findIndex((sql) => sql.includes(OPEN_ATTEMPTS));
      const defaults = order.findIndex((sql) => sql.includes('partition_default_rows'));
      expect(lastDayDrop).toBeGreaterThanOrEqual(0);
      expect(lastDayDrop).toBeLessThan(firstBatch);
      expect(order.findLastIndex((sql) => sql.includes(OPEN_ATTEMPTS))).toBeLessThan(defaults);
      expect(f.logger.info.mock.calls).toEqual([
        [{ table: 'link_open_attempts', rows: 2001, batches: 4 }, 'open_attempts_deleted'],
        [{ ensured: ALL_ENSURED, dropped: 0, failed: 0 }, 'partition_maintenance_done'],
      ]);
    } else {
      expect(f.logger.info.mock.calls).toEqual([
        [
          { ensured: enabled ? ALL_ENSURED : MONTH_ENSURED, dropped: 0, failed: 0 },
          'partition_maintenance_done',
        ],
      ]);
    }
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.logger.error).not.toHaveBeenCalled();
  },
);

it('[AC-B1-01zk#5] 无过期打开尝试时只调用一次且不多写日志', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  await f.maintenance.runOnce();
  expect(f.queries.filter((q) => q.sql.includes(OPEN_ATTEMPTS))).toHaveLength(1);
  expect(f.logger.info.mock.calls).toEqual([
    [{ ensured: ALL_ENSURED, dropped: 0, failed: 0 }, 'partition_maintenance_done'],
  ]);
});

it('[AC-B1-01zk#5] 中途失败记一次失败、不再续批，已删行数照记，DEFAULT 检查照常', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  let call = 0;
  f.control.respond = async (query) => {
    if (!query.sql.includes(OPEN_ATTEMPTS)) return undefined;
    call += 1;
    if (call === 2) throw { code: '55P03', message: 'private SQL', detail: 'private row data' };
    return [{ deleted: 1000n }];
  };
  const report = await f.maintenance.runOnce();
  expect(call).toBe(2);
  expect(report.failed).toBe(1);
  expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
  expect(f.logger.info.mock.calls).toEqual([
    [{ table: 'link_open_attempts', rows: 1000, batches: 1 }, 'open_attempts_deleted'],
    [{ ensured: ALL_ENSURED, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'link_open_attempts', sqlstate: '55P03' }, 'open_attempts_delete_failed'],
  ]);
});

it('[AC-B1-01zk#5] 达到本轮批次上限即停并告警，余量留给下一轮', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  f.control.respond = async (query) =>
    query.sql.includes(OPEN_ATTEMPTS) ? [{ deleted: BigInt(OPEN_ATTEMPTS_BATCH_SIZE) }] : undefined;
  const report = await f.maintenance.runOnce();
  expect(f.queries.filter((q) => q.sql.includes(OPEN_ATTEMPTS))).toHaveLength(
    OPEN_ATTEMPTS_MAX_BATCHES,
  );
  expect(report.failed).toBe(0);
  expect(f.logger.warn.mock.calls).toEqual([
    [
      {
        table: 'link_open_attempts',
        rows: OPEN_ATTEMPTS_BATCH_SIZE * OPEN_ATTEMPTS_MAX_BATCHES,
        batches: OPEN_ATTEMPTS_MAX_BATCHES,
      },
      'open_attempts_backlog',
    ],
  ]);
});

it('[AC-B1-01zk#5] worker 实例同样清理打开尝试', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z');
  const worker = createWorkerMaintenance({
    db: f.db,
    logger: f.logger as unknown as RootLogger,
    clock: f.clock,
  });
  instances.push(worker);
  await worker.runOnce();
  expect(f.queries.filter((q) => q.sql.includes(OPEN_ATTEMPTS))).toHaveLength(1);
});

// Section K. Batch size and limit are contract values, written out by hand.
const RETENTION_ORDER = [
  'login_logs',
  'device_registrations',
  'inbox_messages',
  'notify_logs',
  'sms_send_attempts',
  'deleted_identities',
];
const RETENTION_CALL = /delete_expired_(?!link_open_attempts|agent_traces)([a-z_]+)/;
const SETTINGS = 'read_retention_settings';

function retentionCalls(queries: readonly CompiledQuery[]): CompiledQuery[] {
  return queries.filter((q) => RETENTION_CALL.test(q.sql));
}

function tableOf(query: CompiledQuery): string | undefined {
  return RETENTION_CALL.exec(query.sql)?.[1];
}

/** The days a retention call of `table` was given. */
function daysOf(queries: readonly CompiledQuery[], table: string): unknown {
  return retentionCalls(queries).find((q) => tableOf(q) === table)?.parameters[1];
}

it.each([
  ['2026-10-08T19:59:59.999Z', true, 0],
  ['2026-10-08T20:00:00.000Z', true, 6],
  ['2026-10-08T20:00:00.000Z', false, 0],
] as const)(
  '[AC-B1-15zb#8] 保留期清理遵守 04:00 门槛与开关（%s，启用=%s，调用 %i 次），无配置行按 08 现值，在打开尝试之后、DEFAULT 检查之前，共用 now、不开显式事务',
  async (instant, enabled, calls) => {
    const f = await fixture(instant, enabled);
    const report = await f.maintenance.runOnce();
    const batches = retentionCalls(f.queries);
    expect(batches).toHaveLength(calls);
    // From 03:00 (+08:00) section M reads the configuration even before section K's gate.
    expect(f.queries.some((q) => q.sql.includes(SETTINGS))).toBe(enabled);
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ dropped: [], failed: 0 });
    expect(f.transactions.some((t) => t.queries.some((q) => RETENTION_CALL.test(q.sql)))).toBe(
      false,
    );
    expect(f.logger.info.mock.calls).toEqual([
      [
        { ensured: enabled ? ALL_ENSURED : MONTH_ENSURED, dropped: 0, failed: 0 },
        'partition_maintenance_done',
      ],
    ]);
    if (calls > 0) {
      const now = f.now.mock.results[0]!.value;
      expect(batches.map((q) => [tableOf(q), q.parameters])).toEqual([
        ['login_logs', [now, 180, 1000]],
        ['device_registrations', [now, 180, 1000]],
        ['inbox_messages', [now, 180, 1000]],
        ['notify_logs', [now, 190, 1000]],
        ['sms_send_attempts', [now, 190, 1000]],
        ['deleted_identities', [now, 1000]],
      ]);
      expect(f.queries.find((q) => q.sql.includes(SETTINGS))?.parameters).toEqual(['couli']);
      const order = f.queries.map((q) => q.sql);
      expect(order.findIndex((sql) => sql.includes(OPEN_ATTEMPTS))).toBeLessThan(
        order.findIndex((sql) => sql.includes(SETTINGS)),
      );
      expect(order.findIndex((sql) => sql.includes(SETTINGS))).toBeLessThan(
        order.findIndex((sql) => RETENTION_CALL.test(sql)),
      );
      expect(order.findLastIndex((sql) => RETENTION_CALL.test(sql))).toBeLessThan(
        order.findIndex((sql) => sql.includes('partition_default_rows')),
      );
    }
  },
);

it('[AC-B1-15zb#8] worker 实例同样清理六张表', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z');
  const worker = createWorkerMaintenance({
    db: f.db,
    logger: f.logger as unknown as RootLogger,
    clock: f.clock,
  });
  instances.push(worker);
  await worker.runOnce();
  expect(retentionCalls(f.queries).map(tableOf)).toEqual(RETENTION_ORDER);
});

it.each([
  [200, 200],
  [180, 180],
  [36500, 36500],
  [50000, 36500],
  [179, 180],
  [0, 180],
  [-1, 180],
  [200.5, 180],
  ['200', 180],
  [true, 180],
  [null, 180],
  [{ days: 200 }, 180],
  [[200], 180],
] as const)(
  '[AC-B1-15zb#9] 配置值 %j 用作 %i 天：不合法回落 08 现值、过大压到函数上限，都不记失败，其他表不受影响',
  async (value, days) => {
    const f = await fixture('2026-10-08T20:00:00.000Z', true);
    f.control.respond = async (query) =>
      query.sql.includes(SETTINGS) ? [{ key: 'retention.login_logs_days', value }] : undefined;
    const report = await f.maintenance.runOnce();
    expect(daysOf(f.queries, 'login_logs')).toBe(days);
    expect(daysOf(f.queries, 'notify_logs')).toBe(190);
    expect(report.failed).toBe(0);
    expect(f.logger.error).not.toHaveBeenCalled();
  },
);

it('[AC-B1-15zb#11] 配置每轮重读：改长后下一轮按新值', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  await f.maintenance.runOnce();
  expect(daysOf(f.queries, 'notify_logs')).toBe(190);
  f.queries.length = 0;
  f.control.respond = async (query) =>
    query.sql.includes(SETTINGS) ? [{ key: 'retention.notify_logs_days', value: 365 }] : undefined;
  await f.maintenance.runOnce();
  expect(daysOf(f.queries, 'notify_logs')).toBe(365);
});

it.each([
  [false, 0],
  [true, 6],
  ['false', 6],
  [null, 6],
] as const)(
  '[AC-B1-15zb#12] retention.purge.enabled 为 %j：调用 %i 次；只有 false 才关，打开尝试与其他维护照常',
  async (value, calls) => {
    const f = await fixture('2026-10-08T20:00:00.000Z', true);
    f.control.respond = async (query) =>
      query.sql.includes(SETTINGS) ? [{ key: 'retention.purge.enabled', value }] : undefined;
    const report = await f.maintenance.runOnce();
    expect(retentionCalls(f.queries)).toHaveLength(calls);
    expect(f.queries.filter((q) => q.sql.includes(OPEN_ATTEMPTS))).toHaveLength(1);
    expect(report.ensured).toHaveLength(ALL_ENSURED);
    expect(report.failed).toBe(0);
    expect(f.logger.error).not.toHaveBeenCalled();
  },
);

it('[AC-B1-15zb#12] 读不到配置时开关未知：本轮一行都不删，只记一次失败，DEFAULT 检查照常', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  f.control.respond = async (query) => {
    if (query.sql.includes(SETTINGS)) throw { code: '55P03', detail: 'private row data' };
    return undefined;
  };
  const report = await f.maintenance.runOnce();
  expect(retentionCalls(f.queries)).toEqual([]);
  expect(report.failed).toBe(1);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'config_items', sqlstate: '55P03' }, 'retention_purge_failed'],
  ]);
  expect(f.transactions.at(-2)?.outcome).toBe('rolled back');
  expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
});

it('[AC-B1-15zb#13] 分批删到 0 只写一行合计，没有删除的表不写日志', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  const deleted = [1000n, 1000n, 500n, 0n];
  f.control.respond = async (query) =>
    tableOf(query) === 'login_logs' ? [{ deleted: deleted.shift() }] : undefined;
  expect((await f.maintenance.runOnce()).failed).toBe(0);
  expect(retentionCalls(f.queries).filter((q) => tableOf(q) === 'login_logs')).toHaveLength(4);
  expect(f.logger.info.mock.calls).toEqual([
    [{ table: 'login_logs', rows: 2500 }, 'retention_purged'],
    [{ ensured: ALL_ENSURED, dropped: 0, failed: 0 }, 'partition_maintenance_done'],
  ]);
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-15zb#14] 做满 100 批还有积压：本表停下记 backlog，不算失败，其他表照常', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  f.control.respond = async (query) =>
    tableOf(query) === 'login_logs' ? [{ deleted: 1000n }] : undefined;
  const report = await f.maintenance.runOnce();
  expect(retentionCalls(f.queries).filter((q) => tableOf(q) === 'login_logs')).toHaveLength(100);
  expect(report.failed).toBe(0);
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'login_logs', rows: 100_000 }, 'retention_purge_backlog'],
  ]);
  expect(retentionCalls(f.queries).at(-1)?.sql).toContain('delete_expired_deleted_identities');
});

it('[AC-B1-15zb#15] 一张表中途失败：已删行数先记、本表不再续批，其他表与维护继续，日志不泄露错误内容', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  let notifyCalls = 0;
  f.control.respond = async (query) => {
    if (tableOf(query) !== 'notify_logs') return undefined;
    notifyCalls += 1;
    if (notifyCalls === 2) throw { code: '55P03', message: 'private SQL', detail: 'private row' };
    return [{ deleted: 1000n }];
  };
  const report = await f.maintenance.runOnce();
  expect(notifyCalls).toBe(2);
  expect(report.failed).toBe(1);
  expect(f.logger.info.mock.calls).toEqual([
    [{ table: 'notify_logs', rows: 1000 }, 'retention_purged'],
    [{ ensured: ALL_ENSURED, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
  ]);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'notify_logs', sqlstate: '55P03' }, 'retention_purge_failed'],
  ]);
  expect(retentionCalls(f.queries).map(tableOf).slice(-2)).toEqual([
    'sms_send_attempts',
    'deleted_identities',
  ]);
  expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
});

it('[AC-B1-15zb#16] 每张表都失败时各记一次，MaintenanceReport 形状不变', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  f.control.respond = async (query) => {
    if (tableOf(query) !== undefined) throw { code: 'secret' };
    return undefined;
  };
  const report = await f.maintenance.runOnce();
  expect(Object.keys(report).sort()).toEqual(['defaultRows', 'dropped', 'ensured', 'failed']);
  expect(report.failed).toBe(RETENTION_ORDER.length);
  expect(f.logger.error.mock.calls).toEqual(
    RETENTION_ORDER.map((table) => [{ table, sqlstate: null }, 'retention_purge_failed']),
  );
});

it('[AC-B1-15zb#16] 返回的行数超出批大小按失败处理，不记不可信的行数', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  f.control.respond = async (query) =>
    tableOf(query) === 'login_logs' ? [{ deleted: 1001n }] : undefined;
  expect((await f.maintenance.runOnce()).failed).toBe(1);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'login_logs', sqlstate: null }, 'retention_purge_failed'],
  ]);
  expect(f.logger.info).toHaveBeenCalledTimes(1);
  expect(retentionCalls(f.queries).filter((q) => tableOf(q) === 'login_logs')).toHaveLength(1);
});

// Section L. The floor and the ceiling are contract values, written out by hand.
const RAW_DROP = 'drop_expired_union_raw_payload_partitions';

function rawDrops(queries: readonly CompiledQuery[]): CompiledQuery[] {
  return queries.filter((q) => q.sql.includes(RAW_DROP));
}

it.each([
  ['2026-10-08T19:59:59.999Z', true, 0],
  ['2026-10-08T20:00:00.000Z', true, 1],
  ['2026-10-08T20:00:00.000Z', false, 0],
] as const)(
  '[AC-B1-15zc#12] union_raw_payloads 遵守 04:00 门槛与 dayPartitions（%s，启用=%s，调用 %i 次）：无配置行按 180 天，配置只读一次，在配置之后、DEFAULT 检查之前，共用 now、不开显式事务',
  async (instant, enabled, calls) => {
    const f = await fixture(instant, enabled);
    await f.maintenance.runOnce();
    expect(rawDrops(f.queries)).toHaveLength(calls);
    // One read per run; from 03:00 (+08:00) section M reads it even before section K's gate.
    expect(f.queries.filter((q) => q.sql.includes(SETTINGS))).toHaveLength(enabled ? 1 : 0);
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(f.transactions.some((t) => t.queries.some((q) => q.sql.includes(RAW_DROP)))).toBe(false);
    if (calls > 0) {
      expect(rawDrops(f.queries)[0]?.parameters).toEqual([f.now.mock.results[0]!.value, 180]);
      const order = f.queries.map((q) => q.sql);
      const call = order.findIndex((sql) => sql.includes(RAW_DROP));
      expect(order.findIndex((sql) => sql.includes(SETTINGS))).toBeLessThan(call);
      expect(call).toBeLessThan(order.findIndex((sql) => sql.includes('partition_default_rows')));
    }
  },
);

it.each([
  [220, 220],
  [180, 180],
  [36500, 36500],
  [50000, 36500],
  [179, 180],
  [0, 180],
  [-1, 180],
  [220.5, 180],
  ['220', 180],
  [true, 180],
  [null, 180],
  [{ days: 220 }, 180],
  [[220], 180],
] as const)(
  '[AC-B1-15zc#13] retention.union_raw_payloads_days 为 %j 时按 %i 天：不合法回落 180、过大压到 36500，都不记失败',
  async (value, days) => {
    const f = await fixture('2026-10-08T20:00:00.000Z', true);
    f.control.respond = async (query) =>
      query.sql.includes(SETTINGS)
        ? [{ key: 'retention.union_raw_payloads_days', value }]
        : undefined;
    const report = await f.maintenance.runOnce();
    expect(rawDrops(f.queries)[0]?.parameters[1]).toBe(days);
    expect(report.failed).toBe(0);
    expect(f.logger.error).not.toHaveBeenCalled();
  },
);

it('[AC-B1-15zc#14] 配置每轮重读：改长后下一轮按新值', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  await f.maintenance.runOnce();
  f.control.respond = async (query) =>
    query.sql.includes(SETTINGS)
      ? [{ key: 'retention.union_raw_payloads_days', value: 365 }]
      : undefined;
  await f.maintenance.runOnce();
  expect(rawDrops(f.queries).map((q) => q.parameters[1])).toEqual([180, 365]);
});

it.each([
  [false, 0],
  [true, 1],
  ['false', 1],
  [null, 1],
] as const)(
  '[AC-B1-15zc#16] retention.purge.enabled 为 %j：本表调用 %i 次；只有 false 才关，event_log 与 link_logs 照丢',
  async (value, calls) => {
    const f = await fixture('2026-10-08T20:00:00.000Z', true);
    f.control.respond = async (query) => {
      if (query.sql.includes(SETTINGS)) return [{ key: 'retention.purge.enabled', value }];
      if (query.sql.includes('drop_expired_month_partitions')) {
        return [{ partitions: ['event_log_p202603'] }];
      }
      if (query.sql.includes('drop_expired_day_partitions')) {
        return [{ partitions: ['link_logs_p20260710'] }];
      }
      return undefined;
    };
    const report = await f.maintenance.runOnce();
    expect(rawDrops(f.queries)).toHaveLength(calls);
    expect(report).toMatchObject({
      dropped: ['event_log_p202603', 'link_logs_p20260710'],
      failed: 0,
    });
  },
);

it('[AC-B1-15zc#18] 读不到配置时开关未知：本表不丢，只记 config_items 这一次失败', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  f.control.respond = async (query) => {
    if (query.sql.includes(SETTINGS)) throw { code: '55P03', detail: 'private row data' };
    return undefined;
  };
  const report = await f.maintenance.runOnce();
  expect(rawDrops(f.queries)).toEqual([]);
  expect(report.failed).toBe(1);
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'config_items', sqlstate: '55P03' }, 'retention_purge_failed'],
  ]);
});

it('[AC-B1-15zc#19] 丢本表失败：一行 partition_drop_failed、不立即重试，行清理与 DEFAULT 检查照做，日志不泄露错误内容，下一轮成功', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  let attempts = 0;
  f.control.respond = async (query) => {
    if (!query.sql.includes(RAW_DROP)) return undefined;
    attempts += 1;
    if (attempts === 1) throw { code: '55P03', message: 'private SQL', detail: 'private row' };
    return [{ partitions: ['union_raw_payloads_p202604'] }];
  };
  const report = await f.maintenance.runOnce();
  expect(attempts).toBe(1);
  expect(report).toMatchObject({ dropped: [], failed: 1 });
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'union_raw_payloads', sqlstate: '55P03' }, 'partition_drop_failed'],
  ]);
  expect(retentionCalls(f.queries).map(tableOf)).toEqual(RETENTION_ORDER);
  expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
  expect(await f.maintenance.runOnce()).toMatchObject({
    dropped: ['union_raw_payloads_p202604'],
    failed: 0,
  });
});

it('[AC-B1-15zc#20] 第 K 节的表失败不挡本表：本表照丢，只记那一个失败', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  f.control.respond = async (query) => {
    if (query.sql.includes(RAW_DROP)) return [{ partitions: ['union_raw_payloads_p202604'] }];
    if (tableOf(query) === 'notify_logs') throw { code: '55P03' };
    return undefined;
  };
  expect(await f.maintenance.runOnce()).toMatchObject({
    dropped: ['union_raw_payloads_p202604'],
    failed: 1,
  });
  expect(f.logger.error.mock.calls).toEqual([
    [{ table: 'notify_logs', sqlstate: '55P03' }, 'retention_purge_failed'],
  ]);
});

it('[AC-B1-15zc#21] 丢掉的分区排在 event_log、link_logs 之后：进报告、记 partition_dropped、计入 done，日志只有表名与分区名', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  const names = ['union_raw_payloads_p202604', 'union_raw_payloads_p202605'];
  f.control.respond = async (query) => {
    if (query.sql.includes('drop_expired_month_partitions')) {
      return [{ partitions: ['event_log_p202603'] }];
    }
    if (query.sql.includes(RAW_DROP)) return [{ partitions: names }];
    return undefined;
  };
  const report = await f.maintenance.runOnce();
  expect(Object.keys(report).sort()).toEqual(['defaultRows', 'dropped', 'ensured', 'failed']);
  expect(report.dropped).toEqual(['event_log_p202603', ...names]);
  expect(f.logger.info.mock.calls).toEqual([
    [{ table: 'event_log', partition: 'event_log_p202603' }, 'partition_dropped'],
    ...names.map((partition) => [{ table: 'union_raw_payloads', partition }, 'partition_dropped']),
    [{ ensured: ALL_ENSURED, dropped: 3, failed: 0 }, 'partition_maintenance_done'],
  ]);
});

it('[AC-B1-15zc#23] worker 实例同样丢本表', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z');
  const worker = createWorkerMaintenance({
    db: f.db,
    logger: f.logger as unknown as RootLogger,
    clock: f.clock,
  });
  instances.push(worker);
  await worker.runOnce();
  expect(rawDrops(f.queries)).toHaveLength(1);
});

// Section M (B3-08s): app.delete_expired_agent_traces from 03:00 (+08:00).
const AGENT_CALL = 'delete_expired_agent_traces';

function agentTraceCalls(queries: readonly CompiledQuery[]): CompiledQuery[] {
  return queries.filter((q) => q.sql.includes(AGENT_CALL));
}

/** The nine rows of one call, `deleted` per table (0 when absent). */
function agentRows(deleted: Partial<Record<(typeof AGENT_TRACE_TABLES)[number], number>>) {
  return AGENT_TRACE_TABLES.map((table_name) => ({
    table_name,
    deleted: BigInt(deleted[table_name] ?? 0),
  }));
}

it.each([
  ['2026-10-08T18:59:59.999Z', true, 0],
  ['2026-10-08T19:00:00.000Z', true, 1],
  ['2026-10-08T20:00:00.000Z', true, 1],
  ['2026-10-08T15:30:00.000Z', true, 1],
  ['2026-10-08T19:00:00.000Z', false, 0],
] as const)(
  '[AC-B3-08s#21] 第 M 节在 %s（dayPartitions=%s）调用 %i 次：+08:00 03:00 起才调，参数为同一个 now、190 天、批量 1000，不开显式事务',
  async (instant, enabled, calls) => {
    const f = await fixture(instant, enabled);
    const report = await f.maintenance.runOnce();
    const made = agentTraceCalls(f.queries);
    expect(made).toHaveLength(calls);
    expect(report.failed).toBe(0);
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(f.transactions.some((t) => t.queries.some((q) => q.sql.includes(AGENT_CALL)))).toBe(
      false,
    );
    for (const query of made) {
      expect(query.parameters).toEqual([f.now.mock.results[0]!.value, 190, 1000]);
    }
    expect(f.queries.filter((q) => q.sql.includes(SETTINGS))).toHaveLength(calls);
    expect(f.logger.info.mock.calls).toEqual([
      [
        { ensured: enabled ? ALL_ENSURED : MONTH_ENSURED, dropped: 0, failed: 0 },
        'partition_maintenance_done',
      ],
    ]);
  },
);

it.each([
  [184, 184],
  [200, 200],
  [36500, 36500],
  [99999, 36500],
  [183, 190],
  [0, 190],
  [-1, 190],
  [200.5, 190],
  ['200', 190],
  [true, 190],
  [null, 190],
  [{ days: 200 }, 190],
  [[200], 190],
] as const)(
  '[AC-B3-08s#12] agent.trace.retention_days 为 %j 时按 %i 天：不可用回落 190、过大压到 36500，都不记失败',
  async (value, days) => {
    const f = await fixture('2026-10-08T19:00:00.000Z', true);
    f.control.respond = async (query) =>
      query.sql.includes(SETTINGS) ? [{ key: 'agent.trace.retention_days', value }] : undefined;
    const report = await f.maintenance.runOnce();
    expect(agentTraceCalls(f.queries).map((q) => q.parameters[1])).toEqual([days]);
    expect(report.failed).toBe(0);
    expect(f.logger.error).not.toHaveBeenCalled();
  },
);

it.each(['2026-10-08T19:30:00.000Z', '2026-10-08T20:00:00.000Z'])(
  '[AC-B3-08s#24] %s 配置读失败：第 M 节不调，整轮只记一次 retention_purge_failed、failed 为 1，done 行计入',
  async (instant) => {
    const f = await fixture(instant, true);
    f.control.respond = async (query) => {
      if (query.sql.includes(SETTINGS)) throw { code: '55P03', detail: 'private row data' };
      return undefined;
    };
    const report = await f.maintenance.runOnce();
    expect(report.failed).toBe(1);
    expect(agentTraceCalls(f.queries)).toEqual([]);
    expect(f.queries.filter((q) => q.sql.includes(SETTINGS))).toHaveLength(1);
    expect(f.logger.error.mock.calls).toEqual([
      [{ table: 'config_items', sqlstate: '55P03' }, 'retention_purge_failed'],
    ]);
    expect(f.logger.info.mock.calls.at(-1)).toEqual([
      { ensured: ALL_ENSURED, dropped: 0, failed: 1 },
      'partition_maintenance_done',
    ]);
  },
);

it('[AC-B3-08s#14] retention.purge.enabled 为 false：第 M 节不调，不写日志', async () => {
  const f = await fixture('2026-10-08T19:00:00.000Z', true);
  f.control.respond = async (query) =>
    query.sql.includes(SETTINGS) ? [{ key: 'retention.purge.enabled', value: false }] : undefined;
  const report = await f.maintenance.runOnce();
  expect(report.failed).toBe(0);
  expect(agentTraceCalls(f.queries)).toEqual([]);
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.error).not.toHaveBeenCalled();
});

it('[AC-B3-08s#22] 循环到九个 0 为止，每表一行合计；调满 100 次仍 > 0 的表记 backlog', async () => {
  const f = await fixture('2026-10-08T19:00:00.000Z', true);
  let call = 0;
  f.control.respond = async (query) => {
    if (!query.sql.includes(AGENT_CALL)) return undefined;
    call += 1;
    return agentRows({ agent_runs: 1000, agent_sessions: call <= 2 ? 7 : 0 });
  };
  expect(await f.maintenance.runOnce()).toMatchObject({ failed: 0 });
  expect(agentTraceCalls(f.queries)).toHaveLength(100);
  expect(f.logger.warn.mock.calls).toEqual([
    [{ table: 'agent_runs', rows: 100_000 }, 'agent_trace_purge_backlog'],
  ]);
  expect(f.logger.info.mock.calls.slice(0, -1)).toEqual([
    [{ table: 'agent_sessions', rows: 14 }, 'agent_trace_purged'],
  ]);

  f.queries.length = 0;
  f.logger.info.mockClear();
  f.logger.warn.mockClear();
  f.control.respond = async (query) =>
    query.sql.includes(AGENT_CALL)
      ? agentRows(agentTraceCalls(f.queries).length === 1 ? { agent_cards: 3 } : {})
      : undefined;
  expect(await f.maintenance.runOnce()).toMatchObject({ failed: 0 });
  expect(agentTraceCalls(f.queries)).toHaveLength(2);
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.info.mock.calls.slice(0, -1)).toEqual([
    [{ table: 'agent_cards', rows: 3 }, 'agent_trace_purged'],
  ]);
});

it.each([
  ['数据库错误', { code: '57014', detail: 'private row data' }, '57014'],
  ['行数超出批量', 'oversized', null],
  ['表名顺序不对', 'misordered', null],
  ['少一行', 'short', null],
] as const)(
  '[AC-B3-08s#23] 第二次调用失败（%s）：先记已删行数，再记 agent_trace_purge_failed，failed 为 1，不再续调，DEFAULT 检查照常，日志不带错误内容',
  async (_label, failure, sqlstate) => {
    const f = await fixture('2026-10-08T19:00:00.000Z', true);
    let call = 0;
    f.control.respond = async (query) => {
      if (!query.sql.includes(AGENT_CALL)) return undefined;
      call += 1;
      if (call === 1) return agentRows({ agent_messages: 2 });
      if (failure === 'oversized') return agentRows({ agent_messages: 1001 });
      if (failure === 'misordered') return agentRows({}).reverse();
      if (failure === 'short') return agentRows({}).slice(1);
      throw failure;
    };
    const report = await f.maintenance.runOnce();
    expect(report.failed).toBe(1);
    expect(agentTraceCalls(f.queries)).toHaveLength(2);
    expect(f.queries.at(-1)?.sql).toContain('partition_default_rows');
    expect(f.logger.info.mock.calls).toEqual([
      [{ table: 'agent_messages', rows: 2 }, 'agent_trace_purged'],
      [{ ensured: ALL_ENSURED, dropped: 0, failed: 1 }, 'partition_maintenance_done'],
    ]);
    expect(f.logger.error.mock.calls).toEqual([[{ sqlstate }, 'agent_trace_purge_failed']]);
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('private');
  },
);

it('[AC-B3-08s#21] 04:00 起第 M 节与第 K 节共用一次配置读取，排在第 K 节之后、DEFAULT 检查之前', async () => {
  const f = await fixture('2026-10-08T20:00:00.000Z', true);
  await f.maintenance.runOnce();
  const order = f.queries.map((q) => q.sql);
  expect(order.filter((sql) => sql.includes(SETTINGS))).toHaveLength(1);
  const agent = order.findIndex((sql) => sql.includes(AGENT_CALL));
  expect(order.findLastIndex((sql) => RETENTION_CALL.test(sql))).toBeLessThan(agent);
  expect(agent).toBeLessThan(order.findIndex((sql) => sql.includes('partition_default_rows')));
});
