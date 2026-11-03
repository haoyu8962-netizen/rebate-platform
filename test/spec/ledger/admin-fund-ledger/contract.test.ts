// B2-04zs contract and mounting rule test (claude-independent, SPEC_REF 6f50a051): adminGetFundLedger
// is implemented — contracts/openapi.yaml and the generated planned list no longer mark it planned;
// x-auth and x-error-codes stay as CT-24zh fixed them — and the admin entry serves it exactly once
// with the contract's request schema; the api entry does not serve it. No database (unit test, no
// listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths } from '../admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const PATH = '/admin/v1/fund-ledger';
const OPERATION_ID = 'adminGetFundLedger';

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; querystring?: unknown; headers?: unknown };
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
  const seen: RouteOptions[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if ([route.method].flat().includes('GET') && route.url === PATH) seen.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-04zs#1] adminGetFundLedger 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-error-codes [10001, 10403] 不变；admin 入口恰好挂一次 GET /admin/v1/fund-ledger 并带契约请求 schema，api 入口不挂', async () => {
  const paths = await contractPaths();
  const op = paths[PATH]?.['get'];
  expect(op?.operationId, PATH).toBe(OPERATION_ID);
  expect(op?.['x-implementation'], OPERATION_ID).not.toBe('planned');
  expect(op?.['x-auth'], OPERATION_ID).toBe('admin');
  const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
  expect(codes, OPERATION_ID).toEqual([10001, 10403]);
  expect(plannedOperations.has(OPERATION_ID), OPERATION_ID).toBe(false);

  const admin = await boot('admin');
  try {
    expect(admin.seen, `admin 入口必须恰好挂一次 GET ${PATH}`).toHaveLength(1);
    const expected = routeSchemaOf(paths[PATH]!['get'] as never);
    expect(admin.seen[0]!.schema?.querystring, PATH).toEqual(expected.querystring);
    expect(admin.seen[0]!.schema?.headers, PATH).toEqual(expected.headers);
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    expect(api.seen, PATH).toEqual([]);
    const server = api.app.getHttpAdapter().getInstance();
    expect(server.hasRoute({ method: 'GET', url: PATH }), PATH).toBe(false);
  } finally {
    await api.app.close();
  }
});
