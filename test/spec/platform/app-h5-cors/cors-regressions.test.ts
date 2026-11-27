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
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';

const PRIMARY = 'cors_primary';
const SECONDARY = 'cors_secondary';
const PRIMARY_HOME = 'https://home.primary.example.test';
const PRIMARY_OLD = 'https://webview.primary.example.test:8443';
const PRIMARY_NEW = 'https://new.primary.example.test';
const SECONDARY_HOME = 'https://home.secondary.example.test:9443';
const SECONDARY_OLD = 'https://webview.secondary.example.test';
const UNREGISTERED = 'https://unregistered.example.test';
const PUBLIC_CONFIG = '/v1/config';
const ALLOW_ORIGIN = 'access-control-allow-origin';
const TRACE = '019a0000-0000-7000-8000-000000000021';

interface ConfigItem {
  readonly value: DB['config_items']['value'];
  readonly version: number;
}

type ConfigRows = ReadonlyMap<string, ReadonlyMap<string, ConfigItem>>;

function configItems(h5BaseUrl: string, origins: string[]): Map<string, ConfigItem> {
  const values = {
    h5_base_url: h5BaseUrl,
    bridge_origins: { origins },
    'h5_release.stable': 'stable',
    kf: { url: 'https://support.example.test/' },
    'legal.privacy.version': 1,
    'legal.privacy.min_version': 1,
    'legal.agreement.version': 1,
  };
  return new Map(Object.entries(values).map(([key, value]) => [key, { value, version: 1 }]));
}

function fixture() {
  const primaryUrl = `${PRIMARY_HOME}/releases/stable/`;
  const secondaryUrl = `${SECONDARY_HOME}/app/index.html?release=2`;
  const primary = configItems(primaryUrl, [PRIMARY_HOME, PRIMARY_OLD]);
  const secondary = configItems(secondaryUrl, [SECONDARY_HOME, SECONDARY_OLD]);
  const apps = new Map<string, Map<string, ConfigItem>>();
  apps.set(PRIMARY, primary);
  apps.set(SECONDARY, secondary);
  return { apps, primary, secondary };
}

async function fixtureHandles(apps: ConfigRows): Promise<DbHandles> {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    if (!/\bselect\b/i.test(query.sql) || !/\bconfig_items\b/i.test(query.sql)) {
      return { rows: [] };
    }
    const parameters = query.parameters.flat();
    const appIds = [...apps.keys()].filter((id) => parameters.includes(id));
    const keys = parameters
      .filter((parameter) => typeof parameter === 'string')
      .filter((parameter) => !apps.has(parameter));
    const [key] = keys;
    // The cross-App lookup also returns Apps that have no row for the requested key.
    if (key !== undefined && keys.length === 1 && /\bhas_key\b/i.test(query.sql)) {
      const rows = [...apps].map(([app_id, items]) => {
        const item = items.get(key);
        return { app_id, value: item?.value ?? null, has_key: item !== undefined };
      });
      return { rows: rows as R[] };
    }
    // Read the current fixture on every query so writes are visible to the running app.
    const rows = [...apps]
      .filter(([appId]) => appIds.length === 0 || appIds.includes(appId))
      .flatMap(([app_id, items]) =>
        [...items]
          .filter(([itemKey]) => keys.length === 0 || keys.includes(itemKey))
          .map(([key, item]) => ({ app_id, key, ...item })),
      );
    return { rows: rows as R[] };
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

interface InjectionResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  json(): unknown;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(options: {
    method: 'GET' | 'OPTIONS';
    url: string;
    headers: Record<string, string>;
  }): Promise<InjectionResponse>;
}

async function startApi(apps: ConfigRows): Promise<HttpApp> {
  // Keep Nest's decorators outside the test project's TypeScript boundary.
  const { createHttpApp } = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as { createHttpApp(entry: 'api', overrides: object): Promise<HttpApp> };
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-11-27T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    dbHandles: await fixtureHandles(apps),
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

const H5_HEADERS = {
  'x-app-id': PRIMARY,
  'x-platform': 'h5',
  'x-app-version': '2.0.0',
  'x-build': '42',
  'x-trace-id': TRACE,
};

function get(app: HttpApp, url: string, origin?: string): Promise<InjectionResponse> {
  return app.inject({
    method: 'GET',
    url,
    headers: { ...H5_HEADERS, ...(origin === undefined ? {} : { origin }) },
  });
}

function preflight(app: HttpApp, origin: string): Promise<InjectionResponse> {
  return app.inject({
    method: 'OPTIONS',
    url: PUBLIC_CONFIG,
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': Object.keys(H5_HEADERS).join(', '),
    },
  });
}

it('[AC-B1-01zzz#7] 可信 H5 可读取请求校验错误', async () => {
  const app = await startApi(fixture().apps);
  try {
    const withoutOrigin = await get(app, '/v1/me');
    const trusted = await get(app, '/v1/me', PRIMARY_OLD);
    const untrusted = await get(app, '/v1/me', UNREGISTERED);
    const error = { code: 10001, msg: '未登录', trace_id: TRACE };

    for (const response of [withoutOrigin, trusted, untrusted]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(error);
    }
    expect.soft(trusted.headers[ALLOW_ORIGIN]).toBe(PRIMARY_OLD);
    const vary = String(trusted.headers.vary ?? '');
    expect.soft(vary.toLowerCase().split(/\s*,\s*/)).toContain('origin');
    expect.soft(untrusted.headers[ALLOW_ORIGIN]).toBeUndefined();
  } finally {
    await app.close();
  }
});

it('[AC-B1-01zzz#8] 同一实例的预检与实请求立即使用新配置', async () => {
  const { apps, primary, secondary } = fixture();
  const app = await startApi(apps);
  const probes = [
    { origin: PRIMARY_NEW, before: false, after: true },
    { origin: PRIMARY_OLD, before: true, after: false },
    { origin: SECONDARY_OLD, before: true, after: false },
    { origin: SECONDARY_HOME, before: true, after: true },
  ];

  async function sample() {
    const responses = [];
    for (const probe of probes) {
      const options = await preflight(app, probe.origin);
      const actual = await get(app, PUBLIC_CONFIG, probe.origin);
      responses.push({ ...probe, options, actual });
    }
    return responses;
  }

  try {
    const before = await sample();
    primary.set('bridge_origins', { value: { origins: [PRIMARY_HOME, PRIMARY_NEW] }, version: 2 });
    secondary.delete('bridge_origins');
    const after = await sample();

    const samples = { before, after };
    for (const phase of ['before', 'after'] as const) {
      for (const response of samples[phase]) {
        const { origin, options, actual } = response;
        const expectedOrigin = response[phase] ? origin : undefined;
        const preflightStatuses = response[phase] ? [200, 204] : [404];
        const label = `${phase} ${origin}`;
        expect.soft(preflightStatuses, label).toContain(options.statusCode);
        expect.soft(options.headers[ALLOW_ORIGIN], label).toBe(expectedOrigin);
        expect.soft(actual.statusCode, label).toBe(200);
        expect.soft(actual.headers[ALLOW_ORIGIN], label).toBe(expectedOrigin);
      }
    }
  } finally {
    await app.close();
  }
});
