// B2-09zc contract and mounting rule test (claude-independent, SPEC_REF b79958d): CT-24zv's
// adminListSettleAdjustments, adminApproveSettleAdjustBatch and adminRejectSettleAdjustBatch are
// implemented — contracts/openapi.yaml and the generated planned list no longer mark them planned;
// x-auth admin, x-idempotent (approve / reject) and x-error-codes stay as CT-24zv fixed them — and
// the admin entry serves each exactly once with the contract's request schema (path, query,
// headers: X-Step-Up-Token, Idempotency-Key; approve / reject mount no body schema — the body is
// checked after the permission and step-up guards); the api entry serves none. No database (unit test, no
// listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths, type ContractOperation } from '../admin-settle-bills/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

const OPERATIONS = [
  {
    operationId: 'adminListSettleAdjustments',
    path: '/admin/v1/settle-adjustments',
    method: 'get',
    route: '/admin/v1/settle-adjustments',
    idempotent: false,
    codes: [10001, 10403, 20001],
  },
  {
    operationId: 'adminApproveSettleAdjustBatch',
    path: '/admin/v1/settle-adjust-batches/{batch_id}/approve',
    method: 'post',
    route: '/admin/v1/settle-adjust-batches/:batch_id/approve',
    idempotent: true,
    codes: [10001, 10003, 10403, 20001, 20901, 20902, 40901],
  },
  {
    operationId: 'adminRejectSettleAdjustBatch',
    path: '/admin/v1/settle-adjust-batches/{batch_id}/reject',
    method: 'post',
    route: '/admin/v1/settle-adjust-batches/:batch_id/reject',
    idempotent: true,
    codes: [10001, 10003, 10403, 20001, 20901, 20902, 40901],
  },
] as const;

type Operation = ContractOperation & { readonly 'x-idempotent'?: unknown };

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; querystring?: unknown; body?: unknown; headers?: unknown };
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
}

function key(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
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
  const seen = new Map(
    OPERATIONS.map((op): [string, RouteOptions[]] => [key(op.method, op.route), []]),
  );
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) seen.get(key(method, route.url))?.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-09zc#9] 三条操作去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent（批准 / 拒绝 true）、x-error-codes 与 CT-24zv 一致；admin 入口各恰好挂一次并带契约请求 schema（路径参数、查询、请求头；批准 / 拒绝不挂请求体 schema，守卫之后再校验），api 入口不挂', async () => {
  const paths = await contractPaths();
  for (const spec of OPERATIONS) {
    const op: Operation | undefined = paths[spec.path]?.[spec.method];
    expect(op?.operationId, spec.path).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(op?.['x-auth'], spec.operationId).toBe('admin');
    if (spec.idempotent) expect(op?.['x-idempotent'], spec.operationId).toBe(true);
    else expect(op?.['x-idempotent'], spec.operationId).toBeUndefined();
    const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
    expect(codes, spec.operationId).toEqual([...spec.codes]);
    expect(plannedOperations.has(spec.operationId), spec.operationId).toBe(false);
  }

  const admin = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      const routes = admin.seen.get(key(spec.method, spec.route)) ?? [];
      expect(routes, `admin 入口必须恰好挂一次 ${key(spec.method, spec.route)}`).toHaveLength(1);
      const expected = routeSchemaOf(paths[spec.path]![spec.method] as never);
      const schema = routes[0]!.schema;
      expect(schema?.params, spec.route).toEqual(expected.params);
      expect(schema?.querystring, spec.route).toEqual(expected.querystring);
      // Approve / reject mount no body schema: Fastify's route validation runs before the handler,
      // and the contract orders checks fund.settle_adjust → step-up → body (20001), so the body is
      // validated after the guards with the same contract schema (precedent B1-12z).
      if (spec.method === 'post') expect(schema?.body, spec.route).toBeUndefined();
      else expect(schema?.body, spec.route).toEqual(expected.body);
      expect(schema?.headers, spec.route).toEqual(expected.headers);
    }
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    for (const spec of OPERATIONS) {
      expect(api.seen.get(key(spec.method, spec.route)), spec.route).toEqual([]);
      const server = api.app.getHttpAdapter().getInstance();
      const method = spec.method === 'get' ? 'GET' : 'POST';
      expect(server.hasRoute({ method, url: spec.route }), spec.route).toBe(false);
    }
  } finally {
    await api.app.close();
  }
});
