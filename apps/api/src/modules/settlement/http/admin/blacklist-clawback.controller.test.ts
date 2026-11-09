// B2-04zzl 控制器单元测试（不连库、不 listen）：契约的检查顺序是 权限 10403 → 二次验证 10003 → 请求体 20001。
// 路由只挂路径与请求头 schema，请求体在 guard 的回调里校验；后面的差错单与订单检查由集成规则测试钉。
import { HttpException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  AdminOperationGuard,
  FixedClock,
  createRootLogger,
  loadConfig,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import type { BlacklistClawbackDeps } from '../../application/blacklist-clawback.ts';
import {
  AdminBlacklistClawbackController,
  type AdminBlacklistClawbackRawReply,
  type AdminBlacklistClawbackRequest,
} from './blacklist-clawback.controller.ts';

const DIFF = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
const TRACE = 'trace-b2-04zzl';
const ROUTE = '/admin/v1/recon-diffs/:recon_diff_id/blacklist-clawback';
const STORED = JSON.stringify({ code: 0, msg: '', data: {}, trace_id: TRACE });

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];
  readonly answers: AdminOperationResponse[] = [];
  readonly #refusal: HttpException | null;

  constructor(refusal: HttpException | null = null) {
    super();
    this.#refusal = refusal;
  }

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    if (this.#refusal !== null) throw this.#refusal;
    const answer = await business({
      adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02',
      appId: 'b2-04zzl-ctrl',
      isSuper: false,
      loginName: 'a',
    });
    this.answers.push(answer);
    return answer;
  }
}

function setup(refusal: HttpException | null = null) {
  const guard = new FakeGuard(refusal);
  const executeInTransaction = vi.fn(() => Promise.resolve({ status: 200, body: STORED }));
  const deps = { idempotency: { executeInTransaction } } as unknown as BlacklistClawbackDeps;
  return {
    guard,
    executeInTransaction,
    controller: new AdminBlacklistClawbackController(guard, deps),
  };
}

const request = {
  id: TRACE,
  ip: '192.0.2.1',
  headers: { 'idempotency-key': 'key-b2-04zzl' },
} as unknown as AdminBlacklistClawbackRequest;

function reply() {
  const sent: { code?: number; payload?: string } = {};
  const raw: AdminBlacklistClawbackRawReply = {
    header: () => raw,
    code: (statusCode) => {
      sent.code = statusCode;
      return raw;
    },
    type: () => raw,
    send: (payload) => {
      sent.payload = payload;
      return undefined;
    },
  };
  return { raw, sent };
}

async function refusalOf(answer: Promise<unknown>): Promise<HttpException> {
  const error: unknown = await answer.then(
    () => {
      throw new Error('expected a refusal');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

it('[AC-B2-04zzl#U4] admin 入口的路由只挂路径与请求头 schema，不挂 body：Fastify 不会抢在权限与二次验证之前回 20001', async () => {
  app = await createHttpApp('admin', {
    config: loadConfig({ APP_ENV: 'test', ADMIN_IP_ALLOWLIST: '127.0.0.1' }),
    clock: new FixedClock('2026-11-09T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' }),
  });
  const schemas: Record<string, unknown>[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === ROUTE && route.method === 'POST') {
        schemas.push(route.schema as Record<string, unknown>);
      }
    });
  await app.init();
  expect(schemas).toHaveLength(1);
  expect(schemas[0]).not.toHaveProperty('body');
  expect(schemas[0]).toMatchObject({
    params: { required: ['recon_diff_id'] },
    headers: { required: ['idempotency-key'] },
  });
});

it.each([
  ['无权限 10403', 403, { code: 10403, data: { reason: 'admin_permission_denied' } }],
  ['无二次验证 10003', 403, { code: 10003, data: { tier: 'totp' } }],
] as const)(
  '[AC-B2-04zzl#U5] %s 且 note 非法：guard 的拒绝原样抛出，不校验请求体、不进用例',
  async (_name, status, envelope) => {
    const denied = new HttpException({ ...envelope, msg: 'x', trace_id: TRACE }, status);
    const { guard, executeInTransaction, controller } = setup(denied);
    const http = reply();
    for (const body of [{ note: '' }, { note: 'x'.repeat(201) }, { clawed_back_fen: 1 }, 'nope']) {
      expect(await refusalOf(controller.confirm(request, DIFF, body, http.raw))).toBe(denied);
    }
    expect(guard.calls).toHaveLength(4);
    expect(guard.calls[0]).toEqual({ request, permission: 'order.blacklist_clawback' });
    expect(executeInTransaction).not.toHaveBeenCalled();
    expect(http.sent).toEqual({});
  },
);

it.each([
  ['空串', { note: '' }, ['note']],
  ['201 字', { note: 'x'.repeat(201) }, ['note']],
  ['不是字符串', { note: 1 }, ['note']],
  ['多带的键', { clawed_back_fen: 1 }, ['clawed_back_fen']],
  ['不是对象', 'nope', ['body']],
  ['没有请求体', undefined, ['body']],
] as const)(
  '[AC-B2-04zzl#U6] guard 通过后请求体不合契约（%s）：20001 与 data.fields，不进用例，guard 见到非 0 码（不消费令牌）',
  async (_name, body, fields) => {
    const { guard, executeInTransaction, controller } = setup();
    const http = reply();
    await controller.confirm(request, DIFF, body, http.raw);
    expect(http.sent.code).toBe(400);
    expect(JSON.parse(http.sent.payload ?? '')).toMatchObject({
      code: 20001,
      data: { fields },
      trace_id: TRACE,
    });
    expect(guard.answers).toHaveLength(1);
    expect(guard.answers[0]?.statusCode).toBe(400);
    expect(guard.answers[0]?.body).toMatchObject({ code: 20001 });
    expect(executeInTransaction).not.toHaveBeenCalled();
  },
);

it.each([
  ['{}', {}],
  ['恰好 200 字的 note', { note: 'x'.repeat(200) }],
  ['四字节字符按 1 字计的 200 字 note', { note: '😀'.repeat(200) }],
])(
  '[AC-B2-04zzl#U7] guard 通过且请求体合契约（%s）：原样交给用例，发出用例的字节',
  async (_name, body) => {
    const { executeInTransaction, controller } = setup();
    const http = reply();
    await controller.confirm(request, DIFF, body, http.raw);
    expect(executeInTransaction).toHaveBeenCalledTimes(1);
    expect(executeInTransaction.mock.calls[0]).toMatchObject([
      {
        method: 'POST',
        path: `/admin/v1/recon-diffs/${DIFF}/blacklist-clawback`,
        key: 'key-b2-04zzl',
        body,
      },
      expect.any(Function),
    ]);
    expect(http.sent).toEqual({ code: 200, payload: STORED });
  },
);
