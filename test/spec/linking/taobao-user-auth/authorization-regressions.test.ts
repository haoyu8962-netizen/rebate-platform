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
import { expect, it, vi } from 'vitest';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import { createUnionBindings } from '../../../../apps/api/src/modules/linking/application/union-bindings.ts';
import type {
  CallerContext,
  LinkingConfigReader,
} from '../../../../apps/api/src/modules/linking/ports.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  ROOT_LOGGER,
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { expectRedacted, response, setup } from '../../union/taobao-core/kit.ts';
import {
  ACCESS,
  APP_KEY,
  AUTHORIZE_ENDPOINT,
  CODE,
  NOW,
  REFRESH,
  SECRET,
  TOKEN_ENDPOINT,
  environment,
  tokenAnswer,
} from '../../union/taobao-site-oauth/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from './kit.ts';

const CALLER = {
  appId: 'synthetic_app',
  userId: '0199a3b4-5c6d-7000-8000-000000000041',
  deviceId: '0199a3b4-5c6d-7000-8000-000000000042',
};
const INVITER_ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000a1';
const OTHER_ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000a2';
const RELATION = '811796';
const STATE = 'synthetic-one-time-state';
const TRACE = 'synthetic-taobao-auth';
const SAVE = 'taobao.tbk.sc.publisher.info.save';
const USER_NICK = '合成授权昵称';
const USER_ID = '2200000000042';
const ACCOUNT_NAME = '合成渠道账号';
const DEVICE = { platform: 'ios', revoked_at: null };

type Row = Record<string, unknown>;
type InviterAccountConfig = { readonly taobaoInviterAccountId?: string | null };

async function scriptedDb(answer: (query: CompiledQuery) => QueryResult<Row>) {
  const queries: CompiledQuery[] = [];
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return answer(query) as QueryResult<R>;
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
  return { db, queries };
}

function bindingWrite(sql: string): boolean {
  return /^(?:insert into|update) "union_bindings"/i.test(sql);
}

async function submitBinding(selectedAccount: string, configuredAccount: string | undefined) {
  const config: ReturnType<typeof loadConfig> & InviterAccountConfig = loadConfig({
    ...environment('staging'),
    TAOBAO_USER_OAUTH_REDIRECT_URI: USER_REDIRECT,
    TAOBAO_INVITER_CODE: INVITER_CODE,
    ...(configuredAccount === undefined ? {} : { TAOBAO_INVITER_ACCOUNT_ID: configuredAccount }),
  });

  const { adapter, clock, transport, warn } = setup({
    credentials: async () => ({
      appKey: APP_KEY,
      appSecret: SECRET,
      userOAuth: {
        redirectUri: config.taobaoUserOAuthRedirectUri ?? null,
        inviterCode: config.taobaoInviterCode ?? null,
        inviterAccountId: config.taobaoInviterAccountId ?? null,
      },
    }),
  });
  transport.mockImplementation(async ({ url, body }) => {
    if (url === TOKEN_ENDPOINT) {
      const user = { taobao_user_id: USER_ID, taobao_user_nick: encodeURIComponent(USER_NICK) };
      return response(tokenAnswer(user));
    }
    if (new URLSearchParams(body ?? '').get('method') === SAVE) {
      return response({
        tbk_sc_publisher_info_save_response: {
          data: { relation_id: RELATION, account_name: ACCOUNT_NAME },
        },
      });
    }
    throw new Error('合成备案夹具收到未预期的上游请求');
  });
  const publisher = vi.fn(adapter.bindPublisher.bind(adapter));
  const bindingWarn = vi.fn();
  const { db, queries } = await scriptedDb(({ sql }) => {
    if (sql.includes('from "devices"')) return { rows: [DEVICE] };
    if (sql.includes('from "union_auth_sessions"')) {
      const expires = clock.now();
      expires.setTime(expires.getTime() + 60_000);
      return {
        rows: [
          {
            state: STATE,
            app_id: CALLER.appId,
            user_id: CALLER.userId,
            device_id: CALLER.deviceId,
            client: 'ios',
            platform: 'taobao',
            mode: 'bind',
            used_at: null,
            expire_at: expires,
            auth_methods: ['web_code'],
            auth_app_refs: { web_code: 'synthetic-app-ref' },
          },
        ],
      };
    }
    if (sql.includes('from "users"')) return { rows: [{ id: CALLER.userId, status: 'active' }] };
    if (sql.startsWith('update "union_auth_sessions"') || bindingWrite(sql)) {
      return { rows: [], numAffectedRows: 1n };
    }
    return { rows: [] };
  });

  try {
    const bindings = createUnionBindings({
      db,
      clock,
      callerContext: { current: async () => CALLER },
      reads: {
        binding: async () => ({ status: 'unbound', accountId: null }),
        authAccountId: async () => selectedAccount,
        siteAuthAvailable: async () => true,
        configuredMethods: async () => ['web_code'],
        userBanned: async () => false,
      },
      idempotency: {
        executeInTransaction: async (_request, handler) => {
          const { status, envelope } = await db.transaction().execute(handler);
          return { status, body: JSON.stringify(envelope), source: 'handler' };
        },
      },
      exchanger: new UnionBindingExchanger(() => publisher),
      logger: { warn: bindingWarn },
    });
    const result = await bindings.bind({
      platform: 'taobao',
      body: { state: STATE, auth_method: 'web_code', code: CODE },
      idempotencyKey: 'synthetic-inviter-account-check',
      traceId: TRACE,
    });
    return {
      result,
      writes: queries.filter(({ sql }) => bindingWrite(sql)),
      saves: transport.mock.calls
        .map(([request]) => new URLSearchParams(request.body ?? ''))
        .filter((form) => form.get('method') === SAVE),
      warnings: [...warn.mock.calls, ...bindingWarn.mock.calls],
      publisher,
    };
  } finally {
    await db.destroy();
  }
}

const REFUSALS = [
  { scenario: '邀请码归属另一联盟账号', account: INVITER_ACCOUNT },
  { scenario: '未配置邀请码归属账号', account: undefined },
] as const;

it.each(REFUSALS)('[AC-B1-04zzzzm#6] $scenario 时拒绝渠道备案', async ({ account }) => {
  const refused = await submitBinding(OTHER_ACCOUNT, account);
  expect(refused.saves).toHaveLength(0);
  expect(refused.writes).toEqual([]);
  expect(refused.result.status).toBeGreaterThanOrEqual(400);
  expect(refused.result.envelope.code).not.toBe(0);
  expect(refused.warnings.length).toBeGreaterThan(0);
  for (const [fields] of refused.warnings) {
    expect(fields).toEqual(expect.any(Object));
    for (const value of Object.values(fields ?? {})) {
      expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
    }
  }
  const privateMarkers = [
    CODE,
    ACCESS,
    REFRESH,
    SECRET,
    INVITER_CODE,
    USER_ID,
    USER_NICK,
    encodeURIComponent(USER_NICK),
    ACCOUNT_NAME,
  ];
  expectRedacted([refused.result, refused.warnings], privateMarkers);

  const accepted = await submitBinding(INVITER_ACCOUNT, INVITER_ACCOUNT);
  expect(accepted.publisher).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ authorizationCode: CODE }),
    expect.objectContaining({ appId: CALLER.appId }),
  );
  expect(accepted.saves.map((form) => form.get('inviter_code'))).toEqual([INVITER_CODE]);
  expect(accepted.result).toMatchObject({
    status: 200,
    envelope: { code: 0, data: { platform: 'taobao', status: 'active' } },
  });
  expect(accepted.writes).toEqual([
    expect.objectContaining({
      sql: expect.stringMatching(/^insert into "union_bindings"/),
      parameters: expect.arrayContaining([CALLER.appId, INVITER_ACCOUNT, RELATION, 'active']),
    }),
  ]);
});

interface HttpRequest {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}

interface HttpResponse {
  statusCode: number;
  json(): { code: number; data: { auth_url: string; state: string } };
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: HttpRequest): Promise<HttpResponse>;
}

const API = new URL('../../../../apps/api/', import.meta.url);
const requireApi = createRequire(new URL('package.json', API));

it('[AC-B1-04zzzzm#7] prod 的 Nest 路由签发真实淘宝授权地址', async () => {
  // 走 LinkingModule 自带的解析器装配。假数据源只提供启动配置、设备和有效联盟账号。
  const linkingUrl = new URL('src/modules/linking/linking.module.ts', API).href;
  const { LinkingModule } = (await import(linkingUrl)) as {
    LinkingModule: {
      forRoot(
        configReader: () => LinkingConfigReader,
        ports: { callerContext: { useFactory: () => CallerContext } },
      ): object;
    };
  };
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
    ...environment('prod'),
    KMS_REGION_ID: 'synthetic-region',
    KMS_ENDPOINT: 'kms.synthetic.aliyuncs.com',
    KMS_KEY_ID: 'synthetic-key',
    KMS_RAM_ROLE: 'synthetic-role',
    TAOBAO_APP_KEY: APP_KEY,
    TAOBAO_USER_OAUTH_REDIRECT_URI: USER_REDIRECT,
    TAOBAO_INVITER_CODE: INVITER_CODE,
    TAOBAO_INVITER_ACCOUNT_ID: INVITER_ACCOUNT,
  });
  const { db, queries } = await scriptedDb(({ sql }) => {
    if (sql.includes('from "devices"')) return { rows: [DEVICE] };
    if (sql.includes('from "union_accounts"')) {
      return { rows: [{ id: INVITER_ACCOUNT, auth_status: 'active', auth_expires_at: null }] };
    }
    if (/^insert into "union_auth_sessions"/i.test(sql)) return { rows: [], numAffectedRows: 1n };
    return { rows: [] };
  });
  const providers = [
    { provide: APP_CONFIG, useValue: config },
    { provide: DB_TOKEN, useValue: db },
    { provide: CLOCK, useValue: new FixedClock(NOW) },
    {
      provide: ROOT_LOGGER,
      useValue: createRootLogger({ entry: 'api', appEnv: 'prod', level: 'silent' }),
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

    const reply = await app.inject({
      method: 'GET',
      url: '/v1/unions/taobao/auth-url',
      headers: {
        'x-app-id': CALLER.appId,
        'x-device-id': CALLER.deviceId,
        'x-platform': 'ios',
        'x-app-version': '1.0.0',
        'x-trace-id': TRACE,
      },
    });
    const body = reply.json();
    expect(reply.statusCode, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      code: 0,
      data: { auth_url: expect.any(String), state: expect.any(String) },
    });
    const { auth_url, state } = body.data;
    expect(state).not.toBe('');
    expect(URL.canParse(auth_url)).toBe(true);
    const url = new URL(auth_url);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: APP_KEY,
      redirect_uri: USER_REDIRECT,
      state,
      view: 'wap',
    });
    const issuedSessions = queries.filter(({ sql }) =>
      /^insert into "union_auth_sessions"/i.test(sql),
    );
    expect(issuedSessions).toEqual([
      expect.objectContaining({
        parameters: expect.arrayContaining([state, CALLER.appId, CALLER.userId, CALLER.deviceId]),
      }),
    ]);
  } finally {
    await app?.close();
    await db.destroy();
  }
});
