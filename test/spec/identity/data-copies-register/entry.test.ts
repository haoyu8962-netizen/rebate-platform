// B1-27c · adminCreateUserDataExport and adminListUserDataExports are served by the admin entry
// only, once each, with the request schemas generated from their contract operations, behind the
// admin login check; the contract no longer marks them planned (no database: unit test, no listen).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { NOW, type Response } from '../../admin/auth/kit.ts';
import {
  contract,
  CREATE_ERROR_CODES,
  EXPORTS,
  LIST_ERROR_CODES,
  operation,
  validate,
  type Method,
} from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const ROUTE = EXPORTS.replace('{user_id}', ':user_id');
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';

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
  const seen: { POST: RouteOptions[]; GET: RouteOptions[] } = { POST: [], GET: [] };
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url !== ROUTE) return;
      const methods = [route.method].flat();
      if (methods.includes('POST')) seen.POST.push(route);
      if (methods.includes('GET')) seen.GET.push(route);
    });
  await app.init();
  return { app, seen };
}

const METHODS: { method: Method; verb: 'POST' | 'GET' }[] = [
  { method: 'post', verb: 'POST' },
  { method: 'get', verb: 'GET' },
];

it('[AC-B1-27c#1] admin 入口各挂一次 POST / GET /admin/v1/users/{user_id}/data-exports 并带契约请求 schema；api / stream 入口都不挂', async () => {
  const admin = await boot('admin');
  try {
    for (const { method, verb } of METHODS) {
      const expected = routeSchemaOf((await operation(method)) as never);
      expect(admin.seen[verb], `admin 入口必须恰好挂一次 ${verb} 副本请求路由`).toHaveLength(1);
      const schema = admin.seen[verb][0]!.schema;
      expect(schema?.params, verb).toEqual(expected.params);
      if (method === 'post') expect(schema?.body).toEqual(expected.body);
      else expect(schema?.querystring).toEqual(expected.querystring);
    }
  } finally {
    await admin.app.close();
  }
  for (const entry of ['api', 'stream'] as const) {
    const other = await boot(entry);
    try {
      expect(other.seen, entry).toEqual({ POST: [], GET: [] });
      for (const { verb } of METHODS) {
        expect(
          other.app.getHttpAdapter().getInstance().hasRoute({ method: verb, url: ROUTE }),
          `${entry} ${verb}`,
        ).toBe(false);
      }
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-B1-27c#2] 要后台登录：不带 admin_token 时登记与列表都在处理前回 401 / 10001', async () => {
  const { app } = await boot('admin');
  try {
    for (const { method, verb } of METHODS) {
      expect(
        app.getHttpAdapter().getInstance().hasRoute({ method: verb, url: ROUTE }),
        `admin 入口必须挂载 ${verb} 副本请求路由`,
      ).toBe(true);
      const response = await app.inject({
        method: verb,
        url: EXPORTS.replace('{user_id}', USER),
        headers: {
          'x-trace-id': TRACE,
          ...(verb === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(verb === 'POST'
          ? {
              payload: JSON.stringify({
                reason: '企业微信核对注册时间与最近一笔订单号后确认本人申请副本',
                app_login_ok: true,
                phone_sms_ok: true,
              }),
            }
          : {}),
      });
      expect(response.statusCode, verb).toBe(401);
      expect(response.json()).toMatchObject({ code: 10001, trace_id: TRACE });
      await validate(response, method);
    }
  } finally {
    await app.close();
  }
});

// 保留原标题，错误码表以块内断言为准。
it('[AC-B1-27c#3] 契约 adminCreateUserDataExport / adminListUserDataExports 去掉 x-implementation: planned，错误码表不变', async () => {
  const path = (await contract()).paths[EXPORTS]!;
  expect(path.post!['x-implementation']).not.toBe('planned');
  expect(path.get!['x-implementation']).not.toBe('planned');
  expect([...(path.post!['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual(
    CREATE_ERROR_CODES.filter((code) => code !== 10003),
  );
  expect([...(path.get!['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual(LIST_ERROR_CODES);
});
