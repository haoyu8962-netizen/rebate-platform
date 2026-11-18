// B2-02x contract and mounting rule test (claude-independent, SPEC_REF ba6655b1): CT-24zzn's
// recalcBalanceAdminReconDiff is implemented — contracts/openapi.yaml and the generated planned list
// no longer mark it planned (apps/api/src/contract.test.ts refuses a registered planned route);
// x-auth admin, no x-idempotent (no Idempotency-Key, 04 §6.6) and x-error-codes
// [10001, 10003, 10403, 20001] stay as CT-24zzn / CT-24zzna fixed them — and the admin entry serves
// POST /admin/v1/recon-diffs/:recon_diff_id/balance-recalc exactly once with the contract's request
// schema (body, path, X-Step-Up-Token header); the api entry does not serve it. No database (unit
// test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { contractPaths, type ContractOperation } from '../admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const NOW = '2026-11-18T02:30:00.000Z';
const RECALC_PATH = '/admin/v1/recon-diffs/{recon_diff_id}/balance-recalc';
const OPERATION_ID = 'recalcBalanceAdminReconDiff';
const ROUTE = '/admin/v1/recon-diffs/:recon_diff_id/balance-recalc';

type RecalcOperation = ContractOperation & {
  readonly 'x-idempotent'?: unknown;
  readonly requestBody?: {
    readonly content?: Record<string, { readonly schema?: Record<string, unknown> }>;
  };
};

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; body?: unknown; headers?: unknown };
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
      if (route.url === ROUTE && [route.method].flat().includes('POST')) seen.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-02x#45] recalcBalanceAdminReconDiff 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、无 x-idempotent、x-error-codes [10001, 10003, 10403, 20001] 不变，请求体仍只有必填的 reason（additionalProperties false，不收金额）；admin 入口恰好挂一次 POST 并带契约的请求 schema（body、路径参数、X-Step-Up-Token 请求头），api 入口不挂', async () => {
  const op: RecalcOperation | undefined = (await contractPaths())[RECALC_PATH]?.['post'];
  expect(op?.operationId).toBe(OPERATION_ID);
  expect(op?.['x-implementation'], OPERATION_ID).not.toBe('planned');
  const body = op?.requestBody?.content?.['application/json']?.schema;
  expect(body?.['additionalProperties'], 'request additionalProperties').toBe(false);
  expect(body?.['required']).toEqual(['reason']);
  expect(Object.keys((body?.['properties'] as Record<string, unknown>) ?? {})).toEqual(['reason']);
  expect(plannedOperations.has(OPERATION_ID), OPERATION_ID).toBe(false);
  expect(op?.['x-auth'], OPERATION_ID).toBe('admin');
  expect(op?.['x-idempotent'], OPERATION_ID).toBeUndefined();
  const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
  expect(codes, OPERATION_ID).toEqual([10001, 10003, 10403, 20001]);

  const admin = await boot('admin');
  try {
    expect(admin.seen, `admin 入口必须恰好挂一次 POST ${ROUTE}`).toHaveLength(1);
    const expected = routeSchemaOf(op as never);
    const schema = admin.seen[0]!.schema;
    expect(schema?.body, 'body').toEqual(expected.body);
    expect(schema?.params, 'params').toEqual(expected.params);
    expect(schema?.headers, 'headers').toEqual(expected.headers);
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    expect(api.seen, ROUTE).toEqual([]);
    const server = api.app.getHttpAdapter().getInstance();
    expect(server.hasRoute({ method: 'POST', url: ROUTE }), ROUTE).toBe(false);
  } finally {
    await api.app.close();
  }
});
