// B2-09zb contract and mounting rule test (claude-independent, SPEC_REF 18f0015): CT-24zv's
// adminRunSettleAdjust is implemented — contracts/openapi.yaml and the generated planned list no
// longer mark it planned; x-auth admin, x-idempotent true and x-error-codes stay as CT-24zv fixed
// them — and the admin entry serves POST /admin/v1/settle-adjust-runs exactly once with the
// contract's request schema (body and headers: X-Step-Up-Token, Idempotency-Key); the api entry
// serves none. The approve / reject / list operations stay B2-09zc's (still planned here is not
// checked). No database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths, type ContractOperation } from '../admin-settle-bills/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

const OPERATION_ID = 'adminRunSettleAdjust';
const PATH = '/admin/v1/settle-adjust-runs';
const CODES = [10001, 10003, 10403, 20001, 20901, 40901];

type RunOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };

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
      if (route.url === PATH && [route.method].flat().includes('POST')) seen.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-09zb#10] adminRunSettleAdjust 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent true、x-error-codes 不变；admin 入口恰好挂一次 POST 并带契约的请求 schema（body、请求头），api 入口不挂', async () => {
  const paths = await contractPaths();
  const op: RunOperation | undefined = paths[PATH]?.['post'];
  expect(op?.operationId).toBe(OPERATION_ID);
  expect(op?.['x-implementation']).not.toBe('planned');
  expect(op?.['x-auth']).toBe('admin');
  expect(op?.['x-idempotent']).toBe(true);
  expect([...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual(CODES);
  expect(plannedOperations.has(OPERATION_ID)).toBe(false);

  const admin = await boot('admin');
  try {
    expect(admin.seen, `admin 入口必须恰好挂一次 POST ${PATH}`).toHaveLength(1);
    const expected = routeSchemaOf(paths[PATH]!['post'] as never);
    const schema = admin.seen[0]!.schema;
    expect(schema?.body).toEqual(expected.body);
    expect(schema?.headers).toEqual(expected.headers);
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    expect(api.seen).toEqual([]);
    expect(api.app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: PATH })).toBe(
      false,
    );
  } finally {
    await api.app.close();
  }
});
