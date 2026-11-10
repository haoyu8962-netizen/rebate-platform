// B2-16d §10 · adminListInviteRewards and adminGetInviteReward are served by the admin entry only,
// once each, with the schema generated from their contract operations, behind the admin login
// check; the contract no longer marks them planned and the generated files follow (no database:
// unit test, no listen).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { NOW, type Response } from '../../admin/auth/kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import {
  DETAIL,
  DETAIL_ID,
  ERROR_CODES,
  LIST,
  LIST_ID,
  operation,
  validate,
  type Path,
} from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const ROUTES: readonly { path: Path; route: string; url: string }[] = [
  { path: LIST, route: LIST, url: LIST },
  {
    path: DETAIL,
    route: DETAIL.replace('{invitee_id}', ':invitee_id'),
    url: DETAIL.replace('{invitee_id}', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02'),
  },
];

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
  const seen = new Map<string, unknown[]>(ROUTES.map(({ route }) => [route, []]));
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      // Fastify may add a HEAD route for each GET (exposeHeadRoutes): count GET only.
      const list = seen.get(route.url);
      if (list !== undefined && [route.method].flat().includes('GET')) list.push(route.schema);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-16d#1] admin 入口各挂一次邀请奖励列表与详情路由并带契约 schema；api / stream 入口都不挂', async () => {
  const admin = await boot('admin');
  try {
    for (const { path, route } of ROUTES) {
      const schemas = admin.seen.get(route)!;
      expect(schemas, `admin 入口必须恰好挂一次 GET ${path}`).toHaveLength(1);
      expect(schemas[0]).toEqual(routeSchemaOf((await operation(path)) as never));
    }
  } finally {
    await admin.app.close();
  }
  for (const entry of ['api', 'stream'] as const) {
    const other = await boot(entry);
    try {
      for (const { route } of ROUTES) {
        expect(other.seen.get(route), `${entry} ${route}`).toEqual([]);
        expect(
          other.app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: route }),
          `${entry} ${route}`,
        ).toBe(false);
      }
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-B2-16d#2] 要后台登录：列表与详情不带 admin_token 都在处理前回 401 / 10001', async () => {
  const { app } = await boot('admin');
  try {
    for (const { path, route, url } of ROUTES) {
      expect(
        app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: route }),
        `admin 入口必须挂载 GET ${path}`,
      ).toBe(true);
      const response = await app.inject({ method: 'GET', url, headers: { 'x-trace-id': TRACE } });
      expect(response.statusCode, path).toBe(401);
      expect(response.json()).toMatchObject({ code: 10001, trace_id: TRACE });
      await validate(path, response);
    }
  } finally {
    await app.close();
  }
});

it('[AC-B2-16d#3] 契约两个操作去掉 x-implementation: planned，错误码表不变', async () => {
  for (const path of [LIST, DETAIL] as const) {
    const op = await operation(path);
    expect(op, path).not.toHaveProperty('x-implementation');
    expect(
      [...(op['x-error-codes'] ?? [])].sort((a, b) => a - b),
      path,
    ).toEqual(ERROR_CODES[path]);
  }
});

it('[AC-B2-16d#4] 两个操作进 route-schemas、出 planned-operations（生成物随契约）', async () => {
  const routes = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as { CONTRACT_ROUTE_SCHEMAS: Record<string, unknown> };
  const planned = (await import(
    new URL('packages/contracts-ts/src/planned-operations.gen.ts', ROOT).href
  )) as { plannedOperations: ReadonlySet<string> };
  for (const id of [LIST_ID, DETAIL_ID]) {
    expect(Object.hasOwn(routes.CONTRACT_ROUTE_SCHEMAS, id), id).toBe(true);
    expect(planned.plannedOperations.has(id), id).toBe(false);
  }
});
