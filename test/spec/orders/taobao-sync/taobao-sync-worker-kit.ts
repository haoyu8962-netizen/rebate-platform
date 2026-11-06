// B1-04zzb worker kit: the real order-sync runtime (createOrderSyncRuntime) over a database that
// answers without a connection (no network, no listen), a live Taobao endpoint whose adapter is the
// real TaobaoUnionAdapter of test/spec/union/taobao-orders/kit.ts (fake transport) and a live jd
// endpoint with a synthetic adapter. Each platform has exactly one union_accounts row, so union's
// queryableAccount answers that row without any spy. Queries and log lines are recorded.
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
import { afterEach, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type JobHandler,
  type JobQueue,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { OrderSyncRuntimeDeps } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
  UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { endpoint as taobaoEndpoint } from '../../union/taobao-orders/kit.ts';
import { ACCOUNT, NOW, TAOBAO_ACCOUNT } from '../rescan/kit.ts';

export { taobaoEndpoint };

const APP = 'taobao-sync-spec';
const PLATFORMS: readonly RegisteredPlatform[] = ['jd', 'pdd', 'taobao'];

export const jdEndpoint: UnionEndpoint = {
  platform: 'jd',
  mode: 'live',
  baseUrl: 'https://jd-gateway.invalid/routerjson',
  quotaKey: 'synthetic-taobao-sync-jd',
};

/** app.union_accounts as the worker reads it: one active account per platform. */
const UNION_ACCOUNTS = [
  {
    id: TAOBAO_ACCOUNT,
    app_id: APP,
    platform: 'taobao',
    sync_start_at: new Date('2026-01-01T00:00:00.000Z'),
    auth_status: 'active',
    auth_expires_at: null,
  },
  {
    id: ACCOUNT,
    app_id: APP,
    platform: 'jd',
    sync_start_at: new Date('2026-01-01T00:00:00.000Z'),
    auth_status: 'active',
    auth_expires_at: null,
  },
];

type Answer = (query: CompiledQuery) => readonly unknown[];

class AnsweringDriver extends DummyDriver {
  readonly #answer: Answer;

  constructor(answer: Answer) {
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

/**
 * The database: the accounts filtered by the platforms and ids the query names, the increment
 * cursor of each platform from `cursors` (absent → no row), nothing for any write.
 */
function answeringDb(queries: string[], cursors: Partial<Record<RegisteredPlatform, Date>>) {
  const answer: Answer = (query) => {
    const params = query.parameters;
    if (query.sql.includes('sync_cursors')) {
      if (!/^\s*select\b/i.test(query.sql)) return [];
      const platform = PLATFORMS.find((p) => params.includes(p));
      const at = platform === undefined ? undefined : cursors[platform];
      return at === undefined ? [] : [{ cursor_at: at }];
    }
    if (query.sql.includes('union_accounts')) {
      const byId = UNION_ACCOUNTS.some((row) => params.includes(row.id));
      return UNION_ACCOUNTS.filter(
        (row) => params.includes(row.platform) && (!byId || params.includes(row.id)),
      );
    }
    return [];
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new AnsweringDriver(answer),
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

/** A synthetic jd adapter: it declares no orderSources, as jd today. */
function jdAdapter(): UnionAdapter {
  return {
    platform: 'jd',
    searchItems: vi.fn(),
    getItem: vi.fn(),
    resolveLink: vi.fn(),
    convert: vi.fn(),
    listOrders: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
}

export interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly platform?: string;
}

/** Worker deps whose taobao adapter is `taobao`; nothing runs until the runtime is built. */
export function workerDeps(
  taobao: UnionAdapter,
  cursors: Partial<Record<RegisteredPlatform, Date>> = {},
) {
  const queries: string[] = [];
  const lines: LogLine[] = [];
  const send = vi.fn<JobQueue['send']>(async () => 'synthetic');
  const jd = jdAdapter();
  const deps: OrderSyncRuntimeDeps = {
    db: answeringDb(queries, cursors),
    clock: new FixedClock(NOW),
    logger: createRootLogger(
      { level: 'trace', entry: 'worker', appEnv: 'test' },
      { write: (line: string) => void lines.push(JSON.parse(line) as LogLine) },
    ),
    queue: {
      register: vi.fn<(queue: string, handler: JobHandler) => void>(),
      send,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    events: { publish: vi.fn() },
    endpoints: [taobaoEndpoint, jdEndpoint],
    registry: {
      registrations: () => [],
      get: vi.fn((platform: RegisteredPlatform) => {
        if (platform === 'taobao') return taobao;
        if (platform === 'jd') return jd;
        throw new Error(`union: no adapter for ${platform}`);
      }),
    },
    ports: {
      users: () => ({ findByAttrCode: vi.fn() }),
      bindings: () => ({ findByRelation: vi.fn() }),
      quota: (endpoint) => ({ bucketKey: endpoint.quotaKey, tryAcquire: () => true }),
    },
  };
  return {
    deps,
    queries,
    jd,
    lines: () => [...lines],
    /** Increment windows sent to the order-sync queue, per platform. */
    windows: (platform: RegisteredPlatform) =>
      send.mock.calls
        .filter(([queue, name]) => queue === 'order-sync' && name === 'window')
        .map(([, , payload]) => payload)
        .filter((payload) => payload['platform'] === platform),
  };
}
