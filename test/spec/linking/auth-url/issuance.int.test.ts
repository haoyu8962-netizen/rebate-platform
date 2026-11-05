import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { CallerContext, LinkingModule } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createUnionAuthUrl,
  type AuthClient,
  type UnionAuthUrlInput,
  type UnionAuthUrlOptions,
} from '../../../../apps/api/src/modules/linking/application/union-auth-url.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  tokenPrincipal,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import {
  NOW,
  ROOT,
  TRACE,
  expectOpaqueState,
  normalizedJump,
  success,
  validate,
  type Response,
} from './kit.ts';
import { expectNoState, planValues } from '../pdd-auth-link/kit.ts';

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(key: symbol): T;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

const originalLinking = LinkingModule.forRoot;
const clock = new FixedClock(NOW);
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);

beforeEach(() => clock.set(NOW));
afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
  }
});
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    try {
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

async function seed() {
  const appId = `synthetic_auth_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userId = randomUUID();
  await db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: '合成授权用户',
      avatar: 'https://example.test/avatar',
      invite_code: 'syntheticinvite',
      attr_code: 'demo0001',
      level: 'T1',
      register_method: 'synthetic',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('user_risk_state')
    .values({
      app_id: appId,
      user_id: userId,
      state: 'normal',
      changed_by: 'synthetic-fixture',
      changed_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const devices = { ios: randomUUID(), android: randomUUID(), harmony: randomUUID() };
  for (const client of ['ios', 'android', 'harmony'] as const) {
    await db
      .insertInto('devices')
      .values({
        id: devices[client],
        app_id: appId,
        device_hash: createHash('sha256').update(devices[client]).digest('hex'),
        id_source: client === 'ios' ? 'idfv' : 'oaid',
        install_secret_cipher: Buffer.from('synthetic-unused-cipher'),
        platform: client,
        app_version: '2.0.0',
        last_seen_at: clock.now(),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  const accounts = { taobao: randomUUID(), pdd: randomUUID() };
  for (const platform of ['taobao', 'pdd'] as const) {
    await db
      .insertInto('union_accounts')
      .values({
        id: accounts[platform],
        app_id: appId,
        platform,
        account_name: 'synthetic-auth-account',
        status: 'active',
        auth_status: 'active',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  const configure = async (client: AuthClient, methods: string[]) => {
    await db
      .insertInto('config_items')
      .values({
        app_id: appId,
        key: `union.taobao.auth_methods.${client}`,
        value: JSON.stringify(methods),
        updated_by: 'synthetic-fixture',
      })
      .execute();
  };
  const rows = () =>
    db
      .selectFrom('union_auth_sessions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('state')
      .execute();
  return { appId, userId, devices, accounts, configure, rows };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function start(f: Fixture) {
  // Replace only the identity placeholder; derive identity from the REAL verified token.
  // The unsigned auth-url still runs the normal signature/token/request validation pipeline.
  vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
    const module = originalLinking(...args);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) => {
        if (
          typeof provider !== 'object' ||
          provider.provide !== CallerContext ||
          !('useFactory' in provider)
        )
          return provider;
        return {
          ...provider,
          useFactory: (request: { headers: Record<string, string> }) => ({
            current: async () => {
              const principal = tokenPrincipal(request);
              return {
                appId: principal?.app_id ?? request.headers['x-app-id']!,
                userId: principal?.uid ?? null,
                deviceId: principal?.device_id ?? null,
              };
            },
          }),
        };
      }),
    };
  });
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: typeof logger;
        dbHandles: DbHandles;
        redisUrl: ConnectionConfig['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  return async (
    platform: string,
    client: AuthClient = 'ios',
    query = '',
    signedIn = true,
    extra: Record<string, string> = {},
  ) => {
    const headers: Record<string, string> = {
      'x-app-id': f.appId,
      'x-device-id': f.devices[client],
      'x-platform': client,
      'x-app-version': '2.0.0',
      'x-trace-id': TRACE,
    };
    if (signedIn) {
      const sid = randomUUID();
      await db
        .insertInto('sessions')
        .values({
          id: randomUUID(),
          sid,
          app_id: f.appId,
          user_id: f.userId,
          device_id: f.devices[client],
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      const issued = await app!.get<TokenService>(TOKEN_SERVICE).issueAccess({
        app_id: f.appId,
        uid: f.userId,
        device_id: f.devices[client],
        sid,
        scp: 'full',
      });
      headers['authorization'] = `Bearer ${issued}`;
    }
    return app!.inject({
      method: 'GET',
      url: `/v1/unions/${platform}/auth-url${query}`,
      headers: { ...headers, ...extra },
    });
  };
}

async function bind(f: Fixture, platform: 'taobao' | 'pdd', status: string) {
  await db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: f.userId,
      platform,
      union_account_id: f.accounts[platform],
      status,
      blocked_reason: status === 'blocked' ? 'admin_disable' : null,
      released_at: status === 'released' ? new Date('2026-01-01T00:00:00.000Z') : null,
      cooldown_until: status === 'released' ? new Date('2026-02-01T00:00:00.000Z') : null,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}

it.each(['ios', 'android', 'harmony'] as const)(
  '[AC-B1-06g#1] 淘宝 %s 未配置时默认 web_code，签发完整的未使用 state 快照',
  async (client) => {
    const f = await seed();
    const get = await start(f);
    const response = await get('taobao', client);
    const data = success(response);
    await validate(response.json(), 'UnionAuthUrlResponse');
    expect(data.auth_methods).toEqual(['web_code']);
    expect(data).not.toHaveProperty('auth_jump');
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: data.state,
      app_id: f.appId,
      user_id: f.userId,
      device_id: f.devices[client],
      platform: 'taobao',
      mode: 'bind',
      link_id: null,
      created_at: clock.now(),
      expire_at: new Date(clock.now().getTime() + 600_000),
      used_at: null,
      client,
      auth_methods: ['web_code'],
      auth_app_refs: { web_code: expect.any(String) },
    });
    expect(Object.keys(rows[0]!.auth_app_refs as object)).toEqual(['web_code']);
    expect(Object.values(rows[0]!.auth_app_refs as object)).toEqual([expect.stringMatching(/\S/)]);
    expectOpaqueState(data.state, f.userId, f.devices[client]);
  },
  60_000,
);

it.each([
  ['android', 'ios', ['sdk_token', 'web_code']],
  ['ios', 'android', ['web_code']],
  ['harmony', 'android', ['web_code', 'sdk_token']],
] as const)(
  '[AC-B1-06g#2] 设备记录 %s、请求声明 %s：按记录端配置保序下发并持久化',
  async (client, reported, methods) => {
    const f = await seed();
    await f.configure('android', ['sdk_token', 'web_code']);
    await f.configure('harmony', ['web_code', 'sdk_token']);
    const get = await start(f);
    const response = await get('taobao', client, '', true, { 'x-platform': reported });
    const data = success(response);
    await validate(response.json(), 'UnionAuthUrlResponse');
    expect(data.auth_methods).toEqual(methods);
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client, auth_methods: [...methods], state: data.state });
    expect(Object.keys(rows[0]!.auth_app_refs as object).sort()).toEqual([...methods].sort());
  },
  60_000,
);

it('[AC-B1-06g#3] 同一身份重复调用产生不同 state、两行记录，后一次不覆盖前一次或提前消费', async () => {
  const f = await seed();
  const get = await start(f);
  const firstResponse = await get('taobao');
  const first = success(firstResponse);
  await validate(firstResponse.json(), 'UnionAuthUrlResponse');
  const before = await f.rows();
  expect(before).toHaveLength(1);
  clock.advanceMs(1234);
  const secondResponse = await get('taobao');
  const second = success(secondResponse);
  await validate(secondResponse.json(), 'UnionAuthUrlResponse');
  expect(second.state).not.toBe(first.state);
  for (const data of [first, second]) expectOpaqueState(data.state, f.userId, f.devices.ios);
  const after = await f.rows();
  expect(after).toHaveLength(2);
  expect(after.find((row) => row.state === first.state)).toEqual(before[0]);
  expect(after.find((row) => row.state === second.state)).toMatchObject({
    expire_at: new Date(clock.now().getTime() + 600_000),
    created_at: clock.now(),
    used_at: null,
  });
}, 60_000);

it.each(['ios', 'android', 'harmony'] as const)(
  '[AC-B1-06g#4] 拼多多 %s 的 installed 缺省等同 unknown；只有 auth_jump，快照授权方式两列为空',
  async (client) => {
    const f = await seed();
    // B1-06zf (D10-658 ②): the authorization link is generated for the account's self_buy slot.
    await db
      .insertInto('union_pids')
      .values({
        id: randomUUID(),
        app_id: f.appId,
        platform: 'pdd',
        union_account_id: f.accounts.pdd,
        site_id: null,
        pid: `synthetic-auth-pdd-self_buy-${randomUUID().slice(0, 8)}`,
        pid_scene: 'self_buy',
        status: 'active',
        hjy_ignore_confirmed_at: clock.now(),
        hjy_ignore_evidence_path: 'synthetic/evidence',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    // D10-661 甲: record what the union port answers (the governed wrapper takes the method at
    // entry build, so the call-through spy goes in before start).
    const portAnswers: Array<Awaited<ReturnType<DemoUnionAdapter['pddAuthorityUrl']>>> = [];
    const portAuthorityUrl = DemoUnionAdapter.prototype.pddAuthorityUrl;
    vi.spyOn(DemoUnionAdapter.prototype, 'pddAuthorityUrl').mockImplementation(async function (
      this: DemoUnionAdapter,
      identity,
      context,
    ) {
      const answer = await portAuthorityUrl.call(this, identity, context);
      portAnswers.push(answer);
      return answer;
    });
    const get = await start(f);
    const implicitResponse = await get('pdd', client);
    const implicit = success(implicitResponse);
    const explicitResponse = await get('pdd', client, '?installed=unknown');
    const explicit = success(explicitResponse);
    for (const [response, data] of [
      [implicitResponse, implicit],
      [explicitResponse, explicit],
    ] as const) {
      await validate(response.json(), 'UnionAuthUrlResponse');
      expect(data).not.toHaveProperty('auth_methods');
      expect(data.auth_jump).toMatchObject({
        primary: { type: expect.any(String), value: expect.any(String) },
        fallbacks: expect.any(Array),
        expire_at: expect.any(String),
      });
    }
    expect(normalizedJump(implicit)).toEqual(normalizedJump(explicit));
    const rows = await f.rows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.state).sort()).toEqual([implicit.state, explicit.state].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        app_id: f.appId,
        user_id: f.userId,
        device_id: f.devices[client],
        platform: 'pdd',
        mode: 'bind',
        link_id: null,
        client,
        auth_methods: null,
        auth_app_refs: null,
        used_at: null,
        expire_at: new Date(clock.now().getTime() + 600_000),
      });
    }
    // D10-661 甲: every auth_jump step is a link the port answered for that issuance, never the
    // example.test placeholder and never carrying this state (raw or decoded).
    const decoded = (value: string): string => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    expect(portAnswers).toHaveLength(2);
    for (const [index, data] of [implicit, explicit].entries()) {
      const answer = portAnswers[index]!;
      const answered = [answer.schema_url, answer.mobile_short_url, answer.url].filter(
        (value): value is string => typeof value === 'string' && value !== '',
      );
      const steps = planValues(data.auth_jump);
      for (const step of steps) expect(answered).toContain(step);
      expectNoState([...steps, ...steps.map(decoded)], data.state);
    }
  },
  60_000,
);

it.each(['taobao', 'pdd'] as const)(
  '[AC-B1-06g#5] %s 绑定 blocked 且用户 normal：30153，不签发 state',
  async (platform) => {
    const f = await seed();
    await bind(f, platform, 'blocked');
    const get = await start(f);
    const response = await get(platform);
    expect(response.json()).toMatchObject({ code: 30153, trace_id: TRACE });
    await validate(response.json(), 'ErrorEnvelope');
    expect(response.json()).not.toHaveProperty('data.auth_url');
    expect(response.json()).not.toHaveProperty('data.state');
    expect(await f.rows()).toEqual([]);
  },
  60_000,
);

it.each([
  ['absent', 30101],
  ['unbound', 30101],
  ['pending_auth', 30101],
  ['released', 30101],
  ['invalid', 30102],
] as const)(
  '[AC-B1-06g#6] 站长授权 expired、用户绑定 %s：%i auth_unavailable，不下发授权入口或写行',
  async (status, code) => {
    const f = await seed();
    if (status !== 'absent') await bind(f, 'taobao', status);
    await db
      .updateTable('union_accounts')
      .set({ auth_status: 'expired' })
      .where('id', '=', f.accounts.taobao)
      .execute();
    const get = await start(f);
    const response = await get('taobao');
    expect(response.json()).toMatchObject({ code, data: { reason: 'auth_unavailable' } });
    await validate(response.json(), 'ErrorEnvelope');
    for (const field of ['auth_url', 'state', 'auth_jump']) {
      expect(response.json()).not.toHaveProperty(`data.${field}`);
    }
    expect(await f.rows()).toEqual([]);
  },
  60_000,
);

it('[AC-B1-06g#7] 只有游客设备、无登录令牌：10001，不写授权会话', async () => {
  const f = await seed();
  const get = await start(f);
  const response = await get('taobao', 'ios', '', false);
  expect(response.json()).toMatchObject({ code: 10001 });
  await validate(response.json(), 'ErrorEnvelope');
  expect(response.json()).not.toHaveProperty('data.auth_url');
  expect(await f.rows()).toEqual([]);
}, 60_000);

it.each(['synthetic_unknown', 'jd'])(
  '[AC-B1-06g#8] 不支持授权的平台 %s 返回 20001，不能误签发淘宝授权会话',
  async (platform) => {
    const f = await seed();
    const get = await start(f);
    // jd belongs to the shared PlatformCode enum; this endpoint must reject it at the
    // business boundary, as required by the brief. synthetic_unknown fails schema validation.
    const response = await get(platform);
    expect(response.json()).toMatchObject({ code: 20001 });
    await validate(response.json(), 'ErrorEnvelope');
    expect(await f.rows()).toEqual([]);
  },
  60_000,
);

it('[AC-B1-06g#11] HTTP 请求夹带应用、身份及换绑参数不能改变服务端签发快照', async () => {
  const f = await seed();
  const get = await start(f);
  const initial = success(await get('taobao'));
  const before = await f.rows();
  expect(before).toHaveLength(1);
  const query = new URLSearchParams({
    app_id: 'synthetic_attacker',
    user_id: randomUUID(),
    device_id: f.devices.android,
    link_id: randomUUID(),
    mode: 'rebind',
    auth_methods: 'sdk_token',
    auth_app_refs: JSON.stringify({ web_code: 'synthetic/client/reference' }),
    app_secret: 'synthetic-client-value',
  });
  const response = await get('taobao', 'ios', `?${query}`);
  const body = response.json() as { code: number };
  // Both strict query validation and ignoring unknown query fields preserve this boundary.
  expect([0, 20001]).toContain(body.code);
  if (body.code === 20001) {
    await validate(body, 'ErrorEnvelope');
    expect(await f.rows()).toEqual(before);
  } else {
    const data = success(response);
    await validate(body, 'UnionAuthUrlResponse');
    expect(data.auth_methods).toEqual(['web_code']);
    expect(data.state).not.toBe(initial.state);
    const after = await f.rows();
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.state === initial.state)).toEqual(before[0]);
    expect(after.find((row) => row.state === data.state)).toMatchObject({
      app_id: f.appId,
      user_id: f.userId,
      device_id: f.devices.ios,
      client: 'ios',
      mode: 'bind',
      link_id: null,
      auth_methods: ['web_code'],
      auth_app_refs: before[0]!.auth_app_refs,
    });
  }
  expect(JSON.stringify(body)).not.toContain('synthetic-client-value');
  expect(JSON.stringify(await f.rows())).not.toContain('synthetic/client/reference');
}, 60_000);

function options(f: Fixture, client: AuthClient, appEnv: 'test' | 'prod') {
  // Synthetic canary built at runtime; no real or plausible third-party credential is used.
  const canary = Buffer.from('synthetic application credential for auth url rules').toString(
    'base64url',
  );
  const resolve = vi.fn<UnionAuthUrlOptions['authApps']['resolve']>(
    async (_app, environment, deviceClient, method) => ({
      ref: `synthetic/${environment}/${deviceClient}/${method}`,
      app_secret: canary,
    }),
  );
  // B1-06zf (D10-659): the Pinduoduo authorization link comes through the union port (the demo
  // adapter here) with the user's attr_code read from users.
  const demo = new DemoUnionAdapter({
    platform: 'pdd',
    seed: 'b1-06g-auth-url',
    clock,
    environment: 'test',
  });
  const unionPorts = {
    registry: { get: () => demo },
    attrCodes: {
      attrCode: async (tenant: string, uid: string) => {
        const row = await db
          .selectFrom('users')
          .select('attr_code')
          .where('app_id', '=', tenant)
          .where('id', '=', uid)
          .executeTakeFirst();
        return row?.attr_code ?? null;
      },
    },
  };
  const config: UnionAuthUrlOptions = {
    db,
    clock,
    appEnv,
    callerContext: {
      current: async () => ({ appId: f.appId, userId: f.userId, deviceId: f.devices[client] }),
    },
    config: createContentReader({ db, clock }),
    authApps: { resolve },
    ...unionPorts,
  };
  return { config, resolve, canary };
}

it('[AC-B1-06g#9] 应用快照来自签发环境的服务端配置，忽略请求伪造的身份与应用字段，不保存或返回密钥', async () => {
  const f = await seed();
  await f.configure('android', ['sdk_token', 'web_code']);
  const o = options(f, 'android', 'test');
  const service = createUnionAuthUrl(o.config);
  const request: UnionAuthUrlInput & Record<string, unknown> = {
    platform: 'taobao',
    reportedClient: 'ios',
    traceId: TRACE,
    app_id: 'synthetic_attacker',
    user_id: randomUUID(),
    device_id: f.devices.ios,
    link_id: randomUUID(),
    mode: 'rebind',
    auth_app_refs: { web_code: 'synthetic/client/web', sdk_token: 'synthetic/client/sdk' },
    app_secret: 'synthetic-client-value',
  };
  const result = await service.get(request);
  const response = { statusCode: result.status, json: () => result.envelope };
  const data = success(response);
  await validate(result.envelope, 'UnionAuthUrlResponse');
  expect(data.auth_methods).toEqual(['sdk_token', 'web_code']);
  expect(await f.rows()).toEqual([
    expect.objectContaining({
      state: data.state,
      app_id: f.appId,
      user_id: f.userId,
      device_id: f.devices.android,
      client: 'android',
      mode: 'bind',
      link_id: null,
      auth_methods: ['sdk_token', 'web_code'],
      auth_app_refs: {
        sdk_token: 'synthetic/test/android/sdk_token',
        web_code: 'synthetic/test/android/web_code',
      },
    }),
  ]);
  for (const method of ['sdk_token', 'web_code']) {
    expect(o.resolve).toHaveBeenCalledWith(f.appId, 'test', 'android', method);
  }
  for (const value of [JSON.stringify(result.envelope), JSON.stringify(await f.rows())]) {
    expect(value).not.toContain(o.canary);
    expect(value).not.toContain(encodeURIComponent(o.canary));
    expect(value).not.toContain('synthetic-client-value');
  }
  expect(data).not.toHaveProperty('auth_app_refs');
}, 60_000);

it('[AC-B1-06g#10] prod 配置混入 sdk_token 时只下发 web_code，state 不保存实验方式或跨环境应用引用', async () => {
  const f = await seed();
  await f.configure('android', ['sdk_token', 'web_code']);
  const o = options(f, 'android', 'prod');
  // Only the use-case environment is prod. No production app, adapter, key or network is used.
  // This suite chooses the brief's permitted filtering alternative, not startup rejection.
  const service = createUnionAuthUrl(o.config);
  const result = await service.get({
    platform: 'taobao',
    reportedClient: 'android',
    traceId: TRACE,
  });
  const data = success({ statusCode: result.status, json: () => result.envelope });
  await validate(result.envelope, 'UnionAuthUrlResponse');
  expect(data.auth_methods).toEqual(['web_code']);
  expect(await f.rows()).toEqual([
    expect.objectContaining({
      state: data.state,
      client: 'android',
      auth_methods: ['web_code'],
      auth_app_refs: { web_code: 'synthetic/prod/android/web_code' },
    }),
  ]);
  expect(o.resolve).toHaveBeenCalledWith(f.appId, 'prod', 'android', 'web_code');
  expect(JSON.stringify(result.envelope)).not.toContain(o.canary);
}, 60_000);
