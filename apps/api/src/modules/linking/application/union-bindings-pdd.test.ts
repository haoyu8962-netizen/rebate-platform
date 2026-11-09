// Unit test of the GET /v1/unions/bindings Pinduoduo refresh without a database (B1-06zb): the
// self_buy slot is asked for the union account in use (the unreleased binding's) and another
// account's slot never builds the filing query. The SQL runs against PostgreSQL in the rule tests
// (test/spec/linking/bindings-pdd-account).
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
import { describe, expect, it, vi } from 'vitest';
import type { UnionPidRow } from '../../union/index.ts';
import {
  createUnionBindingsWithPddQuery,
  type PddQueryBindingsOptions,
} from './union-bindings-pdd.ts';

const TRACE = '0199a3b4-5c6d-7000-8000-0000000000bb';
const APP = 'synthetic_app';
const USER = '0199a3b4-5c6d-7000-8000-000000000001';
const ACCOUNT_A = '0199a3b4-5c6d-7000-8000-0000000000a1';
const ACCOUNT_B = '0199a3b4-5c6d-7000-8000-0000000000a2';

function setup(slotAccount: string) {
  const getActivePid = vi.fn((input: { readonly unionAccountId?: string }) => {
    void input;
    return Promise.resolve({
      app_id: APP,
      platform: 'pdd',
      pid_scene: 'self_buy',
      status: 'active',
      pid: `synthetic-pid-${slotAccount.slice(-2)}`,
      union_account_id: slotAccount,
    } as unknown as UnionPidRow);
  });
  const registryGet = vi.fn(() => {
    throw new Error('the registry must not be asked');
  });
  const warn = vi.fn();
  const transaction = vi.fn(() => {
    throw new Error('nothing is written');
  });
  const options = {
    db: { transaction },
    callerContext: { current: () => Promise.resolve({ appId: APP, userId: USER, deviceId: null }) },
    reads: {
      binding: (_app: string, _user: string, platform: string) =>
        Promise.resolve(
          platform === 'pdd'
            ? { status: 'pending_auth', accountId: ACCOUNT_A }
            : { status: 'unbound', accountId: null },
        ),
      authAccountId: (_app: string, _platform: string, bound: string | null) =>
        Promise.resolve(bound),
      siteAuthAvailable: () => Promise.resolve(true),
    },
    logger: { warn },
    registry: { get: registryGet },
    pids: { getActivePid },
    attrCodes: { attrCode: () => Promise.resolve('abcd1234') },
  } as unknown as PddQueryBindingsOptions;
  return {
    service: createUnionBindingsWithPddQuery(options),
    getActivePid,
    registryGet,
    warn,
    transaction,
  };
}

describe('GET bindings pdd refresh by the account in use (B1-06zb)', () => {
  it('[AC-B1-06zb] another account slot answered for the account in use is never queried', async () => {
    const { service, getActivePid, registryGet, warn, transaction } = setup(ACCOUNT_B);
    const answer = await service.list({ traceId: TRACE });
    expect(answer.status).toBe(200);
    expect(getActivePid.mock.calls.map(([input]) => input.unionAccountId)).toEqual([ACCOUNT_A]);
    expect(registryGet).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([fields]) => (fields as { event: string }).event)).toEqual([
      'linking.bindings.no_active_pid',
    ]);
  });
});

/** A Kysely over a fake driver: the users reads answer by SQL, anything else fails the test. */
function fakeDb(status: string) {
  const queries: CompiledQuery[] = [];
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      const text = query.sql;
      if (text.includes('from "users"') && text.includes('for no key update')) {
        return Promise.resolve({ rows: [{ id: USER }] as R[] });
      }
      if (text.includes('from "users"') && text.includes('"status"')) {
        return Promise.resolve({ rows: [{ status }] as R[] });
      }
      return Promise.reject(new Error(`unexpected query: ${text}`));
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('streamQuery is not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => {
      events.push('begin');
      return Promise.resolve();
    },
    commitTransaction: () => {
      events.push('commit');
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      events.push('rollback');
      return Promise.resolve();
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries, events };
}

it('[B1-20c] D10-1099 T-7 / D10-1097 查询答已授权时账号已是墓碑（并号已提交）→ 锁后读到 deleted：不写 active 绑定、不写 union_pdd_pid_filings 备案行，warn user_deleted，页面照存答 200', async () => {
  const { db, queries, events } = fakeDb('deleted');
  const warn = vi.fn();
  const queryPddAuthority = vi.fn(() => Promise.resolve({ authorized: true }));
  const options = {
    db,
    clock: { now: () => new Date('2026-11-09T00:00:00Z') },
    callerContext: { current: () => Promise.resolve({ appId: APP, userId: USER, deviceId: null }) },
    reads: {
      binding: (_app: string, _user: string, platform: string) =>
        Promise.resolve(
          platform === 'pdd'
            ? { status: 'released', accountId: ACCOUNT_A }
            : { status: 'unbound', accountId: null },
        ),
      authAccountId: (_app: string, _platform: string, bound: string | null) =>
        Promise.resolve(bound),
      siteAuthAvailable: () => Promise.resolve(true),
    },
    logger: { warn },
    registry: { get: () => ({ queryPddAuthority }) },
    pids: {
      getActivePid: () =>
        Promise.resolve({
          app_id: APP,
          platform: 'pdd',
          pid_scene: 'self_buy',
          status: 'active',
          pid: 'synthetic-pid-a1',
          union_account_id: ACCOUNT_A,
        } as unknown as UnionPidRow),
    },
    attrCodes: { attrCode: () => Promise.resolve('abcd1234') },
  } as unknown as PddQueryBindingsOptions;

  const answer = await createUnionBindingsWithPddQuery(options).list({ traceId: TRACE });

  expect(answer.status).toBe(200);
  expect(queryPddAuthority).toHaveBeenCalledOnce();
  // Only the user lock and the status read: no union_bindings write, no filing insert.
  expect(queries.map((query) => query.sql.split(' ')[0]!.toLowerCase())).toEqual([
    'select',
    'select',
  ]);
  expect(queries.some((query) => query.sql.includes('union_pdd_pid_filings'))).toBe(false);
  expect(queries.some((query) => query.sql.includes('union_bindings'))).toBe(false);
  expect(events).toEqual(['begin', 'commit']);
  expect(warn.mock.calls.map(([fields]) => (fields as { event: string }).event)).toEqual([
    'linking.bindings.user_deleted',
  ]);
});
