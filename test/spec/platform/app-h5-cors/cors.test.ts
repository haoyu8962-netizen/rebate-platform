import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';

const PRIMARY = 'cors_primary';
const SECONDARY = 'cors_secondary';
const PRIMARY_HOME = 'https://home.primary.example.test';
const BRIDGE_ORIGIN = 'https://webview.primary.example.test:8443';
const FALLBACK_ORIGIN = 'https://home.secondary.example.test:9443';
const PRIMARY_H5_URL = `${PRIMARY_HOME}/releases/stable/`;
const FALLBACK_H5_URL = `${FALLBACK_ORIGIN}/app/index.html?release=2`;
const CONSOLE_ORIGIN = 'https://console.example.test';
const UNREGISTERED = 'https://unregistered.example.test';
const PUBLIC_CONFIG = '/v1/config';
const ADMIN_LOGIN = '/admin/v1/auth/login';
const ALLOW_ORIGIN = 'access-control-allow-origin';
const ALLOW_CREDENTIALS = 'access-control-allow-credentials';

const CONFIG_REQUIRED = {
  'h5_release.stable': 'stable',
  kf: { url: 'https://support.example.test/' },
  'legal.privacy.version': 1,
  'legal.privacy.min_version': 1,
  'legal.agreement.version': 1,
};

const CONFIG_ROWS = new Map<string, Readonly<Record<string, DB['config_items']['value']>>>([
  [
    PRIMARY,
    {
      ...CONFIG_REQUIRED,
      h5_base_url: PRIMARY_H5_URL,
      bridge_origins: { origins: [PRIMARY_HOME, BRIDGE_ORIGIN] },
    },
  ],
  [SECONDARY, { ...CONFIG_REQUIRED, h5_base_url: FALLBACK_H5_URL }],
]);

async function fixtureHandles(): Promise<DbHandles> {
  const rows = [...CONFIG_ROWS].flatMap(([app_id, config]) =>
    Object.entries(config).map(([key, value]) => ({ app_id, key, value, version: 1 })),
  );
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    if (!/\bselect\b/i.test(query.sql) || !/\bconfig_items\b/i.test(query.sql)) {
      return { rows: [] };
    }
    const appIds = [...CONFIG_ROWS.keys()].filter((id) => query.parameters.includes(id));
    const keys = query.parameters
      .flat()
      .filter((parameter) => typeof parameter === 'string')
      .filter((parameter) => !appIds.includes(parameter));
    const [key] = keys;
    // Content's cross-App read of one key uses a left join to preserve Apps missing that key.
    if (key !== undefined && keys.length === 1 && /\bhas_key\b/i.test(query.sql)) {
      return {
        rows: [...CONFIG_ROWS].map(([app_id, config]) => {
          const value = config[key];
          return { app_id, value: value ?? null, has_key: value !== undefined };
        }) as R[],
      };
    }
    return {
      rows: rows.filter(
        ({ app_id, key }) =>
          (appIds.length === 0 || appIds.includes(app_id)) &&
          (keys.length === 0 || keys.includes(key)),
      ) as R[],
    };
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  return { db, dbRead: null, close: () => db.destroy() };
}

interface Response {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  json(): unknown;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(options: {
    method: 'GET' | 'OPTIONS' | 'POST';
    url: string;
    headers: Record<string, string>;
    remoteAddress?: string;
    payload?: string;
  }): Promise<Response>;
}

async function start(entry: 'api' | 'admin'): Promise<HttpApp> {
  // Dynamic import keeps Nest's decorators outside the test project's TypeScript boundary.
  const { createHttpApp } = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as { createHttpApp(entry: 'api' | 'admin', overrides: object): Promise<HttpApp> };
  const app = await createHttpApp(entry, {
    config: loadConfig({
      APP_ENV: 'test',
      ADMIN_CORS_ORIGIN: CONSOLE_ORIGIN,
      ADMIN_IP_ALLOWLIST: '127.0.0.1,192.0.2.0/24',
    }),
    clock: new FixedClock('2026-11-27T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
    dbHandles: await fixtureHandles(),
    startQueue: false,
  });
  try {
    await app.init();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

let api: HttpApp;
beforeAll(async () => {
  api = await start('api');
});
afterAll(async () => {
  await api?.close();
});

const H5_HEADERS = ['x-app-id', 'x-platform', 'x-app-version', 'x-build', 'x-trace-id'];
const TRACE = '019a0000-0000-7000-8000-000000000021';

function originHeader(origin?: string): Record<string, string> {
  return origin === undefined ? {} : { origin };
}

function preflight(
  app: HttpApp,
  url: string,
  method: string,
  origin?: string,
  requested: readonly string[] = H5_HEADERS,
  remoteAddress = '127.0.0.1',
): Promise<Response> {
  return app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      ...originHeader(origin),
      'access-control-request-method': method,
      'access-control-request-headers': requested.join(', '),
    },
    remoteAddress,
  });
}

function getConfig(origin?: string): Promise<Response> {
  return api.inject({
    method: 'GET',
    url: PUBLIC_CONFIG,
    headers: {
      ...originHeader(origin),
      'x-app-id': PRIMARY,
      'x-platform': 'h5',
      'x-app-version': '2.0.0',
      'x-build': '42',
      'x-trace-id': TRACE,
    },
  });
}

function headerTokens(response: Response, header: string): string[] {
  return String(response.headers[header] ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase());
}

it('[AC-B1-01zzz#1] 可信来源获跨域许可，预检允许契约方法和头', async () => {
  const routes = [
    ['GET', PUBLIC_CONFIG, ['authorization', 'if-none-match']],
    ['POST', '/v1/withdrawals', ['authorization', 'content-type', 'idempotency-key']],
    ['PATCH', '/v1/me', ['authorization', 'content-type']],
    ['PUT', '/v1/me/notification-settings', ['authorization', 'content-type']],
    ['DELETE', '/v1/me/tips/jump_tip', ['authorization']],
  ] as const;
  for (const [method, url, extraHeaders] of routes) {
    const requested = [...H5_HEADERS, ...extraHeaders];
    const response = await preflight(api, url, method, BRIDGE_ORIGIN, requested);
    expect.soft([200, 204], `${method} ${url}`).toContain(response.statusCode);
    expect.soft(response.headers[ALLOW_ORIGIN], `${method} ${url}`).toBe(BRIDGE_ORIGIN);
    expect.soft(headerTokens(response, 'vary')).toContain('origin');
    expect
      .soft(headerTokens(response, 'access-control-allow-methods'))
      .toContain(method.toLowerCase());
    expect
      .soft(headerTokens(response, 'access-control-allow-headers'))
      .toEqual(expect.arrayContaining(requested));
  }
  const actual = await getConfig(BRIDGE_ORIGIN);
  expect(actual.statusCode).toBe(200);
  expect(actual.headers[ALLOW_ORIGIN]).toBe(BRIDGE_ORIGIN);
  expect(headerTokens(actual, 'vary')).toContain('origin');

  const unknownHeader = 'x-unlisted-cors-header';
  const unlisted = await preflight(api, PUBLIC_CONFIG, 'GET', BRIDGE_ORIGIN, [
    ...H5_HEADERS,
    unknownHeader,
  ]);
  expect(headerTokens(unlisted, 'access-control-allow-headers')).not.toContain(unknownHeader);
  expect(headerTokens(unlisted, 'access-control-allow-headers')).not.toContain('*');

  const health = await api.inject({
    method: 'GET',
    url: '/healthz',
    headers: { origin: BRIDGE_ORIGIN },
  });
  expect(health.statusCode).toBe(200);
  expect(health.headers[ALLOW_ORIGIN]).toBeUndefined();
});

it('[AC-B1-01zzz#2] 未登记或缺失来源时实请求照常处理', async () => {
  const withoutOrigin = await getConfig();
  expect(withoutOrigin.statusCode).toBe(200);
  expect(withoutOrigin.headers[ALLOW_ORIGIN]).toBeUndefined();
  const refused = await getConfig(UNREGISTERED);
  expect(refused.statusCode).toBe(withoutOrigin.statusCode);
  expect(refused.json()).toMatchObject({
    code: 0,
    data: { h5_base_url: PRIMARY_H5_URL },
    trace_id: TRACE,
  });
  expect(refused.headers[ALLOW_ORIGIN]).toBeUndefined();

  for (const origin of [undefined, UNREGISTERED]) {
    const response = await preflight(api, PUBLIC_CONFIG, 'GET', origin);
    expect(response.statusCode).toBe(404);
    expect(response.headers[ALLOW_ORIGIN]).toBeUndefined();
  }
  expect((await preflight(api, PUBLIC_CONFIG, 'GET', BRIDGE_ORIGIN)).headers[ALLOW_ORIGIN]).toBe(
    BRIDGE_ORIGIN,
  );
});

it('[AC-B1-01zzz#3] 合并各 App 的登记来源及缺省 H5 来源', async () => {
  for (const origin of [PRIMARY_HOME, BRIDGE_ORIGIN, FALLBACK_ORIGIN]) {
    const response = await preflight(api, PUBLIC_CONFIG, 'GET', origin);
    expect.soft(response.headers[ALLOW_ORIGIN], origin).toBe(origin);
    const actual = await getConfig(origin);
    expect.soft(actual.statusCode, origin).toBe(200);
    expect.soft(actual.headers[ALLOW_ORIGIN], origin).toBe(origin);
  }
  for (const origin of [FALLBACK_H5_URL, UNREGISTERED]) {
    const response = await preflight(api, PUBLIC_CONFIG, 'GET', origin);
    expect(response.headers[ALLOW_ORIGIN], origin).toBeUndefined();
  }
});

it('[AC-B1-01zzz#4] 协议、主机与端口逐项精确匹配', async () => {
  for (const origin of [
    'http://webview.primary.example.test:8443',
    'https://sub.webview.primary.example.test:8443',
    'https://webview.primary.example.test.evil.invalid:8443',
    'https://webview.primary.example.test:9443',
    'https://webview.primary.example.test',
    'null',
  ]) {
    const response = await preflight(api, PUBLIC_CONFIG, 'GET', origin);
    expect(response.headers[ALLOW_ORIGIN], origin).toBeUndefined();
    expect((await getConfig(origin)).headers[ALLOW_ORIGIN], origin).toBeUndefined();
  }
  expect((await getConfig(BRIDGE_ORIGIN)).headers[ALLOW_ORIGIN]).toBe(BRIDGE_ORIGIN);
});

it('[AC-B1-01zzz#5] 有跨域许可的预检与实请求均不回 Allow-Credentials', async () => {
  for (const response of [
    await preflight(api, PUBLIC_CONFIG, 'GET', BRIDGE_ORIGIN),
    await getConfig(BRIDGE_ORIGIN),
  ]) {
    expect.soft(response.headers[ALLOW_ORIGIN]).toBe(BRIDGE_ORIGIN);
    expect.soft(response.headers[ALLOW_CREDENTIALS]).toBeUndefined();
  }
});

it('[AC-B1-01zzz#6] 后台保持原有跨域规则', async () => {
  const admin = await start('admin');
  try {
    const requested = ['authorization', 'content-type'];
    const allowed = await preflight(admin, ADMIN_LOGIN, 'POST', CONSOLE_ORIGIN, requested);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers).toMatchObject({
      [ALLOW_ORIGIN]: CONSOLE_ORIGIN,
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
      'access-control-allow-headers': 'Authorization, Content-Type, X-Trace-Id, X-Step-Up-Token',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    expect(allowed.headers[ALLOW_CREDENTIALS]).toBeUndefined();
    const origins = [CONSOLE_ORIGIN, BRIDGE_ORIGIN, `${CONSOLE_ORIGIN}.evil.invalid`, 'null'];
    for (const origin of origins) {
      const actual = await admin.inject({
        method: 'POST',
        url: ADMIN_LOGIN,
        headers: { origin, 'content-type': 'application/json' },
        payload: '{}',
        remoteAddress: '127.0.0.1',
      });
      expect(actual.statusCode).toBe(400);
      expect(actual.headers.vary).toBe('Origin');
      expect(actual.headers[ALLOW_CREDENTIALS]).toBeUndefined();
      if (origin === CONSOLE_ORIGIN) {
        expect(actual.headers[ALLOW_ORIGIN]).toBe(CONSOLE_ORIGIN);
        expect(actual.headers['access-control-expose-headers']).toBe('X-Trace-Id');
      } else {
        expect(actual.headers[ALLOW_ORIGIN]).toBeUndefined();
        const denied = await preflight(admin, ADMIN_LOGIN, 'POST', origin, requested);
        expect(denied.statusCode).toBe(404);
        expect(denied.headers[ALLOW_ORIGIN]).toBeUndefined();
      }
    }
    const outside = await preflight(
      admin,
      ADMIN_LOGIN,
      'POST',
      CONSOLE_ORIGIN,
      requested,
      '198.51.100.3',
    );
    expect(outside.headers[ALLOW_ORIGIN]).toBeUndefined();
    expect((await getConfig(CONSOLE_ORIGIN)).headers[ALLOW_ORIGIN]).toBeUndefined();
    expect((await getConfig(BRIDGE_ORIGIN)).headers[ALLOW_ORIGIN]).toBe(BRIDGE_ORIGIN);
  } finally {
    await admin.close();
  }
});
