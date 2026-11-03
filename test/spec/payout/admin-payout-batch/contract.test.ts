// B2-09l contract and mounting rule test (claude-independent, SPEC_REF 6f50a051): adminCreatePayoutBatch
// and adminGetPayoutOverview are implemented — contracts/openapi.yaml and the generated planned list no
// longer mark them planned; x-auth, x-idempotent and x-error-codes stay as CT-24zq fixed them — and the
// admin entry serves each exactly once with the contract's schema; the api entry serves neither. No
// database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths, type ContractOperation } from '../../ledger/admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

type BatchOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };
type Method = 'GET' | 'POST';

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
      hasRoute(options: { method: Method; url: string }): boolean;
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

function mounted(seen: readonly RouteOptions[], route: string, method: Method): RouteOptions[] {
  return seen.filter((item) => item.url === route && [item.method].flat().includes(method));
}

async function expectServed(
  id: string,
  route: string,
  method: Method,
  codes: readonly number[],
): Promise<BatchOperation | undefined> {
  const paths = await contractPaths();
  const op: BatchOperation | undefined = paths[route]?.[method.toLowerCase()];
  expect(op?.operationId).toBe(id);
  expect(op?.['x-implementation']).not.toBe('planned');
  expect(plannedOperations.has(id)).toBe(false);
  expect(op?.['x-auth']).toBe('admin');
  expect([...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual(codes);

  const admin = await boot('admin');
  try {
    const routes = mounted(admin.seen, route, method);
    expect(routes, `admin 入口必须恰好挂一次 ${method} ${route}`).toHaveLength(1);
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
    expect(mounted(api.seen, route, method)).toEqual([]);
    expect(api.app.getHttpAdapter().getInstance().hasRoute({ method, url: route })).toBe(false);
  } finally {
    await api.app.close();
  }
  return op;
}

it('[AC-B2-09l#1] adminCreatePayoutBatch 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent、x-error-codes 不变；admin 入口恰好挂一次并带契约的请求 schema，api 入口不挂', async () => {
  const op = await expectServed(
    'adminCreatePayoutBatch',
    '/admin/v1/payout-batches',
    'POST',
    [10001, 10003, 10403, 20001, 20901, 40901],
  );
  expect(op?.['x-idempotent']).toBe(true);
});

it('[AC-B2-09l#2] adminGetPayoutOverview 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-error-codes 不变、不是幂等写；admin 入口恰好挂一次，api 入口不挂', async () => {
  const op = await expectServed(
    'adminGetPayoutOverview',
    '/admin/v1/payout-overview',
    'GET',
    [10001, 10403],
  );
  expect(op?.['x-idempotent']).toBeUndefined();
});
