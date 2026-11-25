// Unit tests of POST /admin/v1/auth/step-up's entry (CT-24zzv): the verification method is `method`
// or its legacy name `tier`; neither is 20001 [method] before the service is called; when both are
// sent and differ, `method` is the one handed to the service, once (never a second try with `tier`).
// The controller is built directly with a fake step-up service: no app, database or Redis.
import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import type { AdminStepUpTier } from '../../domain/permission-catalog.ts';
import type {
  AdminCaller,
  AdminStepUpService,
  StepUpResult,
} from '../../application/admin-step-up.ts';
import { AdminStepUpController } from './step-up.controller.ts';

const TRACE = 'trace-ct-24zzv';
const CODE = '123456';
const PRINCIPAL = {
  adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
  appId: 'ct-24zzv',
  sessionId: 'jti-ct-24zzv',
  isSuper: false,
};

function setup() {
  const calls: { caller: AdminCaller; method: AdminStepUpTier; code: string }[] = [];
  const service = {
    stepUp: (caller: AdminCaller, method: AdminStepUpTier, code: string) => {
      calls.push({ caller, method, code });
      const result: StepUpResult = {
        code: 0,
        grant: { step_up_token: 'token', tier: method, expire_at: '2026-11-25T10:05:00+08:00' },
      };
      return Promise.resolve(result);
    },
  } as unknown as AdminStepUpService;
  const headers: Record<string, string> = {};
  const reply = { header: (name: string, value: string) => (headers[name] = value) };
  const controller = new AdminStepUpController(service);
  const verify = (body: Record<string, unknown>) =>
    controller.verify(
      { id: TRACE, ip: '127.0.0.1', adminPrincipal: PRINCIPAL, body } as never,
      reply,
    );
  return { calls, headers, verify };
}

it.each(['totp', 'sms'] as const)(
  '[CT-24zzv] only method=%s → the service verifies that method once',
  async (method) => {
    const { calls, headers, verify } = setup();
    const response = await verify({ method, code: CODE });
    expect(response).toMatchObject({ code: 0, data: { tier: method }, trace_id: TRACE });
    expect(calls).toEqual([
      {
        caller: {
          appId: PRINCIPAL.appId,
          adminId: PRINCIPAL.adminId,
          sessionId: PRINCIPAL.sessionId,
          ip: '127.0.0.1',
        },
        method,
        code: CODE,
      },
    ]);
    expect(headers['Cache-Control']).toBe('no-store');
  },
);

it.each(['totp', 'sms'] as const)(
  '[CT-24zzv] only the legacy tier=%s → the service verifies it once',
  async (method) => {
    const { calls, verify } = setup();
    expect(await verify({ tier: method, code: CODE })).toMatchObject({ code: 0 });
    expect(calls.map((call) => call.method)).toEqual([method]);
  },
);

it('[CT-24zzv] neither method nor tier → 20001 with data.fields exactly [method], service not called', async () => {
  const { calls, verify } = setup();
  const thrown = await verify({ code: CODE }).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(HttpException);
  const exception = thrown as HttpException;
  expect(exception.getStatus()).toBe(400);
  expect(exception.getResponse()).toEqual({
    code: 20001,
    msg: '参数校验失败',
    data: { fields: ['method'] },
    trace_id: TRACE,
  });
  expect(calls).toEqual([]);
});

it.each([
  ['totp', 'sms'],
  ['sms', 'totp'],
] as const)(
  '[CT-24zzv] method=%s with tier=%s → only method is verified, exactly once',
  async (method, tier) => {
    const { calls, verify } = setup();
    expect(await verify({ method, tier, code: CODE })).toMatchObject({
      code: 0,
      data: { tier: method },
    });
    expect(calls.map((call) => call.method)).toEqual([method]);
  },
);

it('[CT-24zzv] method=sms with tier=totp and a refused code → 20002, no second try with tier', async () => {
  const methods: AdminStepUpTier[] = [];
  const service = {
    stepUp: (_caller: AdminCaller, method: AdminStepUpTier) => {
      methods.push(method);
      const result: StepUpResult = { code: 20002 };
      return Promise.resolve(result);
    },
  } as unknown as AdminStepUpService;
  const controller = new AdminStepUpController(service);
  const thrown = await controller
    .verify(
      {
        id: TRACE,
        ip: '127.0.0.1',
        adminPrincipal: PRINCIPAL,
        body: { method: 'sms', tier: 'totp', code: CODE },
      } as never,
      { header: () => undefined },
    )
    .catch((error: unknown) => error);
  expect((thrown as HttpException).getResponse()).toMatchObject({ code: 20002 });
  expect(methods).toEqual(['sms']);
});

it.each(['totp', 'sms'] as const)(
  '[CT-24zzv] method and tier both %s → verified once',
  async (method) => {
    const { calls, verify } = setup();
    expect(await verify({ method, tier: method, code: CODE })).toMatchObject({ code: 0 });
    expect(calls.map((call) => call.method)).toEqual([method]);
  },
);
