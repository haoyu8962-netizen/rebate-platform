// B1-28s contract and mounting rule test (claude-independent, SPEC_REF 18f0015e): CT-26x's
// adminListProductFeedbacks is implemented — contracts/openapi.yaml and the generated planned list
// no longer mark it planned, its request schema is generated for the route, x-auth admin and the
// error codes stay as CT-26x fixed them — and the admin entry serves GET /admin/v1/product-feedbacks
// exactly once with the contract's query schema; the api entry does not serve it (feedback's public
// route stays on api only). No database (unit test, no listen); this file does not import the
// database kit.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const PATH = '/admin/v1/product-feedbacks';
const OPERATION_ID = 'adminListProductFeedbacks';
const NOW = '2026-11-07T02:00:00.000Z';

interface Operation {
  readonly operationId?: string;
  readonly 'x-implementation'?: string;
  readonly 'x-auth'?: string;
  readonly 'x-idempotent'?: boolean;
  readonly 'x-error-codes'?: readonly number[];
}

async function contractPaths(): Promise<Record<string, Record<string, Operation>>> {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, Operation>> }>;
  };
  const document = await parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    { resolve: { external: false } },
  );
  return document.paths;
}

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; querystring?: unknown };
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): {
    getInstance(): {
      addHook(name: 'onRoute', hook: (route: RouteOptions) => void): unknown;
      hasRoute(options: { method: 'GET'; url: string }): boolean;
    };
  };
}

async function boot(entry: 'admin' | 'api') {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  const app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock(NOW),
    logger: memoryLogger().logger,
  });
  const seen: RouteOptions[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if ([route.method].flat().includes('GET') && route.url === PATH) seen.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B1-28s#1] adminListProductFeedbacks 去掉 x-implementation: planned（生成的 planned 清单同步、生成请求 schema），x-auth admin、不幂等、x-error-codes [10001, 10403, 20001] 不变；admin 入口恰好挂一次 GET /admin/v1/product-feedbacks 并带契约的 query schema，api 入口不挂', async () => {
  const paths = await contractPaths();
  const op = paths[PATH]?.['get'];
  expect(op?.operationId, PATH).toBe(OPERATION_ID);
  expect(op, OPERATION_ID).not.toHaveProperty('x-implementation');
  expect(plannedOperations.has(OPERATION_ID), OPERATION_ID).toBe(false);
  expect(CONTRACT_ROUTE_SCHEMAS, OPERATION_ID).toHaveProperty(OPERATION_ID);
  expect(op?.['x-auth'], OPERATION_ID).toBe('admin');
  expect(op?.['x-idempotent'] === true, OPERATION_ID).toBe(false);
  const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
  expect(codes, OPERATION_ID).toEqual([10001, 10403, 20001]);

  const admin = await boot('admin');
  try {
    expect(admin.seen, `admin 入口必须恰好挂一次 GET ${PATH}`).toHaveLength(1);
    const expected = routeSchemaOf(paths[PATH]!['get'] as never);
    expect(expected.querystring, PATH).toBeDefined();
    expect(admin.seen[0]!.schema?.querystring, PATH).toEqual(expected.querystring);
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    expect(api.seen, PATH).toEqual([]);
    const server = api.app.getHttpAdapter().getInstance();
    expect(server.hasRoute({ method: 'GET', url: PATH }), PATH).toBe(false);
  } finally {
    await api.app.close();
  }
}, 60_000);
