// B2-09b contract and mounting rule test (claude-independent, SPEC_REF 37808a50): CT-24w's
// closeAdminReconDiff is implemented — contracts/openapi.yaml and the generated planned list no
// longer mark it planned; x-auth, x-idempotent and x-error-codes stay as CT-24w fixed them — and the
// admin entry serves POST /admin/v1/recon-diffs/:recon_diff_id/close exactly once with the
// contract's request schema (body, path, Idempotency-Key header); the api entry does not serve it.
// No database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import type { ContractOperation } from '../admin-recon-diffs/kit.ts';
import { CLOSE_PATH, NOW, contractPaths } from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const OPERATION_ID = 'closeAdminReconDiff';
const ROUTE = '/admin/v1/recon-diffs/:recon_diff_id/close';

type CloseOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };

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

// 标题沿用原文，关闭差错单归 sudo，二次验证期望以块内断言为准。
it('[AC-B2-09b#1] closeAdminReconDiff 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent true、x-error-codes [10001, 10403, 20001, 20901, 20902, 40901] 不变；admin 入口恰好挂一次 POST 并带契约的请求 schema（body、路径参数、Idempotency-Key 请求头），api 入口不挂', async () => {
  const paths = await contractPaths();
  const op: CloseOperation | undefined = paths[CLOSE_PATH]?.['post'];
  expect(op?.operationId).toBe(OPERATION_ID);
  expect(op?.['x-implementation'], OPERATION_ID).not.toBe('planned');
  expect(op?.['x-auth'], OPERATION_ID).toBe('admin');
  expect(op?.['x-idempotent'], OPERATION_ID).toBe(true);
  const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
  expect(codes, OPERATION_ID).toEqual([10001, 10003, 10403, 20001, 20901, 20902, 40901]);
  expect(plannedOperations.has(OPERATION_ID), OPERATION_ID).toBe(false);

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
