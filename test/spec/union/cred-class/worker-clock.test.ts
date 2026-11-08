import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createOrderSyncRuntime,
  type OrderSyncRuntimeDeps,
} from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type JobQueue,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { endpoint } from './cred-kit.ts';

// 编排者补充第 11 条（D10-961 并入）：createOrderSyncRuntime 构造联盟同步访问时，用注入的 Clock 判站长授权
// 是否过期（BR-ID-24 ④）。数据库只回答、不连接；union_accounts 那一行的 auth_expires_at 落在注入时刻与真实
// 时刻之间，两种先后各一条：只有按注入时钟判，两条才都对。

const APP = 'synthetic-cred-worker-app';
const ACCOUNT = '01920000-0000-7000-8000-00000000c011';

class AnsweringDriver extends DummyDriver {
  readonly #answer: (query: CompiledQuery) => readonly unknown[];

  constructor(answer: (query: CompiledQuery) => readonly unknown[]) {
    super();
    this.#answer = answer;
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const answer = this.#answer;
    return {
      executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => ({
        rows: answer(query) as R[],
      }),
      streamQuery: (): never => {
        throw new Error('synthetic database: no streaming');
      },
    };
  }
}

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

/** union_accounts answers one active account expiring at `expiresAt`; nothing else has rows. */
function accountDb(expiresAt: Date, queries: string[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new AnsweringDriver((query) =>
          query.sql.includes('union_accounts') && query.parameters.includes(ACCOUNT)
            ? [{ auth_status: 'active', auth_expires_at: expiresAt }]
            : [],
        ),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
  databases.push(db);
  return db;
}

function taobaoAdapter(): UnionAdapter {
  return {
    platform: 'taobao',
    searchItems: vi.fn<UnionAdapter['searchItems']>(),
    getItem: vi.fn<UnionAdapter['getItem']>(),
    resolveLink: vi.fn<UnionAdapter['resolveLink']>(),
    convert: vi.fn<UnionAdapter['convert']>(),
    listOrders: vi.fn<UnionAdapter['listOrders']>(async () => ({ items: [], nextCursor: null })),
  };
}

/** The worker's runtime over that database, with `now` as its injected clock. */
function runtimeAt(now: string, expiresAt: Date) {
  const queries: string[] = [];
  const adapter = taobaoAdapter();
  const deps: OrderSyncRuntimeDeps = {
    db: accountDb(expiresAt, queries),
    clock: new FixedClock(now),
    logger: createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' }),
    queue: {
      register: vi.fn<(queue: string, handler: JobHandler) => void>(),
      send: vi.fn<JobQueue['send']>(async () => 'synthetic'),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    events: { publish: vi.fn() },
    endpoints: [endpoint],
    registry: {
      registrations: () => [],
      get: vi.fn((platform: RegisteredPlatform) => {
        if (platform === 'taobao') return adapter;
        throw new Error(`union: no adapter for ${platform}`);
      }),
    },
    ports: {
      users: () => ({ findByAttrCode: vi.fn() }),
      bindings: () => ({ findByRelation: vi.fn() }),
      quota: (configured) => ({ bucketKey: configured.quotaKey, tryAcquire: () => true }),
    },
  };
  return { runtime: createOrderSyncRuntime(deps), queries };
}

const account = {
  app_id: APP,
  platform: 'taobao',
  union_account_id: ACCOUNT,
  sync_start_at: null,
} as const;

it('[AC-B1-04zzzx#18] worker 运行时按注入的 Clock 判站长授权：注入时刻早于到期（真实时刻已过）→ 可用', async () => {
  const { runtime, queries } = runtimeAt(
    '2020-06-01T00:00:00.000Z',
    new Date('2021-06-01T00:00:00.000Z'),
  );
  const available = await runtime.access.siteAuthAvailable(account);
  expect(queries.some((sql) => sql.includes('union_accounts'))).toBe(true);
  expect(available).toBe(true);
});

it('[AC-B1-04zzzx#19] worker 运行时按注入的 Clock 判站长授权：注入时刻已过到期（真实时刻未到）→ 不可用', async () => {
  const { runtime, queries } = runtimeAt(
    '2999-06-01T00:00:00.000Z',
    new Date('2998-06-01T00:00:00.000Z'),
  );
  const available = await runtime.access.siteAuthAvailable(account);
  expect(queries.some((sql) => sql.includes('union_accounts'))).toBe(true);
  expect(available).toBe(false);
});
