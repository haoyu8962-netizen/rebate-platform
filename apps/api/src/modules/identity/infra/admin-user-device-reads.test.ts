// Unit tests of the Kysely device store behind adminListUserDevices (B1-02zze): no database; a fake
// driver records the transaction it was asked to open, every statement and the connection each ran on.
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
  type TransactionSettings,
} from 'kysely';
import { expect, it } from 'vitest';
import { createKyselyAdminUserDeviceStore } from './admin-user-device-reads.ts';

type Event =
  | { kind: 'acquire'; connection: number }
  | { kind: 'begin'; connection: number; settings: TransactionSettings }
  | { kind: 'query'; connection: number; sql: string; parameters: readonly unknown[] }
  | { kind: 'commit'; connection: number }
  | { kind: 'rollback'; connection: number }
  | { kind: 'release'; connection: number };

interface Answers {
  items: readonly unknown[];
  total: bigint;
  /** Throw on the count statement. */
  failCount?: boolean;
}

class FakeConnection implements DatabaseConnection {
  constructor(
    readonly id: number,
    private readonly events: Event[],
    private readonly answers: Answers,
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.events.push({
      kind: 'query',
      connection: this.id,
      sql: query.sql,
      parameters: query.parameters,
    });
    if (query.sql.includes('count(*)')) {
      if (this.answers.failCount === true) throw new Error('count failed');
      return { rows: [{ total: this.answers.total }] } as QueryResult<R>;
    }
    return { rows: this.answers.items } as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  #next = 0;
  constructor(
    private readonly events: Event[],
    private readonly answers: Answers,
  ) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    this.#next += 1;
    this.events.push({ kind: 'acquire', connection: this.#next });
    return new FakeConnection(this.#next, this.events, this.answers);
  }
  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    this.events.push({ kind: 'begin', connection: (connection as FakeConnection).id, settings });
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    this.events.push({ kind: 'commit', connection: (connection as FakeConnection).id });
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    this.events.push({ kind: 'rollback', connection: (connection as FakeConnection).id });
  }
  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.events.push({ kind: 'release', connection: (connection as FakeConnection).id });
  }
  async destroy(): Promise<void> {}
}

function fakeDb(answers: Answers): { db: Kysely<DB>; events: Event[] } {
  const events: Event[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(events, answers),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, events };
}

function queries(events: readonly Event[]): Extract<Event, { kind: 'query' }>[] {
  return events.filter(
    (event): event is Extract<Event, { kind: 'query' }> => event.kind === 'query',
  );
}

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-000000000010';
const ITEM = {
  device_id: '019a0000-0000-7000-8000-0000000000d1',
  platform: 'ios',
  app_version: '1.2.0',
  created_at: new Date('2026-11-01T08:00:00.000Z'),
  last_seen_at: new Date('2026-11-02T08:00:00.000Z'),
  reverified_source: null,
  reverified_at: null,
};

const DEVICES_FILTER =
  'from "app"."devices" where "app"."devices"."app_id" = $1 and "app"."devices"."revoked_at" is null and exists ' +
  '(select "app"."sessions"."id" from "app"."sessions" where "app"."sessions"."app_id" = "app"."devices"."app_id" ' +
  'and "app"."sessions"."device_id" = "app"."devices"."id" and "app"."sessions"."user_id" = $2)';

it('[AC-B1-02zze#1] page() 在一个 READ ONLY、REPEATABLE READ 事务里、同一连接上先读一页再读总数，最后提交', async () => {
  const { db, events } = fakeDb({ items: [ITEM], total: 1n });
  await expect(
    createKyselyAdminUserDeviceStore(db).page({ appId: APP, userId: USER, page: 1, pageSize: 20 }),
  ).resolves.toEqual({ items: [ITEM], total: 1 });

  expect(events.map((event) => event.kind)).toEqual([
    'acquire',
    'begin',
    'query',
    'query',
    'commit',
    'release',
  ]);
  expect(new Set(events.map((event) => event.connection))).toEqual(new Set([1]));
  const begin = events.find((event) => event.kind === 'begin');
  expect(begin).toEqual({
    kind: 'begin',
    connection: 1,
    settings: { isolationLevel: 'repeatable read', accessMode: 'read only' },
  });
  const [page, count] = queries(events);
  expect(page!.sql).toMatch(
    /^select "app"."devices"."id" as "device_id", .* limit \$4 offset \$5$/,
  );
  expect(page!.parameters).toEqual([USER, APP, USER, 20, 0]);
  expect(count!.sql).toBe(`select count(*) as "total" ${DEVICES_FILTER}`);
  expect(count!.parameters).toEqual([APP, USER]);
});

it('[AC-B1-02zze#2] 一页的排序、过滤、字段与分页不变：last_seen_at desc、id desc，limit = pageSize，offset = (page-1)×pageSize', async () => {
  const { db, events } = fakeDb({ items: [], total: 0n });
  await createKyselyAdminUserDeviceStore(db).page({
    appId: APP,
    userId: USER,
    page: 3,
    pageSize: 10,
  });
  const [page] = queries(events);
  expect(page!.sql).toBe(
    'select "app"."devices"."id" as "device_id", "app"."devices"."platform", "app"."devices"."app_version", ' +
      '"app"."devices"."created_at", "app"."devices"."last_seen_at", "record"."source" as "reverified_source", ' +
      '"record"."created_at" as "reverified_at" ' +
      'from "app"."devices" left join "app"."reverified_devices" as "record" ' +
      'on "record"."app_id" = "app"."devices"."app_id" and "record"."device_hash" = "app"."devices"."device_hash" ' +
      'and "record"."user_id" = $1 ' +
      'where "app"."devices"."app_id" = $2 and "app"."devices"."revoked_at" is null and exists ' +
      '(select "app"."sessions"."id" from "app"."sessions" where "app"."sessions"."app_id" = "app"."devices"."app_id" ' +
      'and "app"."sessions"."device_id" = "app"."devices"."id" and "app"."sessions"."user_id" = $3) ' +
      'order by "app"."devices"."last_seen_at" desc, "app"."devices"."id" desc limit $4 offset $5',
  );
  expect(page!.parameters).toEqual([USER, APP, USER, 10, 20]);
});

it('[AC-B1-02zze#3] 页码越过末尾：items 为空，total 仍是真实总数（取自单独的 count，不是窗口函数）', async () => {
  const { db, events } = fakeDb({ items: [], total: 5n });
  await expect(
    createKyselyAdminUserDeviceStore(db).page({ appId: APP, userId: USER, page: 9, pageSize: 20 }),
  ).resolves.toEqual({ items: [], total: 5 });
  for (const query of queries(events)) expect(query.sql).not.toMatch(/\bover\s*\(/i);
});

it('[AC-B1-02zze#4] page() 只发 select：没有任何写语句（含数据修改 CTE），写入交给 READ ONLY 由库拒绝', async () => {
  const { db, events } = fakeDb({ items: [ITEM], total: 1n });
  await createKyselyAdminUserDeviceStore(db).page({
    appId: APP,
    userId: USER,
    page: 1,
    pageSize: 20,
  });
  const statements = queries(events);
  expect(statements).toHaveLength(2);
  for (const statement of statements) {
    expect(statement.sql).toMatch(/^select\b/);
    expect(statement.sql).not.toMatch(/\b(insert|update|delete|merge|truncate|copy)\b/i);
  }
});

it('[AC-B1-02zze#1] 总数读失败时事务回滚、错误原样抛出，不提交', async () => {
  const { db, events } = fakeDb({ items: [ITEM], total: 1n, failCount: true });
  await expect(
    createKyselyAdminUserDeviceStore(db).page({ appId: APP, userId: USER, page: 1, pageSize: 20 }),
  ).rejects.toThrow('count failed');
  expect(events.map((event) => event.kind)).toEqual([
    'acquire',
    'begin',
    'query',
    'query',
    'rollback',
    'release',
  ]);
});
