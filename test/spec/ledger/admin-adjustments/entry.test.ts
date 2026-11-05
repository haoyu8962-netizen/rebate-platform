// B2-12c §9 entry (claude-independent, SPEC_REF ea202ff6): adminListAdjustments,
// adminGetAdjustment and adminCreateAdjustment are served by the admin entry only, once each, with
// the schema generated from their contract operations, behind the admin login check; the contract
// no longer marks them planned (error codes as CT-24zg / CT-26n wrote them) and the generated files
// follow. Unit test: no database, no listen; the skeleton is not imported.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createValidatorCompiler,
  routeSchemaOf,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { NOW, apiRequire, type Response } from '../../admin/auth/kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const SOME_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fa001';

interface Spec {
  readonly id: string;
  readonly path: string;
  readonly method: 'get' | 'post';
  readonly http: 'GET' | 'POST';
  /** The Fastify route URL. */
  readonly route: string;
  /** A concrete URL of the route. */
  readonly url: string;
  readonly errors: readonly number[];
}

const OPERATIONS: readonly Spec[] = [
  {
    id: 'adminListAdjustments',
    path: '/admin/v1/adjustments',
    method: 'get',
    http: 'GET',
    route: '/admin/v1/adjustments',
    url: '/admin/v1/adjustments',
    errors: [10001, 10403, 20001],
  },
  {
    id: 'adminCreateAdjustment',
    path: '/admin/v1/adjustments',
    method: 'post',
    http: 'POST',
    route: '/admin/v1/adjustments',
    url: '/admin/v1/adjustments',
    errors: [10001, 10003, 10403, 20001, 20901, 20902, 40901],
  },
  {
    id: 'adminGetAdjustment',
    path: '/admin/v1/adjustments/{adjust_id}',
    method: 'get',
    http: 'GET',
    route: '/admin/v1/adjustments/:adjust_id',
    url: `/admin/v1/adjustments/${SOME_ID}`,
    errors: [10001, 10403, 20001],
  },
];

interface Operation {
  operationId: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, Partial<Record<'get' | 'post', Operation>>>;
}

let document: Promise<Document> | undefined;
function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  return document;
}

async function operation(spec: Spec): Promise<Operation> {
  const op = (await contract()).paths[spec.path]?.[spec.method];
  expect(op, `${spec.method} ${spec.path} must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe(spec.id);
  return op!;
}

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: unknown;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): {
    getInstance(): {
      addHook(name: 'onRoute', hook: (route: RouteOptions) => void): unknown;
      hasRoute(options: { method: 'GET' | 'POST'; url: string }): boolean;
    };
  };
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

async function boot(entry: 'admin' | 'api' | 'stream') {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  const app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock(NOW),
    logger: memoryLogger().logger,
  });
  const seen: { route: string; http: string; schema: unknown }[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      // Fastify may add a HEAD route for each GET (exposeHeadRoutes): count GET and POST only.
      for (const method of [route.method].flat()) {
        if (method === 'GET' || method === 'POST') {
          seen.push({ route: route.url, http: method, schema: route.schema });
        }
      }
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-12c#1] admin 入口各挂一次调账列表、详情与提交路由并带契约 schema；api / stream 入口都不挂', async () => {
  const admin = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      const mounted = admin.seen.filter((r) => r.route === spec.route && r.http === spec.http);
      expect(mounted, `${spec.http} ${spec.route} 必须恰好挂一次`).toHaveLength(1);
      expect(mounted[0]!.schema, spec.id).toEqual(routeSchemaOf((await operation(spec)) as never));
    }
  } finally {
    await admin.app.close();
  }
  for (const entry of ['api', 'stream'] as const) {
    const other = await boot(entry);
    try {
      for (const spec of OPERATIONS) {
        expect(
          other.seen.filter((r) => r.route === spec.route && r.http === spec.http),
          `${entry} ${spec.id}`,
        ).toEqual([]);
        expect(
          other.app.getHttpAdapter().getInstance().hasRoute({ method: spec.http, url: spec.route }),
          `${entry} ${spec.id}`,
        ).toBe(false);
      }
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-B2-12c#2] 三个路由都要后台登录：不带 admin_token 在处理前回 401 / 10001（提交用合法的红冲请求体与 Idempotency-Key）', async () => {
  const { app } = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      expect(
        app.getHttpAdapter().getInstance().hasRoute({ method: spec.http, url: spec.route }),
        `admin 入口必须挂载 ${spec.id}`,
      ).toBe(true);
      const response = await app.inject(
        spec.http === 'POST'
          ? {
              method: 'POST',
              url: spec.url,
              headers: {
                'x-trace-id': TRACE,
                'content-type': 'application/json',
                'idempotency-key': 'adj_entry_0001',
              },
              payload: JSON.stringify({ reverses_adjust_id: SOME_ID, note: '整笔冲回' }),
            }
          : { method: 'GET', url: spec.url, headers: { 'x-trace-id': TRACE } },
      );
      expect(response.statusCode, spec.id).toBe(401);
      expect(response.json(), spec.id).toMatchObject({ code: 10001, trace_id: TRACE });
      const op = await operation(spec);
      const schema = op.responses['4XX']?.content?.['application/json']?.schema;
      expect(schema, `${spec.id} 4XX`).toBeDefined();
      const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
      expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
    }
  } finally {
    await app.close();
  }
});

it('[AC-B2-12c#3] 契约三个操作去掉 x-implementation: planned，x-error-codes 不变', async () => {
  for (const spec of OPERATIONS) {
    const op = await operation(spec);
    expect(op, spec.id).not.toHaveProperty('x-implementation');
    expect(
      [...(op['x-error-codes'] ?? [])].sort((a, b) => a - b),
      spec.id,
    ).toEqual(spec.errors);
  }
});

it('[AC-B2-12c#4] 三个操作进 route-schemas、出 planned-operations（生成物随契约）', async () => {
  const routes = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  const planned = (await import(
    new URL('packages/contracts-ts/src/planned-operations.gen.ts', ROOT).href
  )) as { plannedOperations: ReadonlySet<string> };
  for (const spec of OPERATIONS) {
    expect(Object.hasOwn(routes.CONTRACT_ROUTE_SCHEMAS, spec.id), spec.id).toBe(true);
    expect(planned.plannedOperations.has(spec.id), spec.id).toBe(false);
  }
});
