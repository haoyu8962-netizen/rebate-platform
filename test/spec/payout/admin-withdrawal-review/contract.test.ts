// B2-09k contract and mounting rule test (claude-independent, SPEC_REF 6f50a051):
// adminBatchApproveWithdrawals and adminRejectWithdrawal are implemented — contracts/openapi.yaml and
// the generated planned list no longer mark them planned; x-auth, x-idempotent and x-error-codes stay
// as CT-24zp fixed them — and the admin entry serves each exactly once with the contract's request
// schema; the api entry serves neither. No database (unit test, no listen). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths, type ContractOperation } from '../../ledger/admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

type ReviewOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };

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

function mounted(seen: readonly RouteOptions[], route: string): RouteOptions[] {
  return seen.filter((item) => item.url === route && [item.method].flat().includes('POST'));
}

async function expectServed(
  id: string,
  path: string,
  route: string,
  codes: readonly number[],
): Promise<void> {
  const paths = await contractPaths();
  const op: ReviewOperation | undefined = paths[path]?.['post'];
  expect(op?.operationId).toBe(id);
  expect(op?.['x-implementation']).not.toBe('planned');
  expect(plannedOperations.has(id)).toBe(false);
  expect(op?.['x-auth']).toBe('admin');
  expect(op?.['x-idempotent']).toBe(true);
  expect([...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual(codes);

  const admin = await boot('admin');
  try {
    const routes = mounted(admin.seen, route);
    expect(routes, `admin 入口必须恰好挂一次 POST ${route}`).toHaveLength(1);
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
    expect(mounted(api.seen, route)).toEqual([]);
    expect(api.app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: route })).toBe(
      false,
    );
  } finally {
    await api.app.close();
  }
}

it('[AC-B2-09k#1] adminBatchApproveWithdrawals 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent、x-error-codes 不变；admin 入口恰好挂一次并带契约的请求 schema，api 入口不挂', async () => {
  await expectServed(
    'adminBatchApproveWithdrawals',
    '/admin/v1/withdrawals/batch-approve',
    '/admin/v1/withdrawals/batch-approve',
    [10001, 10003, 10403, 20001, 20901, 40901],
  );
});

it('[AC-B2-09k#2] adminRejectWithdrawal 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent、x-error-codes 不变；admin 入口恰好挂一次并带契约的请求 schema，api 入口不挂', async () => {
  await expectServed(
    'adminRejectWithdrawal',
    '/admin/v1/withdrawals/{withdrawal_id}/reject',
    '/admin/v1/withdrawals/:withdrawal_id/reject',
    [10001, 10003, 10403, 20001, 20901, 20902, 40901],
  );
});
