// B1-27i · adminDownloadUserDataExport is served by the admin entry only and listMyDataCopies /
// getMyDataCopyDownload by the api entry only, once each, with the request schemas generated from
// their contract operations; the download stays behind the admin login check; the contract and the
// generated planned list no longer mark the three planned (no database: unit test, no listen).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { NOW, type Response } from '../../admin/auth/kit.ts';
import { contract, operation, OPERATIONS, validate, type OperationKey } from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const EXPORT = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d02';
const KEYS: readonly OperationKey[] = ['admin', 'list', 'mine'];

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; body?: unknown; querystring?: unknown };
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): {
    getInstance(): {
      addHook(name: 'onRoute', hook: (route: RouteOptions) => void): unknown;
      hasRoute(options: { method: 'POST' | 'GET'; url: string }): boolean;
    };
  };
  inject(input: {
    method: 'POST' | 'GET';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

async function boot(entry: 'admin' | 'api' | 'stream') {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  const app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock(NOW),
    logger: memoryLogger().logger,
  });
  const seen: Record<OperationKey, RouteOptions[]> = { admin: [], list: [], mine: [] };
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      for (const key of KEYS) {
        const spec = OPERATIONS[key];
        if (route.url === spec.route && [route.method].flat().includes(spec.verb)) {
          seen[key].push(route);
        }
      }
    });
  await app.init();
  return { app, seen };
}

async function expectSchemas(seen: Record<OperationKey, RouteOptions[]>, keys: OperationKey[]) {
  for (const key of keys) {
    const spec = OPERATIONS[key];
    expect(seen[key], `必须恰好挂一次 ${spec.verb} ${spec.path}`).toHaveLength(1);
    const expected = routeSchemaOf((await operation(key)) as never);
    const schema = seen[key][0]!.schema;
    expect(schema?.params, `${spec.path} params`).toEqual(expected.params);
    expect(schema?.querystring, `${spec.path} querystring`).toEqual(expected.querystring);
    if (spec.verb === 'POST') expect(schema?.body, `${spec.path} body`).toEqual(expected.body);
  }
}

function hasRoute(app: App, key: OperationKey): boolean {
  const spec = OPERATIONS[key];
  return app.getHttpAdapter().getInstance().hasRoute({ method: spec.verb, url: spec.route });
}

it('[AC-B1-27i#1] admin 入口恰好挂一次 POST .../data-exports/{export_id}/download 并带契约请求 schema；两条用户侧路由不在 admin 入口', async () => {
  const admin = await boot('admin');
  try {
    await expectSchemas(admin.seen, ['admin']);
    expect(admin.seen.list).toEqual([]);
    expect(admin.seen.mine).toEqual([]);
    expect(hasRoute(admin.app, 'list')).toBe(false);
    expect(hasRoute(admin.app, 'mine')).toBe(false);
  } finally {
    await admin.app.close();
  }
});

it('[AC-B1-27i#2] api 入口各挂一次 GET /v1/me/data-copies 与 GET /v1/me/data-copies/{id}/download 并带契约请求 schema；后台下载不在 api 入口；stream 入口三条都不挂', async () => {
  const api = await boot('api');
  try {
    await expectSchemas(api.seen, ['list', 'mine']);
    expect(api.seen.admin).toEqual([]);
    expect(hasRoute(api.app, 'admin')).toBe(false);
  } finally {
    await api.app.close();
  }
  const stream = await boot('stream');
  try {
    expect(stream.seen).toEqual({ admin: [], list: [], mine: [] });
    for (const key of KEYS) expect(hasRoute(stream.app, key), key).toBe(false);
  } finally {
    await stream.app.close();
  }
});

it('[AC-B1-27i#3] 后台下载要后台登录：不带 admin_token 时在处理前回 401 / 10001', async () => {
  const { app } = await boot('admin');
  try {
    expect(hasRoute(app, 'admin'), 'admin 入口必须挂载后台副本下载路由').toBe(true);
    for (const payload of ['{}', JSON.stringify({ regenerate: true })]) {
      const response = await app.inject({
        method: 'POST',
        url: OPERATIONS.admin.path.replace('{user_id}', USER).replace('{export_id}', EXPORT),
        headers: { 'x-trace-id': TRACE, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode, payload).toBe(401);
      expect(response.json()).toMatchObject({ code: 10001, trace_id: TRACE });
      await validate(response, 'admin');
    }
  } finally {
    await app.close();
  }
});

// 保留原标题，错误码表以块内断言为准。
it('[AC-B1-27i#4] 契约三条操作去掉 x-implementation: planned（生成的 planned 清单同步），错误码表不变', async () => {
  const document = await contract();
  for (const key of KEYS) {
    const spec = OPERATIONS[key];
    const op = document.paths[spec.path]?.[spec.method];
    expect(op?.operationId, spec.path).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(
      [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b),
      spec.operationId,
    ).toEqual(key === 'admin' ? spec.errorCodes.filter((code) => code !== 10003) : spec.errorCodes);
    expect(plannedOperations.has(spec.operationId), spec.operationId).toBe(false);
  }
});
