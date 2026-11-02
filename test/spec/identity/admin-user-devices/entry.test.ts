// B1-02zz §9 #1 · adminListUserDevices is served by the admin entry only, once, with the schema
// generated from its contract operation, behind the admin login check; the contract no longer marks
// it planned and the generated files follow (no database: unit test, no listen).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { NOW, type Response } from '../../admin/auth/kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { ERROR_CODES, OPERATION_ID, PATH, operation, validate } from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const ROUTE = PATH.replace('{user_id}', ':user_id');

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
      hasRoute(options: { method: 'GET'; url: string }): boolean;
    };
  };
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
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
  const seen: { schema: unknown }[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      // Fastify may add a HEAD route for each GET (exposeHeadRoutes): count GET only.
      if (route.url === ROUTE && [route.method].flat().includes('GET')) {
        seen.push({ schema: route.schema });
      }
    });
  await app.init();
  return { app, seen };
}

it('[AC-B1-02zz#1] admin 入口挂一次 GET /admin/v1/users/{user_id}/devices 并带契约 schema；api / stream 入口都不挂', async () => {
  const admin = await boot('admin');
  try {
    expect(admin.seen, 'admin 入口必须恰好挂一次会员设备列表路由').toHaveLength(1);
    expect(admin.seen[0]!.schema).toEqual(routeSchemaOf((await operation()) as never));
  } finally {
    await admin.app.close();
  }
  for (const entry of ['api', 'stream'] as const) {
    const other = await boot(entry);
    try {
      expect(other.seen, entry).toEqual([]);
      expect(
        other.app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: ROUTE }),
        entry,
      ).toBe(false);
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-B1-02zz#2] 要后台登录：不带 admin_token 在处理前回 401 / 10001', async () => {
  const { app } = await boot('admin');
  try {
    expect(
      app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: ROUTE }),
      'admin 入口必须挂载会员设备列表路由',
    ).toBe(true);
    const response = await app.inject({
      method: 'GET',
      url: PATH.replace('{user_id}', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01'),
      headers: { 'x-trace-id': TRACE },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001, trace_id: TRACE });
    await validate(response);
  } finally {
    await app.close();
  }
});

it('[AC-B1-02zz#3] 契约 adminListUserDevices 去掉 x-implementation: planned，错误码表不变', async () => {
  const op = await operation();
  expect(op).not.toHaveProperty('x-implementation');
  expect([...(op['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual(ERROR_CODES);
});

it('[AC-B1-02zz#4] adminListUserDevices 进 route-schemas、出 planned-operations（生成物随契约）', async () => {
  const routes = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  expect(Object.hasOwn(routes.CONTRACT_ROUTE_SCHEMAS, OPERATION_ID)).toBe(true);
  const planned = (await import(
    new URL('packages/contracts-ts/src/planned-operations.gen.ts', ROOT).href
  )) as { plannedOperations: ReadonlySet<string> };
  expect(planned.plannedOperations.has(OPERATION_ID)).toBe(false);
});
