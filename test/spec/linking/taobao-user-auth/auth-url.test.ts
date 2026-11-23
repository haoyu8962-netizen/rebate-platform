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
import { issueTaobaoAuthState } from '../../../../apps/api/src/modules/linking/application/link-open-taobao.ts';
import type { UnionAuthAppsPort } from '../../../../apps/api/src/modules/linking/application/union-auth-state.ts';
import { createUnionAuthUrl } from '../../../../apps/api/src/modules/linking/application/union-auth-url.ts';
import { FixedClock, type AppEnv } from '../../../../apps/api/src/modules/platform/index.ts';
import { APP_KEY } from '../../union/taobao-site-oauth/kit.ts';
import { USER_REDIRECT } from './kit.ts';

const APP_ID = 'synthetic-app';
const USER_ID = 'synthetic-user';
const DEVICE_ID = 'synthetic-device';
const LINK_ID = 'synthetic-link';
const TRACE_ID = 'synthetic-trace';
const CALLER = { appId: APP_ID, userId: USER_ID, deviceId: DEVICE_ID };
const ENTRIES = ['auth-url', 'open'] as const;
type Entry = (typeof ENTRIES)[number];

async function issue(
  entry: Entry,
  appEnv: AppEnv,
  taobaoUserOAuth: UnionAuthAppsPort['taobaoUserOAuth'],
  binding: 'unbound' | 'invalid',
) {
  // A working station-owner account isolates the missing *user* OAuth configuration path.
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const issuedSessions: (readonly unknown[])[] = [];
  connection.executeQuery = async <Row>(query: CompiledQuery) => {
    const { sql, parameters } = query;
    if (sql.startsWith('insert into "union_auth_sessions"')) {
      issuedSessions.push(parameters);
      return { rows: [] };
    }
    if (sql.includes('from "devices"')) {
      return { rows: [{ platform: 'ios', revoked_at: null }] as Row[] };
    }
    if (sql.includes('from "union_bindings"')) {
      const rows = binding === 'invalid' ? [{ status: binding, union_account_id: 'account' }] : [];
      return { rows: rows as Row[] };
    }
    if (sql.includes('from "union_accounts"')) {
      return { rows: [{ id: 'account', auth_status: 'active', auth_expires_at: null }] as Row[] };
    }
    throw new Error('合成授权夹具收到未预期的数据库操作');
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
  const deps = {
    appEnv,
    clock: new FixedClock('2032-04-01T00:00:00.000Z'),
    config: { configValue: async () => null },
    pids: { getActivePid: async () => null },
    authApps: {
      ...(taobaoUserOAuth === undefined ? {} : { taobaoUserOAuth }),
      resolve: async () => ({ ref: 'synthetic-app-ref' }),
    },
  };
  try {
    if (entry === 'open') {
      const result = await issueTaobaoAuthState(deps, db, {
        appId: APP_ID,
        caller: CALLER,
        userId: USER_ID,
        linkId: LINK_ID,
        code: binding === 'unbound' ? 30101 : 30102,
      });
      return { result, issuedSessions };
    }
    const callerContext = { current: async () => CALLER };
    const service = createUnionAuthUrl({ ...deps, db, callerContext });
    const { envelope: result } = await service.get({
      platform: 'taobao',
      reportedClient: 'ios',
      traceId: TRACE_ID,
    });
    return { result, issuedSessions };
  } finally {
    await db.destroy();
  }
}

it.each(ENTRIES)(
  '[AC-B1-04zzzzm#1] %s 下发真实淘宝授权地址，使用无线端样式和原样的用户回调与 state',
  async (entry) => {
    const { result, issuedSessions } = await issue(
      entry,
      'staging',
      { appKey: APP_KEY, redirectUri: USER_REDIRECT },
      'unbound',
    );

    expect(result).toMatchObject({
      code: entry === 'open' ? 30101 : 0,
      data: { auth_url: expect.any(String), state: expect.any(String), auth_methods: ['web_code'] },
    });
    const { auth_url, state } = result.data as { auth_url: string; state: string };
    expect(URL.canParse(auth_url)).toBe(true);
    expect(state).not.toBe('');
    const url = new URL(auth_url);
    expect(`${url.origin}${url.pathname}`).toBe('https://oauth.taobao.com/authorize');
    expect(url.searchParams.size).toBe(5);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: APP_KEY,
      redirect_uri: USER_REDIRECT,
      state,
      view: 'wap',
    });
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.hash).toBe('');
    const linkId = entry === 'open' ? LINK_ID : null;
    expect(issuedSessions).toEqual([
      expect.arrayContaining([state, APP_ID, USER_ID, DEVICE_ID, linkId]),
    ]);
  },
);

it.each([
  ['staging', '缺用户回调', { appKey: APP_KEY, redirectUri: null }, 'unbound'],
  ['staging', '缺应用标识', { appKey: null, redirectUri: USER_REDIRECT }, 'invalid'],
  ['prod', '缺用户回调', { appKey: APP_KEY, redirectUri: null }, 'invalid'],
  ['prod', '缺应用标识', { appKey: null, redirectUri: USER_REDIRECT }, 'unbound'],
] as const)(
  '[AC-B1-04zzzzm#2] %s %s时，授权管理与购买均返回 auth_unavailable，不签发 state',
  async (appEnv, _description, oauth, binding) => {
    for (const entry of ENTRIES) {
      const { result, issuedSessions } = await issue(entry, appEnv, oauth, binding);
      expect(result).toMatchObject({
        code: binding === 'unbound' ? 30101 : 30102,
        data: { reason: 'auth_unavailable' },
      });
      expect(result.data).not.toHaveProperty('auth_url');
      expect(result.data).not.toHaveProperty('state');
      expect(issuedSessions).toEqual([]);
    }
  },
);
