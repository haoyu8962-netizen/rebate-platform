// B1-01zzt content 公共模块的隔离装配（claude-independent，SPEC_REF deaba4fb）：真的 ContentPublicModule、控制器
// 与服务，APP_CONFIG 用测试给的 AppConfig；config_items 读内存，数据库句柄是 DummyDriver（不连库、不 listen，
// bridge_origins 行读到空 → 默认白名单）。写法照 test/spec/content/config-derived-flags/derived-flags-kit.ts，
// 不从别的规则测试目录导入。
import { verify, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DB as Database } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect } from 'vitest';
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
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { settled, type Settled } from './kit.ts';

type Json = Database['config_items']['value'];

const APP_ID = 'b101zzt_1';
const REQUIRED: Readonly<Record<string, Json>> = {
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
  body: string;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  useGlobalFilters(...filters: unknown[]): void;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

export interface ContentApp {
  /** 进程日志（pino 行）。 */
  readonly lines: readonly string[];
  /** GET /v1/config（已配置好必需行的 app id）。 */
  readConfig(): Promise<Response>;
  close(): Promise<void>;
}

/**
 * 用 config 组一个只有 content 公共模块的应用并 init。init 拒绝（签名钥加载失败）时 outcome 不 ok，
 * 应用已关闭；日志行在 lines 里照样能查。
 */
export async function startContent(
  config: AppConfig,
  lines: string[] = [],
): Promise<Settled<ContentApp>> {
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
  const clock = new FixedClock('2026-11-09T00:00:00Z');
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: config.appEnv },
    { write: (line: string) => void lines.push(line) },
  );
  const store: ContentStore = {
    minSupportedVersionsByChannel: async () => new Map(),
    configItem: async (appId, key) => {
      if (appId !== APP_ID || !Object.hasOwn(REQUIRED, key)) return null;
      return { value: REQUIRED[key] as Json, version: 1 };
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
      { provide: APP_CONFIG, useValue: config },
    ],
    exports: [DB, CLOCK, ROOT_LOGGER, APP_CONFIG],
  };
  const ports: ContentPublicPorts = {
    contentReader: { useFactory: () => reader },
    viewerContext: {
      scope: Scope.REQUEST,
      inject: [REQUEST],
      useFactory: (request: { headers: Record<string, string> }) => ({
        current: async () => ({ appId: request.headers['x-app-id'] ?? '', userId: null }),
      }),
    },
  };
  class FixtureRoot {}
  Module({ imports: [globals, ContentPublicModule.forApi(ports)] })(FixtureRoot);
  const adapter = new PlatformFastifyAdapter({ loggerInstance: logger });
  adapter.getInstance().setValidatorCompiler(createValidatorCompiler());
  let app: HttpApp | undefined;
  const outcome = await settled(async () => {
    app = await NestFactory.create(FixtureRoot, adapter, { logger: false, abortOnError: false });
    app.useGlobalFilters(new GlobalErrorFilter(adapter, logger));
    await app.init();
    return app;
  });
  const close = async (): Promise<void> => {
    try {
      await app?.close();
    } finally {
      await db.destroy();
    }
  };
  if (!outcome.ok) {
    await settled(close);
    return outcome;
  }
  const started = outcome.value;
  return {
    ok: true,
    value: {
      lines,
      readConfig: () =>
        started.inject({
          method: 'GET',
          url: '/v1/config',
          headers: { 'x-app-id': APP_ID, 'x-platform': 'ios', 'x-app-version': '2.0.0' },
        }),
      close,
    },
  };
}

interface Payload {
  readonly v: number;
  readonly app_id: string;
  readonly env: string;
  readonly version: number;
  readonly origins: readonly string[];
}

/** 独立验签（不复用产品的签名 / 解码代码）：ES256、头部 kid、用给定公钥验过。 */
export function verifiedBridgeOrigins(value: unknown, publicKey: KeyObject, kid: string): Payload {
  expect(value).toEqual({ jws: expect.any(String) });
  const { jws } = value as { jws: string };
  expect(jws).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [header, payload, signature] = jws.split('.') as [string, string, string];
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toStrictEqual({
    alg: 'ES256',
    kid,
    typ: 'couli-bridge-origins+jws',
  });
  const bytes = Buffer.from(signature, 'base64url');
  expect(bytes).toHaveLength(64);
  expect(
    verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      bytes,
    ),
  ).toBe(true);
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Payload;
}
