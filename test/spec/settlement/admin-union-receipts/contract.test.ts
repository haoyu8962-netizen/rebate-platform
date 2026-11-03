// B2-04zr contract and mounting rule test (claude-independent, SPEC_REF 6f50a051):
// adminListUnionReceipts, adminCreateUnionReceipt and adminReverseUnionReceipt are implemented —
// contracts/openapi.yaml and the generated planned list no longer mark them planned; x-auth,
// x-idempotent and x-error-codes stay as CT-24zh fixed them — and the admin entry serves each exactly
// once with the contract's request schema; the api entry does not serve them. No database (unit
// test, no listen). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { NOW, contractPaths, type ContractOperation } from '../../ledger/admin-recon-diffs/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

type Method = 'GET' | 'POST';

const OPERATIONS: readonly {
  readonly id: string;
  readonly path: string;
  readonly route: string;
  readonly method: Method;
  readonly idempotent: true | undefined;
  readonly codes: readonly number[];
}[] = [
  {
    id: 'adminListUnionReceipts',
    path: '/admin/v1/union-receipts',
    route: '/admin/v1/union-receipts',
    method: 'GET',
    idempotent: undefined,
    codes: [10001, 10403, 20001],
  },
  {
    id: 'adminCreateUnionReceipt',
    path: '/admin/v1/union-receipts',
    route: '/admin/v1/union-receipts',
    method: 'POST',
    idempotent: true,
    codes: [10001, 10003, 10403, 20001, 20901, 40901],
  },
  {
    id: 'adminReverseUnionReceipt',
    path: '/admin/v1/union-receipts/{receipt_id}/reverse',
    route: '/admin/v1/union-receipts/:receipt_id/reverse',
    method: 'POST',
    idempotent: true,
    codes: [10001, 10003, 10403, 20001, 20901, 20902, 40901],
  },
];

type ReceiptOperation = ContractOperation & { readonly 'x-idempotent'?: unknown };

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

it('[AC-B2-04zr#1] 三个操作去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-idempotent、x-error-codes 不变；admin 入口各恰好挂一次并带契约的请求 schema（请求体、路径与查询参数、请求头），api 入口不挂', async () => {
  const paths = await contractPaths();
  const admin = await boot('admin');
  try {
    for (const item of OPERATIONS) {
      const op: ReceiptOperation | undefined = paths[item.path]?.[item.method.toLowerCase()];
      expect(op?.operationId).toBe(item.id);
      expect(op?.['x-implementation'], item.id).not.toBe('planned');
      expect(op?.['x-auth'], item.id).toBe('admin');
      expect(op?.['x-idempotent'], item.id).toBe(item.idempotent);
      const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
      expect(codes, item.id).toEqual(item.codes);
      expect(plannedOperations.has(item.id), item.id).toBe(false);

      const routes = mounted(admin.seen, item.route, item.method);
      expect(routes, `admin 入口必须恰好挂一次 ${item.method} ${item.route}`).toHaveLength(1);
      const expected = routeSchemaOf(op as never);
      const schema = routes[0]!.schema;
      expect(schema?.body, `${item.id} body`).toEqual(expected.body);
      expect(schema?.params, `${item.id} params`).toEqual(expected.params);
      expect(schema?.querystring, `${item.id} querystring`).toEqual(expected.querystring);
      expect(schema?.headers, `${item.id} headers`).toEqual(expected.headers);
    }
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    const server = api.app.getHttpAdapter().getInstance();
    for (const item of OPERATIONS) {
      expect(mounted(api.seen, item.route, item.method), item.id).toEqual([]);
      expect(server.hasRoute({ method: item.method, url: item.route }), item.id).toBe(false);
    }
  } finally {
    await api.app.close();
  }
});
