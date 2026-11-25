// B1-22zd r2 (Codex money r1): the admin account list reads each account row and its current
// credential in one statement (no database: Kysely runs on a recording driver).
// 错实现下怎么红：先读账户、再单独查 union_credentials（两次读取之间提交的回调会把旧到期时间和新授权的
// auth_refreshable 拼成一行）——下面「凭据只出现在同一条带账户表的语句里」与「只发一条查询」都会红；
// re_expires_in_s 取错（0 当 true、null 当 false）则行断言红。
// B1-22ze r3（Codex money r2 S1-②）：手工录入的首次排程不补「提交时已到点、未到期」的最小有效节点
// （h6 被当成已过跳过、只排 h1），或在提交之前排、已到点的节点带延迟排，第二条红。
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
import { FixedClock, type FieldCrypto, type JobQueue } from '../../platform/index.ts';
import { JOB_HOUR_ALERT, KEY_ALERT_HOURS } from '../auth-expiry/hour-alerts.ts';
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

it('[B1-22ze][BR-ID-24] 手工录入凭据的首次排程：等锁提交时已到点、未到期的最小有效节点立即入队，后续节点照节点时刻排', async () => {
  // Entered at 10:59:59.800 (+08:00) expiring 17:00:00: total 6 h + 200 ms, h6 is live at
  // 11:00:00; the row lock makes the commit end at 11:00:00.600.
  const entered = Date.parse('2026-11-22T02:59:59.800Z');
  const committedAt = Date.parse('2026-11-22T03:00:00.600Z');
  const expires = Date.parse('2026-11-22T09:00:00.000Z');
  const id = '00000000-0000-4000-8000-000000000001';
  let committed = false;
  const order: string[] = [];
  const row = { ...account(id, null), platform: 'jd', row_version: 3 };
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      if (text.startsWith('select') && text.includes('"union_accounts"')) {
        return Promise.resolve({ rows: [row] } as QueryResult<R>);
      }
      return Promise.resolve({ rows: [], numAffectedRows: 1n } as QueryResult<R>);
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => {
      committed = true;
      order.push('commit');
    },
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
  const sends: Parameters<JobQueue['send']>[] = [];
  const service = new AdminUnionAccounts({
    db,
    clock: { now: () => new Date(committed ? committedAt : entered) },
    crypto: { encrypt: () => 'cipher' } as unknown as FieldCrypto,
    config: () => ({
      configValue: async (_appId: string, key: string) =>
        key === KEY_ALERT_HOURS ? ({ value: [6, 1], version: 1 } as never) : null,
    }),
    auditWriter: () => ({ append: async () => undefined }) as never,
    reauth: { reauthMode: async () => 'manual' } as unknown as SiteReauth,
    queue: {
      send: async (...args) => {
        sends.push(args);
        order.push(`send:${args[1]}`);
        return 'job';
      },
    },
  });

  await service.putCredential({ appId: APP, adminId: 'admin-1', ip: null }, id, {
    credential: 'key-1',
    expires_at: '2026-11-22T17:00:00+08:00',
  } as never);

  const hourSends = sends.filter(([, name]) => name === JOB_HOUR_ALERT);
  expect(hourSends.map(([, , p, o]) => [p['hours'], o.delaySeconds, o.trx])).toEqual([
    [6, undefined, null],
    [1, Math.ceil((expires - 3_600_000 - committedAt) / 1000), null],
  ]);
  expect(order.indexOf(`send:${JOB_HOUR_ALERT}`)).toBeGreaterThan(order.indexOf('commit'));
});
