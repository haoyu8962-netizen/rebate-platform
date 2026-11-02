// B1-10n contract and mounting rule test (claude-independent, SPEC_REF 9ab94dc0): the three import
// operations no longer carry x-implementation: planned (contracts/openapi.yaml and the generated
// lists follow), x-auth and x-error-codes stay as the contract tasks fixed them, the admin entry
// serves each exactly once with the contract's request schema, the api and stream entries serve
// none of them; settlement's barrel exports createClawbackOrder for the rights port's assembly.
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

const IMPORTS = '/admin/v1/rights-imports';

interface Spec {
  readonly operationId: string;
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly codes: readonly number[];
}

const OPERATIONS: readonly Spec[] = [
  {
    operationId: 'adminCreateRightsImport',
    method: 'post',
    path: IMPORTS,
    codes: [10001, 10003, 10403, 20001],
  },
  {
    operationId: 'adminListRightsImports',
    method: 'get',
    path: IMPORTS,
    codes: [10001, 10403, 20001],
  },
  {
    operationId: 'adminGetRightsImport',
    method: 'get',
    path: `${IMPORTS}/{import_id}`,
    codes: [10001, 10403, 20001],
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

it.each(OPERATIONS)(
  '[AC-B1-10n#1] $operationId 去掉 x-implementation: planned（生成的 planned 清单与路由校验同步，route-schemas 有 id），x-auth admin、x-error-codes 不变；admin 入口恰好挂一次并带契约的请求 schema，api、stream 入口不挂',
  async (spec) => {
    const op = (await contract()).paths[spec.path]?.[spec.method];
    expect(op?.operationId).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(op?.['x-auth'], spec.operationId).toBe('admin');
    const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
    expect(codes, spec.operationId).toEqual(spec.codes);
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

it('[AC-B1-10n#2] settlement/index.ts 导出 createClawbackOrder（维权端口的生产装配从模块出口取，不跨模块直引）', async () => {
  const settlement = (await import(
    new URL('apps/api/src/modules/settlement/index.ts', ROOT).href
  )) as { createClawbackOrder?: unknown };
  expect(typeof settlement.createClawbackOrder).toBe('function');
}, 120_000);
