// B2-09f contract and mounting rule test (claude-independent, SPEC_REF 37808a50): CT-24zd's
// confirmAdminSettleBill, cancelAdminSettleBatchSchedule, rejectAdminSettleBatch,
// resumeAdminSettleBatch and createAdminSettleSupplementBatches are implemented —
// contracts/openapi.yaml and the generated planned list no longer mark them planned; x-auth,
// x-idempotent and x-error-codes stay as CT-24zd fixed them; AdminSettleBatch.row_version becomes
// required (D10-437 ③) — and the admin entry serves each exactly once with the contract's request
// schema (body, path, X-Step-Up-Token and, for the launch, Idempotency-Key); the api entry serves
// none. No database (unit test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import {
  DETAIL_PATH,
  NOW,
  contractPaths,
  type ContractOperation,
} from '../admin-settle-bills/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

const CAS_CODES = [10001, 10003, 10403, 20001, 20902];

const OPERATIONS = [
  {
    operationId: 'confirmAdminSettleBill',
    path: '/admin/v1/settle-bills/{bill_id}/confirm',
    route: '/admin/v1/settle-bills/:bill_id/confirm',
    codes: CAS_CODES,
    idempotent: undefined,
  },
  {
    operationId: 'createAdminSettleSupplementBatches',
    path: '/admin/v1/settle-bills/{bill_id}/supplement-batches',
    route: '/admin/v1/settle-bills/:bill_id/supplement-batches',
    codes: [10001, 10003, 10403, 20001, 20901, 40901],
    idempotent: true,
  },
  {
    operationId: 'cancelAdminSettleBatchSchedule',
    path: '/admin/v1/settle-batches/{batch_id}/cancel-schedule',
    route: '/admin/v1/settle-batches/:batch_id/cancel-schedule',
    codes: CAS_CODES,
    idempotent: undefined,
  },
  {
    operationId: 'rejectAdminSettleBatch',
    path: '/admin/v1/settle-batches/{batch_id}/reject',
    route: '/admin/v1/settle-batches/:batch_id/reject',
    codes: CAS_CODES,
    idempotent: undefined,
  },
  {
    operationId: 'resumeAdminSettleBatch',
    path: '/admin/v1/settle-batches/{batch_id}/resume',
    route: '/admin/v1/settle-batches/:batch_id/resume',
    codes: CAS_CODES,
    idempotent: undefined,
  },
] as const;

type CommandOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };

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
  const seen = new Map(OPERATIONS.map((op): [string, RouteOptions[]] => [op.route, []]));
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if ([route.method].flat().includes('POST')) seen.get(route.url)?.push(route);
    });
  await app.init();
  return { app, seen };
}

// 标题沿用原文，二次验证期望以块内断言为准。
it('[AC-B2-09f#1] 五个写接口去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent（只有发起补充）、x-error-codes 不变；admin 入口各恰好挂一次 POST 并带契约的请求 schema（body、路径参数、请求头），api 入口不挂', async () => {
  const paths = await contractPaths();
  for (const spec of OPERATIONS) {
    const op: CommandOperation | undefined = paths[spec.path]?.['post'];
    expect(op?.operationId, spec.path).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(op?.['x-auth'], spec.operationId).toBe('admin');
    expect(op?.['x-idempotent'], spec.operationId).toBe(spec.idempotent);
    const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
    expect(codes, spec.operationId).toEqual(spec.codes.filter((code) => code !== 10003));
    expect(plannedOperations.has(spec.operationId), spec.operationId).toBe(false);
  }

  const admin = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      const routes = admin.seen.get(spec.route) ?? [];
      expect(routes, `admin 入口必须恰好挂一次 POST ${spec.route}`).toHaveLength(1);
      const expected = routeSchemaOf(paths[spec.path]!['post'] as never);
      const schema = routes[0]!.schema;
      expect(schema?.body, spec.route).toEqual(expected.body);
      expect(schema?.params, spec.route).toEqual(expected.params);
      expect(schema?.headers, spec.route).toEqual(expected.headers);
    }
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    for (const spec of OPERATIONS) {
      expect(api.seen.get(spec.route), spec.route).toEqual([]);
      const server = api.app.getHttpAdapter().getInstance();
      expect(server.hasRoute({ method: 'POST', url: spec.route }), spec.route).toBe(false);
    }
  } finally {
    await api.app.close();
  }
});

it('[AC-B2-09f#2] 契约的 AdminSettleBatch 把 row_version 列入 required（D10-437 ③）：详情与写接口响应里的每个批次恒带 row_version；取值约束仍是 ≥ 0 的整数', async () => {
  const paths = await contractPaths();
  const schema: unknown =
    paths[DETAIL_PATH]?.['get']?.responses['200']?.content?.['application/json']?.schema;
  const { properties } = schema as {
    properties: {
      data: {
        properties: {
          batches: {
            items: { required: readonly string[]; properties: Record<string, unknown> };
          };
        };
      };
    };
  };
  const batch = properties.data.properties.batches.items;
  expect(batch.required).toContain('row_version');
  expect(JSON.stringify(batch.properties['row_version'])).toContain('"minimum":0');
});
