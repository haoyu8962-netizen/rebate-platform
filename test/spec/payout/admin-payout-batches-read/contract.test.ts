// B2-07g contract and mounting rule test (claude-independent, SPEC_REF ba6655b1): CT-24zzo's
// listAdminPayoutBatches and getAdminPayoutBatch are implemented — contracts/openapi.yaml and the
// generated planned list no longer mark them planned, x-auth admin and x-error-codes
// [10001, 10403, 20001] stay as CT-24zzo fixed them, neither is an idempotent write — and the admin
// entry serves each exactly once with the contract's request schema; the api entry serves neither
// (as B2-02x #45 and B2-09c #15). No database (unit test, no listen). Top-level it() only.
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import type { ContractOperation } from '../admin-withdrawals/kit.ts';
import { DETAIL_PATH, LIST_PATH, NOW, contractPaths } from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

type ReadOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };

const OPERATIONS = [
  { operationId: 'listAdminPayoutBatches', path: LIST_PATH, route: '/admin/v1/payout-batches' },
  {
    operationId: 'getAdminPayoutBatch',
    path: DETAIL_PATH,
    route: '/admin/v1/payout-batches/:batch_id',
  },
] as const;

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
  const seen = new Map(OPERATIONS.map((op): [string, RouteOptions[]] => [op.route, []]));
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if ([route.method].flat().includes('GET')) seen.get(route.url)?.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-07g#1] listAdminPayoutBatches / getAdminPayoutBatch 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-error-codes [10001, 10403, 20001] 不变、不是幂等写', async () => {
  const paths = await contractPaths();
  for (const spec of OPERATIONS) {
    const op: ReadOperation | undefined = paths[spec.path]?.['get'];
    expect(op?.operationId, spec.path).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(op?.['x-auth'], spec.operationId).toBe('admin');
    expect(op?.['x-idempotent'], spec.operationId).toBeUndefined();
    const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
    expect(codes, spec.operationId).toEqual([10001, 10403, 20001]);
    expect(plannedOperations.has(spec.operationId), spec.operationId).toBe(false);
  }
});

it('[AC-B2-07g#1] admin 入口各恰好挂一次 GET（带契约的 querystring / params schema），api 入口两条都不挂', async () => {
  const paths = await contractPaths();
  const admin = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      const routes = admin.seen.get(spec.route) ?? [];
      expect(routes, `admin 入口必须恰好挂一次 GET ${spec.route}`).toHaveLength(1);
      const expected = routeSchemaOf(paths[spec.path]!['get'] as never);
      expect(routes[0]!.schema?.querystring, spec.route).toEqual(expected.querystring);
      expect(routes[0]!.schema?.params, spec.route).toEqual(expected.params);
    }
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    for (const spec of OPERATIONS) {
      expect(api.seen.get(spec.route), spec.route).toEqual([]);
      const server = api.app.getHttpAdapter().getInstance();
      expect(server.hasRoute({ method: 'GET', url: spec.route }), spec.route).toBe(false);
    }
  } finally {
    await api.app.close();
  }
});
