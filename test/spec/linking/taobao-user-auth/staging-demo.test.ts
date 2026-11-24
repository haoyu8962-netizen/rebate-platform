import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import { expect, it, vi, type MockInstance } from 'vitest';
import { taobaoUserOAuthRef } from '../../../../apps/api/src/modules/linking/infra/auth-apps.ts';
import type { LinkOpenPorts } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  IDEMPOTENCY,
  ROOT_LOGGER,
  FixedClock,
  createRootLogger,
  loadConfig,
  systemScheduler,
  type Idempotency,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  UNION_ENDPOINTS,
  UNION_REGISTRY,
  createGovernedAdapter,
  createUnionRegistry,
  type UnionAdapter,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/index.ts';
import { APP_KEY, CODE, NOW, environment } from '../../union/taobao-site-oauth/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from './kit.ts';

interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  payload?: { state: string; auth_method: 'web_code'; code: string };
}

interface HttpResponse {
  statusCode: number;
  json(): { code: number; data?: { reason?: string; auth_url?: string; state?: string } };
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: HttpRequest): Promise<HttpResponse>;
}

const API = new URL('../../../../apps/api/', import.meta.url);
const requireApi = createRequire(new URL('package.json', API));
const CALLER = {
  appId: 'synthetic_app',
  userId: '0199a3b4-5c6d-7000-8000-000000000041',
  deviceId: '0199a3b4-5c6d-7000-8000-000000000042',
};
const ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000a1';
const STATE = 'synthetic-one-time-state';
const TRACE = 'synthetic-taobao-auth';
const DEVICE = { platform: 'ios', revoked_at: null };

const HEADERS = {
  'x-app-id': CALLER.appId,
  'x-device-id': CALLER.deviceId,
  'x-platform': DEVICE.platform,
  'x-app-version': '1.0.0',
  'x-trace-id': TRACE,
};

async function withStagingDemo(
  check: (fixture: {
    app: HttpApp;
    demoBind: MockInstance<NonNullable<UnionAdapter['bindPublisher']>>;
    issuedStateCount: () => number;
    bindingWriteCount: () => number;
  }) => Promise<void>,
) {
  const linkingUrl = new URL('src/modules/linking/linking.module.ts', API).href;
  const { LINK_OPEN_PORTS, LinkingModule } = (await import(
    linkingUrl
  )) as typeof import('../../../../apps/api/src/modules/linking/linking.module.ts');
  const nestTestingUrl = pathToFileURL(requireApi.resolve('@nestjs/testing')).href;
  const { Test } = (await import(nestTestingUrl)) as {
    Test: {
      createTestingModule(metadata: { imports: object[] }): {
        compile(): Promise<{ createNestApplication(adapter: unknown): HttpApp }>;
      };
    };
  };
  const nestFastifyUrl = pathToFileURL(requireApi.resolve('@nestjs/platform-fastify')).href;
  const { FastifyAdapter } = (await import(nestFastifyUrl)) as {
    FastifyAdapter: new () => {
      getInstance(): {
        setValidatorCompiler: (compiler: ReturnType<typeof createValidatorCompiler>) => void;
      };
    };
  };

  const config = loadConfig({
    ...environment('staging'),
    TAOBAO_APP_KEY: APP_KEY,
    TAOBAO_APP_SECRET_FILE: '/FAKE_TAOBAO_OAUTH/unused-app-secret',
    TAOBAO_USER_OAUTH_REDIRECT_URI: USER_REDIRECT,
    TAOBAO_INVITER_CODE: INVITER_CODE,
    TAOBAO_INVITER_ACCOUNT_ID: ACCOUNT,
  });
  const clock = new FixedClock(NOW);
  const endpoint: UnionEndpoint = {
    platform: 'taobao',
    mode: 'demo',
    baseUrl: null,
    quotaKey: 'synthetic-taobao-demo',
  };
  const registry = createUnionRegistry({
    endpoints: [endpoint],
    environment: config.appEnv,
    seed: 'synthetic-staging-demo',
    clock,
  });
  const demo = registry.get('taobao');
  const demoBind = vi.spyOn(demo, 'bindPublisher');
  const governed = createGovernedAdapter(demo, {
    endpoint,
    scheduler: systemScheduler(),
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  const ports: Pick<LinkOpenPorts, 'union'> = {
    union: { adapter: (platform) => (platform === 'taobao' ? governed : registry.get(platform)) },
  };
  // Simulate a state issued while live OAuth was configured, before the endpoint switched to demo.
  const expireAt = clock.now();
  expireAt.setTime(expireAt.getTime() + 60_000);
  const appRef = taobaoUserOAuthRef({ appKey: APP_KEY, redirectUri: USER_REDIRECT });
  const session = {
    state: STATE,
    app_id: CALLER.appId,
    user_id: CALLER.userId,
    device_id: CALLER.deviceId,
    client: DEVICE.platform,
    platform: 'taobao',
    mode: 'bind',
    used_at: null,
    expire_at: expireAt,
    auth_methods: ['web_code'],
    auth_app_refs: { web_code: appRef },
  };
  const isAuthSessionInsert = (sql: string) => /^insert into "union_auth_sessions"/i.test(sql);
  const isBindingWrite = (sql: string) =>
    /^(?:insert into|update|delete from) "union_bindings"/i.test(sql);
  const queries: CompiledQuery[] = [];
  function answer(query: CompiledQuery): QueryResult<unknown> {
    queries.push(query);
    const { sql } = query;
    if (sql.includes('from "devices"')) return { rows: [DEVICE] };
    if (sql.includes('from "union_accounts"')) {
      return { rows: [{ id: ACCOUNT, auth_status: 'active', auth_expires_at: null }] };
    }
    if (sql.includes('from "union_auth_sessions"')) return { rows: [session] };
    if (sql.includes('from "users"')) return { rows: [{ id: CALLER.userId, status: 'active' }] };
    return { rows: [], numAffectedRows: 1n };
  }

  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <Row>(query: CompiledQuery) => answer(query) as QueryResult<Row>;
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const idempotency: Pick<Idempotency, 'executeInTransaction'> = {
    executeInTransaction: async (_request, handler) => {
      const { status, envelope } = await db.transaction().execute(handler);
      return { status, body: JSON.stringify(envelope), source: 'handler' };
    },
  };
  const providers = [
    { provide: APP_CONFIG, useValue: config },
    { provide: DB_TOKEN, useValue: db },
    { provide: CLOCK, useValue: clock },
    { provide: IDEMPOTENCY, useValue: idempotency },
    { provide: LINK_OPEN_PORTS, useValue: ports },
    { provide: UNION_ENDPOINTS, useValue: [endpoint] },
    { provide: UNION_REGISTRY, useValue: registry },
    {
      provide: ROOT_LOGGER,
      useValue: createRootLogger({ entry: 'api', appEnv: config.appEnv, level: 'silent' }),
    },
  ];
  class FixtureGlobals {}
  let app: HttpApp | undefined;
  try {
    const testing = await Test.createTestingModule({
      imports: [
        {
          module: FixtureGlobals,
          global: true,
          providers,
          exports: providers.map(({ provide }) => provide),
        },
        LinkingModule.forRoot(() => ({ configValue: async () => null }), {
          callerContext: { useFactory: () => ({ current: async () => CALLER }) },
        }),
      ],
    }).compile();
    const adapter = new FastifyAdapter();
    adapter.getInstance().setValidatorCompiler(createValidatorCompiler());
    app = testing.createNestApplication(adapter);
    await app.init();
    await check({
      app,
      demoBind,
      issuedStateCount: () => queries.filter(({ sql }) => isAuthSessionInsert(sql)).length,
      bindingWriteCount: () => queries.filter(({ sql }) => isBindingWrite(sql)).length,
    });
  } finally {
    await app?.close();
    await db.destroy();
  }
}

it('[AC-B1-04zzzzm#8] staging 淘宝端点为 demo 时 auth-url 拒绝签发授权地址和 state', async () => {
  await withStagingDemo(async ({ app, issuedStateCount }) => {
    const reply = await app.inject({
      method: 'GET',
      url: '/v1/unions/taobao/auth-url',
      headers: HEADERS,
    });
    const body = reply.json();
    expect(reply.statusCode).toBe(422);
    expect(body).toMatchObject({ code: 30101, data: { reason: 'auth_unavailable' } });
    expect(body.data).not.toHaveProperty('auth_url');
    expect(body.data).not.toHaveProperty('state');
    expect(issuedStateCount()).toBe(0);
  });
});

it('[AC-B1-04zzzzm#9] staging 淘宝端点为 demo 时旧有效 state 的授权码不会送到演示适配器或写入绑定', async () => {
  await withStagingDemo(async ({ app, demoBind, bindingWriteCount }) => {
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/unions/taobao/bindings',
      headers: {
        ...HEADERS,
        'idempotency-key': 'synthetic-staging-demo-binding',
        'x-timestamp': String(Math.floor(Date.parse(NOW) / 1000)),
        'x-nonce': 'a'.repeat(32),
        'x-sign': 'a'.repeat(64),
      },
      payload: { state: STATE, auth_method: 'web_code', code: CODE },
    });
    expect(demoBind).not.toHaveBeenCalled();
    expect(bindingWriteCount()).toBe(0);
    expect(reply.statusCode).toBeGreaterThanOrEqual(400);
    const { code } = reply.json();
    expect(code).toBeTypeOf('number');
    expect(code).not.toBe(20001);
    expect(code).not.toBe(0);
  });
});
