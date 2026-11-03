// B2-09i contract and mounting rule test (claude-independent, SPEC_REF 6f50a051):
// adminCreatePayoutWatermark is implemented — contracts/openapi.yaml and the generated planned list
// no longer mark it planned; x-auth, x-idempotent and x-error-codes stay as CT-24zn fixed them — and
// the admin entry serves it exactly once with the contract's request schema; the api entry does not
// serve it. No database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths, type ContractOperation } from '../../ledger/admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const ID = 'adminCreatePayoutWatermark';
const ROUTE = '/admin/v1/payout-watermarks';

type WatermarkOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };

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
      hasRoute(options: { method: 'POST'; url: string }): boolean;
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
      seen.push(route);
    });
  await app.init();
  return { app, seen };
}

function mounted(seen: readonly RouteOptions[]): RouteOptions[] {
  return seen.filter((item) => item.url === ROUTE && [item.method].flat().includes('POST'));
}

it('[AC-B2-09i#1] adminCreatePayoutWatermark 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent、x-error-codes 不变；admin 入口恰好挂一次并带契约的请求 schema（请求体、请求头），api 入口不挂', async () => {
  const paths = await contractPaths();
  const op: WatermarkOperation | undefined = paths[ROUTE]?.['post'];
  expect(op?.operationId).toBe(ID);
  expect(op?.['x-implementation']).not.toBe('planned');
  expect(plannedOperations.has(ID)).toBe(false);
  expect(op?.['x-auth']).toBe('admin');
  expect(op?.['x-idempotent']).toBe(true);
  expect([...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual([
    10001, 10003, 10403, 20001, 20901, 40901,
  ]);

  const admin = await boot('admin');
  try {
    const routes = mounted(admin.seen);
    expect(routes, `admin 入口必须恰好挂一次 POST ${ROUTE}`).toHaveLength(1);
    const expected = routeSchemaOf(op as never);
    const schema = routes[0]!.schema;
    expect(schema?.body).toEqual(expected.body);
    expect(schema?.params).toEqual(expected.params);
    expect(schema?.querystring).toEqual(expected.querystring);
    expect(schema?.headers).toEqual(expected.headers);
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    expect(mounted(api.seen)).toEqual([]);
    expect(api.app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: ROUTE })).toBe(
      false,
    );
  } finally {
    await api.app.close();
  }
});
