// B1-09v contract and mounting rule test (claude-independent, SPEC_REF 7666a46e):
// adminSetOrderReasonSub (CT-24zw) no longer carries x-implementation: planned — contracts/
// openapi.yaml and the generated lists follow (planned-operations.gen.ts, route-schemas.gen.ts) —
// while x-auth admin and its x-error-codes stay as the contract task fixed them; the admin entry
// serves it exactly once with the contract's request schema, the api and stream entries serve none.
// No database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contract } from '../admin-mounts/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const PATH = '/admin/v1/orders/{order_id}/reason-sub';
const OPERATION = 'adminSetOrderReasonSub';

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; querystring?: unknown; body?: unknown; headers?: unknown };
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): {
    getInstance(): { addHook(name: 'onRoute', hook: (route: RouteOptions) => void): unknown };
  };
}

/** Every route the entry registers; the entry is closed again before the answer. */
async function bootRoutes(entry: 'admin' | 'api' | 'stream'): Promise<RouteOptions[]> {
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
      seen.push(route);
    });
  try {
    await app.init();
  } finally {
    await app.close();
  }
  return seen;
}

function routesFor(routes: readonly RouteOptions[], path: string, method: string): RouteOptions[] {
  const url = path.replace(/\{(\w+)\}/g, ':$1');
  return routes.filter((route) => route.url === url && [route.method].flat().includes(method));
}

it('[AC-B1-09v#8] adminSetOrderReasonSub 去掉 x-implementation: planned：生成的 planned 清单不含它、route-schemas 有它；x-auth admin、x-error-codes 10001 / 10403 / 20001 / 20902 不变', async () => {
  const op = (await contract()).paths[PATH]?.['post'];
  expect(op?.operationId).toBe(OPERATION);
  expect(op?.['x-implementation']).not.toBe('planned');
  expect(op?.['x-auth']).toBe('admin');
  expect([...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual([
    10001, 10403, 20001, 20902,
  ]);
  expect(plannedOperations.has(OPERATION)).toBe(false);
  expect(Object.keys(CONTRACT_ROUTE_SCHEMAS)).toContain(OPERATION);
}, 120_000);

it('[AC-B1-09v#8] admin 入口恰好挂一次 POST /admin/v1/orders/:order_id/reason-sub 并带契约的请求 schema；api、stream 入口不挂', async () => {
  const op = (await contract()).paths[PATH]?.['post'];
  expect(op?.operationId).toBe(OPERATION);
  const mounted = routesFor(await bootRoutes('admin'), PATH, 'POST');
  expect(mounted, `admin 入口必须恰好挂一次 ${OPERATION}`).toHaveLength(1);
  const expected = routeSchemaOf(op as never);
  const schema = mounted[0]?.schema;
  expect(schema?.body, 'body').toEqual(expected.body);
  expect(schema?.params, 'params').toEqual(expected.params);
  expect(schema?.headers, 'headers').toEqual(expected.headers);
  for (const entry of ['api', 'stream'] as const) {
    expect(routesFor(await bootRoutes(entry), PATH, 'POST'), entry).toEqual([]);
  }
}, 120_000);
