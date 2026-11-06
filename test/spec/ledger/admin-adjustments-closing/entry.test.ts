// B2-12d entry (claude-independent, SPEC_REF 0df853be): adminApproveAdjustment and
// adminRejectAdjustment (CT-24zg, CT-26n) are served by the admin entry only, once each, with the
// schema generated from their contract operations, behind the admin login check; the contract no
// longer marks them planned (error codes as the contract writes them) and the generated files
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
const SOME_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fa002';

interface Spec {
  readonly id: string;
  readonly path: string;
  /** The Fastify route URL. */
  readonly route: string;
  /** A concrete URL of the route. */
  readonly url: string;
  /** A valid request body. */
  readonly body: unknown;
  readonly errors: readonly number[];
}

const OPERATIONS: readonly Spec[] = [
  {
    id: 'adminApproveAdjustment',
    path: '/admin/v1/adjustments/{adjust_id}/approve',
    route: '/admin/v1/adjustments/:adjust_id/approve',
    url: `/admin/v1/adjustments/${SOME_ID}/approve`,
    body: {},
    errors: [10001, 10003, 10403, 20001, 20901, 20902, 40901],
  },
  {
    id: 'adminRejectAdjustment',
    path: '/admin/v1/adjustments/{adjust_id}/reject',
    route: '/admin/v1/adjustments/:adjust_id/reject',
    url: `/admin/v1/adjustments/${SOME_ID}/reject`,
    body: { reason: '预填金额与核对结果不一致' },
    errors: [10001, 10403, 20001, 20901, 20902, 40901],
  },
];

interface Operation {
  operationId: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, Partial<Record<'post', Operation>>>;
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
  const op = (await contract()).paths[spec.path]?.post;
  expect(op, `post ${spec.path} must exist in the contract`).toBeDefined();
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
      hasRoute(options: { method: 'POST'; url: string }): boolean;
    };
  };
  inject(input: {
    method: 'POST';
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
  const seen: { route: string; schema: unknown }[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method === 'POST') seen.push({ route: route.url, schema: route.schema });
      }
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-12d#1] admin 入口各挂一次批准与驳回路由并带契约 schema；api / stream 入口都不挂', async () => {
  const admin = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      const mounted = admin.seen.filter((r) => r.route === spec.route);
      expect(mounted, `POST ${spec.route} 必须恰好挂一次`).toHaveLength(1);
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
          other.seen.filter((r) => r.route === spec.route),
          `${entry} ${spec.id}`,
        ).toEqual([]);
        expect(
          other.app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: spec.route }),
          `${entry} ${spec.id}`,
        ).toBe(false);
      }
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-B2-12d#2] 两个路由都要后台登录：不带 admin_token 在处理前回 401 / 10001（合法请求体与 Idempotency-Key），响应过契约 4XX', async () => {
  const { app } = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      expect(
        app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: spec.route }),
        `admin 入口必须挂载 ${spec.id}`,
      ).toBe(true);
      const response = await app.inject({
        method: 'POST',
        url: spec.url,
        headers: {
          'x-trace-id': TRACE,
          'content-type': 'application/json',
          'idempotency-key': 'adc_entry_0001',
        },
        payload: JSON.stringify(spec.body),
      });
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

it('[AC-B2-12d#3] 契约两个操作去掉 x-implementation: planned，x-error-codes 不变', async () => {
  for (const spec of OPERATIONS) {
    const op = await operation(spec);
    expect(op, spec.id).not.toHaveProperty('x-implementation');
    expect(
      [...(op['x-error-codes'] ?? [])].sort((a, b) => a - b),
      spec.id,
    ).toEqual(spec.errors);
  }
});

it('[AC-B2-12d#4] 两个操作进 route-schemas、出 planned-operations（生成物随契约）', async () => {
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
