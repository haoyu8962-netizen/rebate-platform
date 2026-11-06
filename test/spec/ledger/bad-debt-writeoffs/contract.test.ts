// B2-12f contract and mounting rule test (claude-independent, SPEC_REF 18f0015e): the task takes the
// planned marker off adminListBadDebtWriteoffs and adminApproveBadDebtWriteoff — contracts/openapi.yaml
// and the generated planned list no longer mark them planned; x-auth, x-idempotent and
// x-error-codes stay as the contract fixes them — and the admin entry serves GET
// /admin/v1/bad-debt-writeoffs and POST /admin/v1/bad-debt-writeoffs/:id/approve exactly once each,
// with the contract's request schemas; the api entry serves neither. No database (unit test, no
// listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { contractPaths, type ContractOperation } from '../admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const NOW = '2027-02-19T02:30:00.000Z';
const LIST_PATH = '/admin/v1/bad-debt-writeoffs';
const APPROVE_PATH = '/admin/v1/bad-debt-writeoffs/{id}/approve';
const LIST_ROUTE = '/admin/v1/bad-debt-writeoffs';
const APPROVE_ROUTE = '/admin/v1/bad-debt-writeoffs/:id/approve';

type Operation = ContractOperation & { readonly 'x-idempotent'?: unknown };

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; body?: unknown; headers?: unknown; querystring?: unknown };
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

function routeOf(route: RouteOptions): 'list' | 'approve' | null {
  const methods = [route.method].flat();
  if (route.url === LIST_ROUTE && methods.includes('GET')) return 'list';
  if (route.url === APPROVE_ROUTE && methods.includes('POST')) return 'approve';
  return null;
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
  const seen: { list: RouteOptions[]; approve: RouteOptions[] } = { list: [], approve: [] };
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      const which = routeOf(route);
      if (which !== null) seen[which].push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-12f#3] 两个操作去掉 x-implementation: planned（生成的 planned 清单同步）：列表 x-auth admin、x-error-codes [10001, 10403, 20001]；批准 x-auth admin、x-idempotent true、x-error-codes [10001, 10003, 10403, 20001, 20901, 20902, 40901]；admin 入口各恰好挂一次并带契约的请求 schema，api 入口都不挂', async () => {
  const paths = await contractPaths();
  const list: Operation | undefined = paths[LIST_PATH]?.['get'];
  const approve: Operation | undefined = paths[APPROVE_PATH]?.['post'];
  expect(list?.operationId).toBe('adminListBadDebtWriteoffs');
  expect(approve?.operationId).toBe('adminApproveBadDebtWriteoff');
  for (const [op, codes] of [
    [list, [10001, 10403, 20001]],
    [approve, [10001, 10003, 10403, 20001, 20901, 20902, 40901]],
  ] as const) {
    const id = op?.operationId ?? '?';
    expect(op?.['x-implementation'], id).not.toBe('planned');
    expect(op?.['x-auth'], id).toBe('admin');
    expect(
      [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b),
      id,
    ).toEqual(codes);
    expect(plannedOperations.has(id), id).toBe(false);
  }
  expect(approve?.['x-idempotent']).toBe(true);

  const admin = await boot('admin');
  try {
    expect(admin.seen.list, `admin 入口必须恰好挂一次 GET ${LIST_ROUTE}`).toHaveLength(1);
    expect(admin.seen.approve, `admin 入口必须恰好挂一次 POST ${APPROVE_ROUTE}`).toHaveLength(1);
    const listSchema = routeSchemaOf(list as never);
    expect(admin.seen.list[0]!.schema?.querystring, 'querystring').toEqual(listSchema.querystring);
    expect(admin.seen.list[0]!.schema?.headers, 'list headers').toEqual(listSchema.headers);
    const approveSchema = routeSchemaOf(approve as never);
    const mounted = admin.seen.approve[0]!.schema;
    expect(mounted?.body, 'body').toEqual(approveSchema.body);
    expect(mounted?.params, 'params').toEqual(approveSchema.params);
    expect(mounted?.headers, 'approve headers').toEqual(approveSchema.headers);
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    expect(api.seen).toEqual({ list: [], approve: [] });
    const server = api.app.getHttpAdapter().getInstance();
    expect(server.hasRoute({ method: 'GET', url: LIST_ROUTE }), LIST_ROUTE).toBe(false);
    expect(server.hasRoute({ method: 'POST', url: APPROVE_ROUTE }), APPROVE_ROUTE).toBe(false);
  } finally {
    await api.app.close();
  }
});
