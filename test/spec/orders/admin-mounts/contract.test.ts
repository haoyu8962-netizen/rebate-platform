// B1-10m contract and mounting rule test (claude-independent, SPEC_REF 9ab94dc0): the five
// operations no longer carry x-implementation: planned (contracts/openapi.yaml and the generated
// lists follow), x-auth and x-error-codes stay as the contract tasks fixed them, the admin entry
// serves each exactly once with the contract's request schema, the api and stream entries serve
// none of them; the placeholders that kept the routes unmounted (J-1) are gone.
// No database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contract } from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

const CLAIM_ITEM = '/admin/v1/claims/{claim_id}/items/{item_id}';
const ORDER = '/admin/v1/orders/{order_id}';

interface Spec {
  readonly operationId: string;
  readonly method: 'post';
  readonly path: string;
  readonly codes: readonly number[];
}

const OPERATIONS: readonly Spec[] = [
  {
    operationId: 'adminApproveClaimItem',
    method: 'post',
    path: `${CLAIM_ITEM}/approve`,
    codes: [10001, 10403, 20001, 20902],
  },
  {
    operationId: 'adminRejectClaimItem',
    method: 'post',
    path: `${CLAIM_ITEM}/reject`,
    codes: [10001, 10403, 20001, 20902],
  },
  {
    operationId: 'adminHoldOrder',
    method: 'post',
    path: `${ORDER}/hold`,
    codes: [10001, 10403, 20001, 20902],
  },
  {
    operationId: 'adminUnholdOrder',
    method: 'post',
    path: `${ORDER}/unhold`,
    codes: [10001, 10403, 20001, 20902],
  },
  {
    operationId: 'adminReassignOrder',
    method: 'post',
    path: `${ORDER}/reassign`,
    codes: [10001, 10003, 10403, 20001, 20902],
  },
];

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

const booted = new Map<string, Promise<RouteOptions[]>>();
function routesOf(entry: 'admin' | 'api' | 'stream'): Promise<RouteOptions[]> {
  const known = booted.get(entry) ?? bootRoutes(entry);
  booted.set(entry, known);
  return known;
}

function routesFor(routes: readonly RouteOptions[], spec: Spec): RouteOptions[] {
  const url = spec.path.replace(/\{(\w+)\}/g, ':$1');
  const method = spec.method.toUpperCase();
  return routes.filter((route) => route.url === url && [route.method].flat().includes(method));
}

// 标题沿用原文，二次验证期望以块内断言为准。
it.each(OPERATIONS)(
  '[AC-B1-10m#1] $operationId 去掉 x-implementation: planned（生成的 planned 清单与路由校验同步），x-auth admin、x-error-codes 不变；admin 入口恰好挂一次并带契约的请求 schema，api、stream 入口不挂',
  async (spec) => {
    const op = (await contract()).paths[spec.path]?.[spec.method];
    expect(op?.operationId).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(op?.['x-auth'], spec.operationId).toBe('admin');
    const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
    expect(codes, spec.operationId).toEqual(spec.codes.filter((code) => code !== 10003));
    expect(plannedOperations.has(spec.operationId), spec.operationId).toBe(false);
    expect(Object.keys(CONTRACT_ROUTE_SCHEMAS)).toContain(spec.operationId);

    const mounted = routesFor(await routesOf('admin'), spec);
    expect(mounted, `admin 入口必须恰好挂一次 ${spec.operationId}`).toHaveLength(1);
    const expected = routeSchemaOf(op as never);
    const schema = mounted[0]!.schema;
    expect(schema?.body, 'body').toEqual(expected.body);
    expect(schema?.params, 'params').toEqual(expected.params);
    expect(schema?.querystring, 'querystring').toEqual(expected.querystring);
    expect(schema?.headers, 'headers').toEqual(expected.headers);
    for (const entry of ['api', 'stream'] as const) {
      expect(routesFor(await routesOf(entry), spec), entry).toEqual([]);
    }
  },
  120_000,
);

it.each([
  ['apps/api/src/modules/orders/application/claim-review.ts', 'CLAIM_SETTLEMENT_UNAVAILABLE'],
  ['apps/api/src/modules/orders/application/admin-assign.ts', 'ASSIGN_SETTLEMENT_UNAVAILABLE'],
])('[AC-B1-10m#2] %s 不再保留占位端口 %s', (file, placeholder) => {
  expect(readFileSync(new URL(file, ROOT), 'utf8')).not.toContain(placeholder);
});
