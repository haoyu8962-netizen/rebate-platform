// B1-04zzzzq r2 (money review S1): unit tests of the module's Taobao authorization wiring — the
// auth apps issuance runs under (authAppsFor) and the default credential exchange
// (taobaoBindingExchanger), both with the shared filing readiness. A staging instance configured
// for sdk_token without the web page callback (TAOBAO_USER_OAUTH_REDIRECT_URI) issues and accepts
// sdk_token; web_code without it stays auth_unavailable. Synthetic values and an in-memory query
// stub only: no database, no network.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, type AppConfig } from '../platform/index.ts';
import type { UnionAdapter } from '../union/index.ts';
import type { UnionBindPublisher } from './application/union-binding-exchanger.ts';
import { withBindingUnionAccount } from './application/union-binding-exchanger.ts';
import { createUnionAuthUrl } from './application/union-auth-url.ts';
import { taobaoAuthUrlPlan } from './application/union-auth-state.ts';
import { parseTaobaoSdkAppRef } from './infra/auth-apps.ts';
import { authAppsFor, taobaoBindingExchanger } from './linking.module.ts';

const APP_ID = 'unit-app';
const USER_ID = 'unit-user';
const DEVICE_ID = 'unit-device';
const ACCOUNT = 'unit-account';
const APP_KEY = 'unit-app-key';
const TRACE = 'unit-trace';

function liveConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    appEnv: 'staging',
    taobao: { appKey: APP_KEY },
    taobaoInviterCode: 'unit-inviter',
    taobaoInviterAccountId: ACCOUNT,
    ...over,
  } as unknown as AppConfig;
}

function livePorts(bind: UnionBindPublisher) {
  const adapter = { endpointMode: 'live', bindPublisher: bind } as unknown as UnionAdapter;
  return { union: { adapter: () => adapter } };
}

/** GET auth-url for an unbound android user, the device configured with `methods`. */
async function authUrl(appConfig: AppConfig, methods: readonly string[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const inserted: (readonly unknown[])[] = [];
  connection.executeQuery = async <Row>(query: CompiledQuery) => {
    const { sql, parameters } = query;
    if (sql.startsWith('insert into "union_auth_sessions"')) {
      inserted.push(parameters);
      return { rows: [] };
    }
    if (sql.includes('from "devices"')) {
      return { rows: [{ platform: 'android', revoked_at: null }] as Row[] };
    }
    if (sql.includes('from "union_bindings"')) return { rows: [] };
    if (sql.includes('from "union_accounts"')) {
      return { rows: [{ id: ACCOUNT, auth_status: 'active', auth_expires_at: null }] as Row[] };
    }
    throw new Error('unit: unexpected query');
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
  const bind = vi.fn<UnionBindPublisher>();
  const authApps = authAppsFor(undefined, appConfig, livePorts(bind));
  try {
    const service = createUnionAuthUrl({
      appEnv: appConfig.appEnv,
      clock: new FixedClock('2032-04-01T00:00:00.000Z'),
      config: { configValue: async () => ({ value: [...methods], version: 1 }) },
      pids: { getActivePid: async () => null },
      authApps,
      db,
      callerContext: {
        current: async () => ({ appId: APP_ID, userId: USER_ID, deviceId: DEVICE_ID }),
      },
    });
    const { envelope } = await service.get({
      platform: 'taobao',
      reportedClient: 'android',
      traceId: TRACE,
    });
    return { envelope, inserted, authApps };
  } finally {
    await db.destroy();
  }
}

it('[AC-B1-04zzzzq-UNIT#12] staging 只配 sdk_token、未配网页回调：auth-url 正常签发 sdk_token，地址是合法 uri', async () => {
  const { envelope, inserted, authApps } = await authUrl(liveConfig(), ['sdk_token']);
  expect(authApps.taobaoUserOAuth).toEqual({ appKey: APP_KEY, redirectUri: null });
  expect(taobaoAuthUrlPlan(authApps, 'staging')).toEqual({ kind: 'sdk_only', appKey: APP_KEY });
  expect(envelope).toMatchObject({
    code: 0,
    data: { auth_url: expect.any(String), state: expect.any(String), auth_methods: ['sdk_token'] },
  });
  const data = envelope.data as { auth_url: string; state: string };
  expect(URL.canParse(data.auth_url)).toBe(true);
  expect(new URL(data.auth_url).searchParams.get('state')).toBe(data.state);
  expect(data.state.length).toBeGreaterThan(0);
  expect(data.state.length).toBeLessThanOrEqual(128);
  expect(inserted).toHaveLength(1);
});

it('[AC-B1-04zzzzq-UNIT#12] staging 只配 web_code、未配网页回调：照旧 auth_unavailable，不签发 state', async () => {
  const { envelope, inserted } = await authUrl(liveConfig(), ['web_code']);
  expect(envelope).toMatchObject({ code: 30101, data: { reason: 'auth_unavailable' } });
  expect(envelope.data).not.toHaveProperty('auth_url');
  expect(envelope.data).not.toHaveProperty('state');
  expect(inserted).toEqual([]);
});

it('[AC-B1-04zzzzq-UNIT#12] staging 配了 web_code 与 sdk_token、未配网页回调：只签发 sdk_token', async () => {
  const { envelope } = await authUrl(liveConfig(), ['web_code', 'sdk_token']);
  expect(envelope).toMatchObject({ code: 0, data: { auth_methods: ['sdk_token'] } });
});

it('[AC-B1-04zzzzq-UNIT#13] 未配网页回调时已签发的 sdk state 可提交：门槛放行，令牌带签发时的应用送去备案', async () => {
  const bind = vi.fn<UnionBindPublisher>().mockResolvedValue({ relationId: 'unit-relation' });
  const appConfig = liveConfig();
  const authApps = authAppsFor(undefined, appConfig, livePorts(bind));
  const { ref } = await authApps.resolve(APP_ID, 'staging', 'android', 'sdk_token');
  expect(parseTaobaoSdkAppRef(ref)).toEqual({ appKey: APP_KEY });
  await expect(authApps.resolve(APP_ID, 'staging', 'android', 'web_code')).rejects.toThrow(Error);

  const exchanger = taobaoBindingExchanger(livePorts(bind), appConfig);
  expect(exchanger.filingReady(ACCOUNT)).toBe(true);
  expect(exchanger.filingReady('unit-other-account')).toBe(false);
  const result = await withBindingUnionAccount(ACCOUNT, () =>
    exchanger.exchange({
      appId: APP_ID,
      method: 'sdk_token',
      credential: { access_token: 'unit-sdk-token', expires_in: 3600 },
      appRef: ref,
      traceId: TRACE,
    }),
  );
  expect(result).toEqual({ kind: 'bound', relationId: 'unit-relation' });
  expect(bind).toHaveBeenCalledExactlyOnceWith(
    {
      authorizationCode: 'unit-sdk-token',
      credentialType: 'sdk_token',
      unionAccountId: ACCOUNT,
      oauthApp: { appKey: APP_KEY, redirectUri: '' },
    },
    { appId: APP_ID, requestId: TRACE, purpose: 'online' },
  );
});

it('[AC-B1-04zzzzq-UNIT#13] 应用标识、邀请码或其账号任缺一项：签发与提交照旧都不就绪', async () => {
  const bind = vi.fn<UnionBindPublisher>();
  for (const over of [
    { taobao: null },
    { taobaoInviterCode: null },
    { taobaoInviterAccountId: null },
  ] as const) {
    const appConfig = liveConfig(over);
    const authApps = authAppsFor(undefined, appConfig, livePorts(bind));
    expect(authApps.taobaoUserOAuth).toEqual({ appKey: null, redirectUri: null });
    expect(taobaoBindingExchanger(livePorts(bind), appConfig).filingReady(ACCOUNT)).toBe(false);
  }
  expect(bind).not.toHaveBeenCalled();
});
