// B1-22zd r2 (Codex money r1): the admin account list reads each account row and its current
// credential in one statement (no database: Kysely runs on a recording driver).
// 错实现下怎么红：先读账户、再单独查 union_credentials（两次读取之间提交的回调会把旧到期时间和新授权的
// auth_refreshable 拼成一行）——下面「凭据只出现在同一条带账户表的语句里」与「只发一条查询」都会红；
// re_expires_in_s 取错（0 当 true、null 当 false）则行断言红。
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
import { FixedClock } from '../../platform/index.ts';
import type { SiteReauth } from '../auth-expiry/reauth.ts';
import { AdminUnionAccounts } from './admin-accounts.ts';

const APP = 'unit-app';
const EXPIRES = '2026-12-25T01:30:00.000Z';

function account(id: string, reExpiresIn: number | null) {
  return {
    id,
    platform: 'taobao',
    account_name: `acct-${id.slice(-1)}`,
    status: 'active',
    sync_start_at: null,
    auth_expires_at: new Date(EXPIRES),
    auth_expires_estimated: false,
    auth_status: 'active',
    auth_renewed_at: null,
    auth_renewed_by: null,
    last_probe_at: null,
    last_probe_ok: null,
    last_probe_error: null,
    re_expires_in_s: reExpiresIn,
  };
}

it('[B1-22zd][BR-ID-24] 后台账号列表：账户行与当前凭据在同一条语句里读（left join），auth_refreshable 取自同一次读取', async () => {
  const statements: string[] = [];
  const rows = [
    account('00000000-0000-4000-8000-000000000001', 0),
    account('00000000-0000-4000-8000-000000000002', 86_400),
    account('00000000-0000-4000-8000-000000000003', null),
  ];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled.sql);
      const answer = compiled.sql.includes('"app"."union_accounts"') ? rows : [];
      return Promise.resolve({ rows: answer } as QueryResult<R>);
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const service = new AdminUnionAccounts({
    db,
    clock: new FixedClock('2026-11-24T02:00:00.000Z'),
    crypto: undefined,
    config: () => ({ configValue: async () => null }),
    auditWriter: () => ({ append: async () => undefined }) as never,
    reauth: { reauthMode: async () => 'oauth' } as unknown as SiteReauth,
  });

  const items = await service.list(APP);

  expect(statements).toHaveLength(1);
  const [statement] = statements;
  expect(statement).toMatch(
    /from "app"\."union_accounts" as "a" left join "app"\."union_credentials" as "c"/,
  );
  expect(statement).toContain('"c"."is_current" = $');
  expect(statement).toContain('"c"."app_id" = "a"."app_id"');
  expect(statements.filter((s) => s.includes('union_credentials'))).toEqual([statement]);
  expect(
    items.map((item) => [item.union_account_id, item.auth_expires_at, item.auth_refreshable]),
  ).toEqual([
    ['00000000-0000-4000-8000-000000000001', EXPIRES, false],
    ['00000000-0000-4000-8000-000000000002', EXPIRES, true],
    ['00000000-0000-4000-8000-000000000003', EXPIRES, undefined],
  ]);
  expect(Object.hasOwn(items[2]!, 'auth_refreshable')).toBe(false);
  expect(Object.hasOwn(items[0]!, 're_expires_in_s')).toBe(false);
});
