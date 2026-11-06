// F1-02zzze: isolated content HTTP assembly for GET /v1/config. Real module, controller and
// service over an in-memory ContentStore that records every config_items key it is asked for;
// DummyDriver performs no I/O. No imports from other rule-test kits.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DB as Database } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { ContentPublicPorts } from '../../../../apps/api/src/modules/content/index.ts';
import {
  CachedContentReader,
  type ContentStore,
} from '../../../../apps/api/src/modules/content/application/content-reader.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  ROOT_LOGGER,
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export type Config = Schema<'Config'>;
export type Json = Database['config_items']['value'];
export type Values = Record<string, Json>;

const REQUIRED: Values = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable',
  kf: { url: 'https://kf.example.test/' },
  'legal.privacy.version': 1,
  'legal.privacy.min_version': 1,
  'legal.agreement.version': 1,
};
const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  useGlobalFilters(...filters: unknown[]): void;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

let nextApp = 0;

export async function harness() {
  apiRequire('reflect-metadata');
  const { ContentPublicModule } = (await import(
    new URL('apps/api/src/modules/content/index.ts', ROOT).href
  )) as { ContentPublicModule: { forApi(ports: ContentPublicPorts): unknown } };
  const { Module, Scope } = apiRequire('@nestjs/common') as {
    Module(metadata: object): (target: object) => void;
    Scope: { REQUEST: number };
  };
  const { NestFactory, REQUEST } = apiRequire('@nestjs/core') as {
    NestFactory: { create(module: unknown, adapter: unknown, options: object): Promise<HttpApp> };
    REQUEST: string;
  };
  const { PlatformFastifyAdapter, GlobalErrorFilter } = (await import(
    new URL('apps/api/src/modules/platform/http/global-errors.ts', ROOT).href
  )) as {
    PlatformFastifyAdapter: new (options: object) => {
      getInstance(): { setValidatorCompiler(compiler: unknown): void };
    };
    GlobalErrorFilter: new (adapter: unknown, logger: unknown) => unknown;
  };
  const clock = new FixedClock('2026-11-06T00:00:00Z');
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const source = new Map<string, Values>();
  const reads: { appId: string; key: string }[] = [];
  const store: ContentStore = {
    minSupportedVersionsByChannel: async () => new Map(),
    configItem: async (appId, key) => {
      reads.push({ appId, key });
      const values = source.get(appId);
      if (values === undefined || !Object.hasOwn(values, key)) return null;
      return { value: values[key]!, version: 1 };
    },
  };
  const reader = new CachedContentReader(store, clock);
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  class FixturePlatform {}
  Module({})(FixturePlatform);
  const globals = {
    module: FixturePlatform,
    global: true,
    providers: [
      { provide: DB, useValue: db },
      { provide: CLOCK, useValue: clock },
      { provide: ROOT_LOGGER, useValue: logger },
      { provide: APP_CONFIG, useValue: loadConfig({ APP_ENV: 'test' }) },
    ],
    exports: [DB, CLOCK, ROOT_LOGGER, APP_CONFIG],
  };
  const ports: ContentPublicPorts = {
    contentReader: { useFactory: () => reader },
    viewerContext: {
      scope: Scope.REQUEST,
      inject: [REQUEST],
      useFactory: (request: { headers: Record<string, string> }) => ({
        current: async () => ({ appId: request.headers['x-app-id']!, userId: null }),
      }),
    },
  };
  class FixtureRoot {}
  Module({ imports: [globals, ContentPublicModule.forApi(ports)] })(FixtureRoot);
  const adapter = new PlatformFastifyAdapter({ loggerInstance: logger });
  adapter.getInstance().setValidatorCompiler(createValidatorCompiler());
  let app: HttpApp | undefined;
  try {
    app = await NestFactory.create(FixtureRoot, adapter, { logger: false, abortOnError: false });
    app.useGlobalFilters(new GlobalErrorFilter(adapter, logger));
    await app.init();
    const started = app;
    return {
      app: started,
      clock,
      lines,
      reads,
      /** A fresh app id whose config_items are the required rows plus `values`. */
      configured(values: Values = {}) {
        const id = `f102zzze_${++nextApp}`;
        source.set(id, { ...REQUIRED, ...values });
        return id;
      },
      update(id: string, values: Values) {
        source.set(id, { ...source.get(id), ...values });
      },
      async close() {
        try {
          await started.close();
        } finally {
          await db.destroy();
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await db.destroy();
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

export function read(h: Harness, id: string, extra: Record<string, string> = {}) {
  return h.app.inject({
    method: 'GET',
    url: '/v1/config',
    headers: {
      'x-app-id': id,
      'x-platform': 'ios',
      'x-app-version': '2.0.0',
      ...extra,
    },
  });
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let responseValidator: Promise<Validator> | undefined;
function validator() {
  responseValidator ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    return createValidatorCompiler()({
      schema: doc.paths['/v1/config']!.get.responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    });
  })();
  return responseValidator;
}

/** 200, code 0, the whole body valid against the contract, ETag = config_version. */
export async function success(h: Harness, id: string, extra: Record<string, string> = {}) {
  const response = await read(h, id, extra);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { features: expect.any(Object) } });
  const check = await validator();
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  const data = response.json<{ data: Config }>().data;
  expect(response.headers['etag']).toBe(`"${data.config_version}"`);
  return { response, data };
}

/** The config_items keys the store was asked for on behalf of one app, in order. */
export function readsOf(h: Harness, appId: string): string[] {
  return h.reads.filter((entry) => entry.appId === appId).map((entry) => entry.key);
}
