// B1-27b · adminEditUserProfile is served by the admin entry only, once, with the request schema
// generated from its contract operation, behind the admin login check; the contract no longer
// marks it planned (no database: unit test, no listen).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { NOW, type Response } from '../../admin/auth/kit.ts';
import { contract, operation, PROFILE, validate } from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const ROUTE = PROFILE.replace('{user_id}', ':user_id');

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
      hasRoute(options: { method: 'PATCH'; url: string }): boolean;
    };
  };
  inject(input: {
    method: 'PATCH';
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
      if (route.url === ROUTE && [route.method].flat().includes('PATCH')) seen.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B1-27b#1] admin 入口挂一次 PATCH /admin/v1/users/{user_id}/profile 并带契约请求 schema；api / stream 入口都不挂', async () => {
  const expected = routeSchemaOf((await operation()) as never);
  const admin = await boot('admin');
  try {
    expect(admin.seen, 'admin 入口必须恰好挂一次编辑会员信息路由').toHaveLength(1);
    expect(admin.seen[0]!.schema?.params).toEqual(expected.params);
    expect(admin.seen[0]!.schema?.body).toBeDefined();
  } finally {
    await admin.app.close();
  }
  for (const entry of ['api', 'stream'] as const) {
    const other = await boot(entry);
    try {
      expect(other.seen, entry).toEqual([]);
      expect(
        other.app.getHttpAdapter().getInstance().hasRoute({ method: 'PATCH', url: ROUTE }),
        entry,
      ).toBe(false);
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-B1-27b#2] 要后台登录：不带 admin_token 在处理前回 401 / 10001', async () => {
  const { app } = await boot('admin');
  try {
    expect(
      app.getHttpAdapter().getInstance().hasRoute({ method: 'PATCH', url: ROUTE }),
      'admin 入口必须挂载编辑会员信息路由',
    ).toBe(true);
    const response = await app.inject({
      method: 'PATCH',
      url: PROFILE.replace('{user_id}', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01'),
      headers: { 'content-type': 'application/json', 'x-trace-id': TRACE },
      payload: JSON.stringify({ nickname: '小狸', reason: '用户在企业微信说明原昵称误填' }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001, trace_id: TRACE });
    await validate(response);
  } finally {
    await app.close();
  }
});

// 保留原标题，错误码表以块内断言为准。
it('[AC-B1-27b#3] 契约 adminEditUserProfile 去掉 x-implementation: planned，错误码表不变', async () => {
  const op = (await contract()).paths[PROFILE]!.patch!;
  expect(op['x-implementation']).not.toBe('planned');
  expect([...(op['x-error-codes'] ?? [])].sort((a, b) => a - b)).toEqual([
    10001, 10403, 20001, 30411, 44001,
  ]);
});
