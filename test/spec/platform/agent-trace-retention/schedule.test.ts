// B3-08s — maintenance 第 M 节的门、分批上限、积压、失败与配置读取（BR-ID-30 ①；编排 D10-454、D10-999）。契约见
// ./kit.ts 文件头。不连库：真实的 Kysely SQL 编译加内存驱动，按 SQL 里出现的函数名应答（应答的列名与形状就是
// 契约里的 RETURNS）。业务角色在真库里造不出清理函数的失败，也不值得为 100 批积压插十万行，所以放在这里。
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

import { createPartitionMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import {
  ALL_ENSURED,
  done,
  line,
  memoryLogger,
  reduceLine,
  settableClock,
} from '../maintenance/kit.ts';
import {
  AGENT_TABLES,
  agentLines,
  AT_FOUR,
  BEFORE_GATE,
  cleanupLines,
  DAYS_KEY,
  FUNCTION_NAME,
  NOW,
  SWITCH_KEY,
  type AgentTable,
} from './kit.ts';

interface Control {
  /** 第 call 次调用清理函数（本假库内累计，从 1 起）时各表的删除数；可以抛出。缺的表为 0。 */
  agent: (call: number) => Partial<Record<AgentTable, number>>;
  /** app.read_retention_settings 的行；可以抛出。 */
  settings: () => readonly { readonly key: string; readonly value: unknown }[];
}

interface Fake {
  readonly db: Kysely<DB>;
  readonly queries: CompiledQuery[];
  readonly control: Control;
}

async function fakeDb(): Promise<Fake> {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  const control: Control = { agent: () => ({}), settings: () => [] };
  let agentCalls = 0;
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const text = query.sql;
    let rows: readonly unknown[] = [];
    if (text.includes('current_user')) rows = [{ role: 'couli_maint' }];
    else if (/ensure_(month|day)_partition/.test(text)) {
      rows = [{ partition: `${String(query.parameters[0])}:${String(query.parameters[1])}` }];
    } else if (/drop_expired_\w+_partitions/.test(text)) rows = [{ partitions: [] }];
    else if (text.includes(FUNCTION_NAME)) {
      agentCalls += 1;
      const deleted = control.agent(agentCalls);
      rows = AGENT_TABLES.map((table) => ({
        table_name: table,
        deleted: BigInt(deleted[table] ?? 0),
      }));
    } else if (text.includes('delete_expired_')) rows = [{ deleted: 0n }];
    else if (text.includes('read_retention_settings')) rows = control.settings();
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
  return { db, queries, control };
}

function start(
  db: Kysely<DB>,
  instant: string,
): {
  readonly maintenance: ReturnType<typeof createWorkerMaintenance>;
  readonly clock: ReturnType<typeof settableClock>;
  readonly lines: string[];
} {
  const clock = settableClock(instant);
  const { logger, lines } = memoryLogger();
  return { maintenance: createWorkerMaintenance({ db, logger, clock }), clock, lines };
}

function agentCalls(queries: readonly CompiledQuery[]): CompiledQuery[] {
  return queries.filter((query) => query.sql.includes(FUNCTION_NAME));
}

function count(queries: readonly CompiledQuery[], pattern: RegExp): number {
  return queries.filter((query) => pattern.test(query.sql)).length;
}

/** 第 J、K、L 节的 SQL 函数（04:00 门内才调）。 */
const FOUR_O_CLOCK = /delete_expired_(?!agent_traces)\w+|drop_expired_union_raw_payload_partitions/;

const SETTINGS = /read_retention_settings/;

/** 这次调用带了这个整数（参数或 SQL 字面量）。 */
function mentions(query: CompiledQuery, value: number): boolean {
  return (
    query.parameters.some((parameter) => parameter === value || parameter === String(value)) ||
    new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`).test(query.sql)
  );
}

function expectSameLines(
  actual: readonly (Record<string, unknown> | string)[],
  expected: readonly Record<string, unknown>[],
): void {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}

it.each(['module', 'worker'] as const)(
  '[AC-B3-08s#21] %s：02:59:59.999 不读配置、不调清理函数；03:00 调一次（九个 0 即停）、读一次配置、不调第 J、K、L 节；04:00 起各节共用一次读取；dayPartitions 未开从不调用',
  async (entry) => {
    const fake = await fakeDb();
    const clock = settableClock(BEFORE_GATE);
    const { logger, lines } = memoryLogger();
    const options = { db: fake.db, clock, logger };
    const maintenance =
      entry === 'worker'
        ? createWorkerMaintenance(options)
        : createPartitionMaintenance({ ...options, dayPartitions: true });
    const seen = () => ({
      agent: agentCalls(fake.queries).length,
      settings: count(fake.queries, SETTINGS),
      fourOClock: count(fake.queries, FOUR_O_CLOCK) > 0,
    });

    expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(seen()).toEqual({ agent: 0, settings: 0, fourOClock: false });

    fake.queries.length = 0;
    lines.length = 0;
    clock.set(NOW);
    expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(seen()).toEqual({ agent: 1, settings: 1, fourOClock: false });
    expect(lines.map(reduceLine)).toEqual([done(ALL_ENSURED, 0, 0)]);

    fake.queries.length = 0;
    clock.set(AT_FOUR);
    expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(seen()).toEqual({ agent: 1, settings: 1, fourOClock: true });
    expect(clock.calls()).toBe(3);

    const plain = await fakeDb();
    const off = createPartitionMaintenance({ db: plain.db, logger, clock });
    expect(await off.runOnce()).toMatchObject({ failed: 0 });
    expect(agentCalls(plain.queries)).toEqual([]);
  },
);

it('[AC-B3-08s#22] 循环到九个计数全为 0；每次批量 1000、天数按配置（缺省 190）；调满 100 次仍有删除就停下，最后一次仍 > 0 的表记 backlog、其余记合计；下一轮接着删', async () => {
  const fake = await fakeDb();
  fake.control.agent = (call) => ({
    agent_clarify_asks: 1000,
    agent_tool_calls: call === 1 ? 1000 : call === 2 ? 5 : 0,
  });
  const { maintenance, lines } = start(fake.db, NOW);

  expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
  const first = agentCalls(fake.queries);
  expect(first).toHaveLength(100);
  expect(first.filter((query) => !mentions(query, 1000) || !mentions(query, 190))).toEqual([]);
  expectSameLines(agentLines(lines), [
    line('warn', 'agent_trace_purge_backlog', { table: 'agent_clarify_asks', rows: 100_000 }),
    line('info', 'agent_trace_purged', { table: 'agent_tool_calls', rows: 1005 }),
  ]);
  expect(lines.map(reduceLine).at(-1)).toEqual(done(ALL_ENSURED, 0, 0));

  fake.queries.length = 0;
  lines.length = 0;
  fake.control.agent = (call) => (call === 101 ? { agent_clarify_asks: 1, agent_sessions: 1 } : {});
  fake.control.settings = () => [{ key: DAYS_KEY, value: 200 }];
  expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
  const second = agentCalls(fake.queries);
  expect(second).toHaveLength(2);
  expect(second.filter((query) => !mentions(query, 1000) || !mentions(query, 200))).toEqual([]);
  expectSameLines(agentLines(lines), [
    line('info', 'agent_trace_purged', { table: 'agent_clarify_asks', rows: 1 }),
    line('info', 'agent_trace_purged', { table: 'agent_sessions', rows: 1 }),
  ]);
});

const FAILURES: Array<[string, string | null]> = [
  ['55P03', '55P03'],
  ['57014', '57014'],
  ['不是数据库错误', null],
];

function failure(sqlstate: string | null): Error {
  return sqlstate === null
    ? new TypeError('private SQL')
    : Object.assign(new Error('private SQL'), { code: sqlstate, detail: 'private row data' });
}

it.each(FAILURES)(
  '[AC-B3-08s#23] 第二次调用失败（%s）：先记已删的行，再记 agent_trace_purge_failed，failed 为 1，本轮不再调，日志不带错误内容；04:00 失败不挡第 K 节；下一轮照常',
  async (_label, sqlstate) => {
    const fake = await fakeDb();
    fake.control.agent = (call) => {
      if (call === 2) throw failure(sqlstate);
      return call === 1 ? { agent_tool_calls: 1000, agent_messages: 3 } : {};
    };
    const { maintenance, clock, lines } = start(fake.db, NOW);

    expect(await maintenance.runOnce()).toMatchObject({ failed: 1 });
    expect(agentCalls(fake.queries)).toHaveLength(2);
    const written = agentLines(lines);
    expect(written.at(-1)).toEqual(line('error', 'agent_trace_purge_failed', { sqlstate }));
    expectSameLines(written.slice(0, -1), [
      line('info', 'agent_trace_purged', { table: 'agent_tool_calls', rows: 1000 }),
      line('info', 'agent_trace_purged', { table: 'agent_messages', rows: 3 }),
    ]);
    expect(lines.map(reduceLine).at(-1)).toEqual(done(ALL_ENSURED, 0, 1));
    expect(lines.filter((raw) => raw.includes('private'))).toEqual([]);

    fake.queries.length = 0;
    lines.length = 0;
    clock.set(AT_FOUR);
    fake.control.agent = () => {
      throw failure(sqlstate);
    };
    expect(await maintenance.runOnce()).toMatchObject({ failed: 1 });
    expect(agentCalls(fake.queries)).toHaveLength(1);
    expect(count(fake.queries, /delete_expired_login_logs/)).toBe(1);
    expect(cleanupLines(lines)).toEqual([line('error', 'agent_trace_purge_failed', { sqlstate })]);

    fake.queries.length = 0;
    fake.control.agent = () => ({});
    expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(agentCalls(fake.queries)).toHaveLength(1);
  },
);

it.each([NOW, AT_FOUR])(
  '[AC-B3-08s#24] %s：retention.purge.enabled 为 false 不调；配置读失败不调，整轮只记一行 retention_purge_failed（config_items）、failed 为 1；每轮只读一次配置；之后的轮次照常调',
  async (instant) => {
    const fake = await fakeDb();
    const { maintenance, lines } = start(fake.db, instant);

    fake.control.settings = () => [{ key: SWITCH_KEY, value: false }];
    expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(agentCalls(fake.queries)).toEqual([]);
    expect(lines.map(reduceLine)).toEqual([done(ALL_ENSURED, 0, 0)]);

    lines.length = 0;
    fake.control.settings = () => {
      throw failure('55P03');
    };
    expect(await maintenance.runOnce()).toMatchObject({ failed: 1 });
    expect(agentCalls(fake.queries)).toEqual([]);
    expect(cleanupLines(lines)).toEqual([
      line('error', 'retention_purge_failed', { table: 'config_items', sqlstate: '55P03' }),
    ]);

    lines.length = 0;
    fake.control.settings = () => [];
    expect(await maintenance.runOnce()).toMatchObject({ failed: 0 });
    expect(agentCalls(fake.queries)).toHaveLength(1);
    expect(count(fake.queries, SETTINGS)).toBe(3);
  },
);
