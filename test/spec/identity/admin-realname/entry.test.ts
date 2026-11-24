// B1-27a · adminCorrectUserRealname is served by the admin entry only, once, with the request schema
// generated from its contract operation, behind the admin login check; the contract no longer
// marks it planned (no database: unit test, no listen).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { NOW, type Response } from '../../admin/auth/kit.ts';
import { contract, CORRECTION, ERROR_CODES, operation, validate } from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const ROUTE = CORRECTION.replace('{user_id}', ':user_id');

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; body?: unknown };
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
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
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

it('[AC-B1-27a#1] admin 入口挂一次 POST /admin/v1/users/{user_id}/realname-correction 并带契约请求 schema；api / stream 入口都不挂', async () => {
  const expected = routeSchemaOf((await operation()) as never);
  const admin = await boot('admin');
  try {
    expect(admin.seen, 'admin 入口必须恰好挂一次实名更正路由').toHaveLength(1);
    expect(admin.seen[0]!.schema?.params).toEqual(expected.params);
    expect(admin.seen[0]!.schema?.body).toEqual(expected.body);
  } finally {
    await admin.app.close();
  }
  for (const entry of ['api', 'stream'] as const) {
    const other = await boot(entry);
    try {
      expect(other.seen, entry).toEqual([]);
      expect(
        other.app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: ROUTE }),
        entry,
      ).toBe(false);
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-B1-27a#2] 要后台登录：不带 admin_token 在处理前回 401 / 10001', async () => {
  const { app } = await boot('admin');
  try {
    expect(
      app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: ROUTE }),
      'admin 入口必须挂载实名更正路由',
    ).toBe(true);
    const response = await app.inject({
      method: 'POST',
      url: CORRECTION.replace('{user_id}', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01'),
      headers: { 'content-type': 'application/json', 'x-trace-id': TRACE },
      payload: JSON.stringify({
        name: '林小雨',
        id_no: '11010519491231002X',
        reason: '企业微信核对注册手机号与最近一笔订单号',
      }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001, trace_id: TRACE });
    await validate(response);
  } finally {
    await app.close();
  }
});

// 保留原标题，错误码表以块内断言为准。
it('[AC-B1-27a#3] 契约 adminCorrectUserRealname 去掉 x-implementation: planned，错误码表不变', async () => {
  const op = (await contract()).paths[CORRECTION]!.post!;
  expect(op['x-implementation']).not.toBe('planned');
  expect([...(op['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual(
    ERROR_CODES.filter((code) => code !== 10003),
  );
});
