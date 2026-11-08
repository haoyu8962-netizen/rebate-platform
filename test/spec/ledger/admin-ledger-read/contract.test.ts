// B2-02u contract and mounting rule test (claude-independent, SPEC_REF 39756e36; D10-1079 ③):
// adminGetUserFundSummary and adminListLedgerEntries are implemented — contracts/openapi.yaml no
// longer marks them x-implementation: planned, the generated planned list (plannedOperations) leaves
// them out and the runtime request-schema table (route-schemas.gen.ts) carries them; x-auth and
// x-error-codes stay as CT-24zzc fixed them. The admin entry serves each exactly once with the
// contract's request schema; the api entry serves neither. Same shape as [AC-B2-04zs#1].
// No database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths } from '../admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

interface Spec {
  readonly operationId: string;
  readonly path: string;
  readonly codes: readonly number[];
}

const OPERATIONS: readonly Spec[] = [
  {
    operationId: 'adminGetUserFundSummary',
    path: '/admin/v1/users/{user_id}/fund-summary',
    codes: [10001, 10403, 20001],
  },
  {
    operationId: 'adminListLedgerEntries',
    path: '/admin/v1/ledger',
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
async function bootRoutes(entry: 'admin' | 'api'): Promise<RouteOptions[]> {
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
function routesOf(entry: 'admin' | 'api'): Promise<RouteOptions[]> {
  const known = booted.get(entry) ?? bootRoutes(entry);
  booted.set(entry, known);
  return known;
}

function getRoutesFor(routes: readonly RouteOptions[], spec: Spec): RouteOptions[] {
  const url = spec.path.replace(/\{(\w+)\}/g, ':$1');
  return routes.filter((route) => route.url === url && [route.method].flat().includes('GET'));
}

it.each(OPERATIONS)(
  '[AC-B2-02u#18] $operationId 去掉 x-implementation: planned（生成的 planned 清单与运行时请求 schema 表同步），x-auth admin、x-error-codes [10001, 10403, 20001] 不变；admin 入口恰好挂一次对应 GET 并带契约请求 schema，api 入口不挂',
  async (spec) => {
    const op = (await contractPaths())[spec.path]?.['get'];
    expect(op?.operationId, spec.path).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(op?.['x-auth'], spec.operationId).toBe('admin');
    const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
    expect(codes, spec.operationId).toEqual(spec.codes);
    expect(plannedOperations.has(spec.operationId), spec.operationId).toBe(false);
    expect(Object.keys(CONTRACT_ROUTE_SCHEMAS), 'route-schemas.gen.ts').toContain(spec.operationId);

    const mounted = getRoutesFor(await routesOf('admin'), spec);
    expect(mounted, `admin 入口必须恰好挂一次 GET ${spec.path}`).toHaveLength(1);
    const expected = routeSchemaOf(op as never);
    const schema = mounted[0]!.schema;
    expect(schema?.params, 'params').toEqual(expected.params);
    expect(schema?.querystring, 'querystring').toEqual(expected.querystring);
    expect(schema?.headers, 'headers').toEqual(expected.headers);

    expect(getRoutesFor(await routesOf('api'), spec), 'api').toEqual([]);
  },
  120_000,
);
