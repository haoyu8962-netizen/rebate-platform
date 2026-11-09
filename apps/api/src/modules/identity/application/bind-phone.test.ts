// Unit tests of the BR-ID-06 merge conditions B1-20e reads from real data in bind-phone (no
// database): a fake Kysely driver answers each SELECT of the first binding by its SQL; the
// AccountAssetsPort, the risk port, SMS and Redis are stubs.
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
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type FieldCrypto, type RedisHandle } from '../../platform/index.ts';
import {
  createBindPhoneService,
  type AccountAssetsPort,
  type AccountRef,
  type BindPhoneResult,
} from './bind-phone.ts';

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-0000000000a1';
const TARGET = '019a0000-0000-7000-8000-0000000000b1';

type Respond = (query: CompiledQuery) => readonly unknown[];

class FakeConnection implements DatabaseConnection {
  constructor(
    private readonly respond: Respond,
    private readonly queries: CompiledQuery[],
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.queries.push(query);
    return { rows: this.respond(query) } as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  constructor(private readonly connection: FakeConnection) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

interface Scenario {
  /** deletion_requests.status the stage reader's left join returns for the target. */
  readonly request?: 'cooling' | 'processing' | null;
  readonly claims?: boolean;
  readonly ledger?: boolean;
  /** D10-1099 Q-3 / Q-4 (merge-conditions.ts). */
  readonly adjustments?: boolean;
  readonly disabledBindings?: boolean;
}

interface Run {
  readonly result: BindPhoneResult;
  readonly queries: readonly CompiledQuery[];
  readonly assetCalls: readonly { readonly port: string; readonly account: AccountRef }[];
  readonly tickets: number;
}

async function run(scenario: Scenario): Promise<Run> {
  const queries: CompiledQuery[] = [];
  const respond: Respond = (query) => {
    const text = query.sql;
    if (text.includes('"deletion_requests"')) {
      return [{ id: TARGET, status: 'normal', request_status: scenario.request ?? null }];
    }
    if (text.includes('"user_oauth"')) return [];
    if (text.includes('from "app"."users"') && text.endsWith('for update')) {
      return [
        {
          phone_hmac: null,
          register_method: 'wechat',
          parent_id: null,
          status: 'normal',
          row_version: 1,
        },
      ];
    }
    if (text.includes('from "app"."users"') && text.includes('"parent_id" =')) return [];
    if (text.includes('from "app"."users"') && text.includes('"phone_hmac" =')) {
      return [{ id: TARGET, status: 'normal' }];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  const connection = new FakeConnection(respond, queries);
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(connection),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const assetCalls: { port: string; account: AccountRef }[] = [];
  const assets: AccountAssetsPort = {
    countOrders: (_db, account) => {
      assetCalls.push({ port: 'countOrders', account });
      return Promise.resolve(0);
    },
    hasClaims: (_db, account) => {
      assetCalls.push({ port: 'hasClaims', account });
      return Promise.resolve(scenario.claims ?? false);
    },
    hasLedgerEntries: (_db, account) => {
      assetCalls.push({ port: 'hasLedgerEntries', account });
      return Promise.resolve(scenario.ledger ?? false);
    },
  };
  let tickets = 0;
  const redis = {
    namespace: () => ({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      eval: () => {
        tickets += 1;
        return Promise.resolve('OK');
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } satisfies RedisHandle;
  const crypto = {
    blindIndex: (value: string) => `hmac:${value}`,
    encrypt: (value: string) => `enc:${value}`,
  } as unknown as FieldCrypto;
  const service = createBindPhoneService({
    clock: new FixedClock('2026-10-31T00:00:00Z'),
    crypto,
    redis,
    sms: { verifyAndConsume: () => Promise.resolve({ code: 0 }) },
    blocklist: null,
    risk: { isBanned: () => Promise.resolve(false) },
    assets,
    barriers: {
      hasAdjustments: (_db, account) => {
        assetCalls.push({ port: 'hasAdjustments', account });
        return Promise.resolve(scenario.adjustments ?? false);
      },
      hasDisabledBindings: (_db, account) => {
        assetCalls.push({ port: 'hasDisabledBindings', account });
        return Promise.resolve(scenario.disabledBindings ?? false);
      },
    },
  });
  const result = await db.transaction().execute((trx) =>
    service.bind(trx, {
      app_id: APP,
      user_id: USER,
      device_id: 'device-1',
      body: { phone: '13800000001', code: '123456' },
    }),
  );
  return { result, queries, assetCalls, tickets };
}

function stageQueries(queries: readonly CompiledQuery[]) {
  return queries.filter((query) => query.sql.includes('"deletion_requests"'));
}

it('[B1-20e] 条件全满足 → 30411 + mergeable + merge_ticket；在同一事务读目标账号的注销阶段与当前账号的找回申请、余额流水', async () => {
  const { result, queries, assetCalls, tickets } = await run({});
  expect(result.code).toBe(30411);
  expect(result).toMatchObject({ data: { reason: 'mergeable' } });
  expect(tickets).toBe(1);
  const stage = stageQueries(queries);
  expect(stage).toHaveLength(1);
  expect(stage[0]?.parameters).toContain(APP);
  expect(stage[0]?.parameters).toContainEqual([TARGET]);
  const account = { app_id: APP, user_id: USER };
  expect(assetCalls).toEqual([
    { port: 'countOrders', account },
    { port: 'hasClaims', account },
    { port: 'hasLedgerEntries', account },
    { port: 'hasAdjustments', account },
    { port: 'hasDisabledBindings', account },
  ]);
});

for (const request of ['cooling', 'processing'] as const) {
  it(`[B1-20e] 目标账号注销阶段为 ${request} → 只回 30411（无 data、不发 ticket）`, async () => {
    const { result, tickets } = await run({ request });
    expect(result).toEqual({ code: 30411 });
    expect(tickets).toBe(0);
  });
}

it('[B1-20e] 当前账号有找回申请 → 只回 30411（无 data、不发 ticket）', async () => {
  const { result, tickets } = await run({ claims: true });
  expect(result).toEqual({ code: 30411 });
  expect(tickets).toBe(0);
});

it('[B1-20e] 当前账号余额有流水 → 只回 30411（无 data、不发 ticket）', async () => {
  const { result, tickets } = await run({ ledger: true });
  expect(result).toEqual({ code: 30411 });
  expect(tickets).toBe(0);
});

it('[B1-20e] 整个判定只发 SELECT，不写、不改', async () => {
  const { queries } = await run({ request: 'cooling' });
  for (const query of queries) {
    expect(query.sql).toMatch(/^select /);
  }
});

it('[B1-20c] D10-1099 Q-3 当前账号有调账单 → 只回 30411（无 data、不发 ticket）', async () => {
  const { result, tickets } = await run({ adjustments: true });
  expect(result).toEqual({ code: 30411 });
  expect(tickets).toBe(0);
});

it('[B1-20c] D10-1099 Q-4 当前账号有 admin_disable 的联盟绑定 → 只回 30411（无 data、不发 ticket）', async () => {
  const { result, tickets } = await run({ disabledBindings: true });
  expect(result).toEqual({ code: 30411 });
  expect(tickets).toBe(0);
});
