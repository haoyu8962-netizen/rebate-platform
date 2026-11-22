// Unit tests of the step-up tokens and the permission guard over an in-memory Redis double that
// applies the guard's scripts by their effect; the scripts themselves run against Redis in the
// rule tests (test/spec/admin/permissions/**).
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { FixedClock, type RedisNamespace, type RedisScriptOptions } from '../../platform/index.ts';
import {
  createAdminPermissionGuard,
  createAdminStepUpTokens,
  type AdminBusinessResponse,
  type AdminPermissionPrincipal,
} from './permission-guard.ts';

function memoryRedis(): RedisNamespace {
  const data = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(data.get(key) ?? null),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    eval: (script: string, options: RedisScriptOptions) => {
      const [first, second] = options.keys;
      if (script.includes("'NX'")) {
        if (!data.has(first!) || data.has(second!)) return Promise.resolve(0);
        data.set(second!, '1');
        return Promise.resolve(1);
      }
      data.delete(first!);
      return Promise.resolve(1);
    },
  };
}

const SUCCESS: AdminBusinessResponse = { statusCode: 200, body: { code: 0 } };

function setup() {
  const clock = new FixedClock('2026-10-09T02:00:00.000Z');
  const redis = memoryRedis();
  const tokens = createAdminStepUpTokens({ clock, redis });
  const guard = createAdminPermissionGuard({ clock, redis });
  const principal: AdminPermissionPrincipal = {
    appId: 'couli',
    adminId: randomUUID(),
    sessionId: randomUUID(),
    isSuper: false,
    permissions: ['fund.adjust', 'pii.reveal_phone', 'user.list'],
    hasVerifyPhone: true,
  };
  return { clock, tokens, guard, principal };
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), body: http.getResponse() };
}

it('[AC-F1-10c-UNIT#2] a write list releases the claim after business failure and consumes only on success', async () => {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'sms' });
  const request = {
    principal: s.principal,
    permission: ['fund.writeoff', 'fund.adjust'],
    headers: { 'x-step-up-token': grant.step_up_token },
  };
  const failure = new Error('business failed');
  await expect(s.guard.run(request, () => Promise.reject(failure))).rejects.toBe(failure);
  const rejectedResult: AdminBusinessResponse = { statusCode: 409, body: { code: 20902 } };
  expect(await s.guard.run(request, async () => rejectedResult)).toBe(rejectedResult);
  const business = vi.fn(async () => SUCCESS);
  expect(await s.guard.run(request, business)).toBe(SUCCESS);
  expect((await rejection(s.guard.run(request, business))).body).toMatchObject({
    code: 10003,
    data: { tier: 'sms' },
  });
  expect(business).toHaveBeenCalledOnce();
});

it('[AC-F1-06l#14] tokens are opaque, random and expire five minutes after issue by the Clock', async () => {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  expect(grant.tier).toBe('totp');
  expect(grant.expire_at).toBe('2026-10-09T02:05:00.000Z');
  expect(grant.step_up_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await s.tokens.issue({ ...s.principal, tier: 'totp' })).step_up_token).not.toBe(
    grant.step_up_token,
  );
});

it('[AC-F1-06l#21] a point that is not ticked is 10403 with a trace id', async () => {
  const s = setup();
  const business = vi.fn(async () => SUCCESS);
  const result = await rejection(
    s.guard.run(
      { principal: s.principal, permission: 'fund.writeoff', headers: {}, traceId: 't-1' },
      business,
    ),
  );
  expect(result).toEqual({
    status: 403,
    body: expect.objectContaining({
      code: 10403,
      data: { reason: 'admin_permission_denied' },
      trace_id: 't-1',
    }),
  });
  expect(business).not.toHaveBeenCalled();
});

it('[AC-F1-06l#24] an sms point on an account without verify phone names the reason', async () => {
  const s = setup();
  const result = await rejection(
    s.guard.run(
      {
        principal: { ...s.principal, hasVerifyPhone: false },
        permission: 'fund.adjust',
        headers: {},
      },
      async () => SUCCESS,
    ),
  );
  expect(result.body).toMatchObject({
    code: 10003,
    data: { tier: 'sms', reason: 'verify_phone_missing' },
  });
});

it('[AC-F1-06l#26] [AC-F1-06l#27] success consumes the token; a failed answer keeps it', async () => {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'sms' });
  const request = {
    principal: s.principal,
    permission: 'fund.adjust',
    headers: { 'x-step-up-token': grant.step_up_token },
  };
  const failed = { statusCode: 200, body: { code: 20001 } };
  expect(await s.guard.run(request, async () => failed)).toEqual(failed);
  await expect(
    s.guard.run(request, async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(await s.guard.run(request, async () => SUCCESS)).toEqual(SUCCESS);
  const replay = await rejection(s.guard.run(request, async () => SUCCESS));
  expect(replay.body).toMatchObject({ code: 10003, data: { tier: 'sms' } });
});

it('[AC-F1-06l#25] a token of another tier, session or an expired one is refused', async () => {
  const s = setup();
  const totp = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  const sms = await s.tokens.issue({ ...s.principal, tier: 'sms' });
  const run = (permission: string, token: string, principal = s.principal) =>
    rejection(
      s.guard.run(
        { principal, permission, headers: { 'x-step-up-token': token } },
        async () => SUCCESS,
      ),
    );
  expect((await run('fund.adjust', totp.step_up_token)).body).toMatchObject({
    code: 10003,
    data: { tier: 'sms' },
  });
  expect(
    (await run('fund.adjust', sms.step_up_token, { ...s.principal, sessionId: randomUUID() })).body,
  ).toMatchObject({ code: 10003 });
  s.clock.advanceMs(300_000);
  expect((await run('fund.adjust', sms.step_up_token)).body).toMatchObject({ code: 10003 });
});

it('[AC-F1-06l#28] an operation without step-up runs and leaves the token alone', async () => {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  const headers = { 'x-step-up-token': grant.step_up_token };
  expect(
    await s.guard.run(
      { principal: s.principal, permission: 'user.list', headers },
      async () => SUCCESS,
    ),
  ).toEqual(SUCCESS);
  expect(
    await s.guard.run(
      { principal: s.principal, permission: 'pii.reveal_phone', headers },
      async () => SUCCESS,
    ),
  ).toEqual(SUCCESS);
});

it('[AC-B2-02ze-UNIT#1] a thrown error whose outcome is unknown keeps the claim: the token is void, a retry with it is 10003 and the business does not run again', async () => {
  const lost = [
    Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }),
    new Error('Connection terminated unexpectedly'),
    Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    }),
    Object.assign(new Error('the transaction outcome is unknown'), { code: 'outcome_unknown' }),
  ];
  for (const failure of lost) {
    const s = setup();
    const grant = await s.tokens.issue({ ...s.principal, tier: 'sms' });
    const request = {
      principal: s.principal,
      permission: 'fund.adjust',
      headers: { 'x-step-up-token': grant.step_up_token },
    };
    await expect(s.guard.run(request, () => Promise.reject(failure))).rejects.toBe(failure);
    const business = vi.fn(async () => SUCCESS);
    const retry = await rejection(s.guard.run(request, business));
    expect(retry.body).toMatchObject({ code: 10003, data: { tier: 'sms' } });
    expect(business).not.toHaveBeenCalled();
  }
});

/** Runs one guarded operation that throws `failure`, then retries with the same token. */
async function retryAfter(failure: unknown) {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'sms' });
  const request = {
    principal: s.principal,
    permission: 'fund.adjust',
    headers: { 'x-step-up-token': grant.step_up_token },
  };
  await expect(s.guard.run(request, () => Promise.reject(failure))).rejects.toBe(failure);
  const business = vi.fn(async () => SUCCESS);
  const retry = await s.guard.run(request, business).then(
    (result) => ({ result, thrown: undefined as unknown }),
    (thrown: unknown) => ({ result: undefined, thrown }),
  );
  return { business, retry };
}

/** SQLSTATE errors as node-postgres throws them (messages that name no dropped connection). */
const sqlstate = (code: string): Error =>
  Object.assign(new Error(`synthetic server error ${code}`), { code });

it('[AC-B2-02ze-R3#4] money r1 第 4 条：业务抛语句超时 57014（可能在提交途中或提交后）不释放令牌，同一令牌重试是 10003、业务不再执行', async () => {
  const { business, retry } = await retryAfter(
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
  );
  expect(retry.thrown).toBeInstanceOf(HttpException);
  expect((retry.thrown as HttpException).getResponse()).toMatchObject({
    code: 10003,
    data: { tier: 'sms' },
  });
  expect(business).not.toHaveBeenCalled();
});

for (const code of ['57P01', '57P02', '57P03']) {
  it(`[AC-B2-02ze-MUST#4] 第④条 正例：提交时 SQLSTATE ${code} 按结果未知，不释放令牌，同一令牌重试是 10003、业务不再执行`, async () => {
    const { business, retry } = await retryAfter(sqlstate(code));
    expect(retry.thrown).toBeInstanceOf(HttpException);
    expect((retry.thrown as HttpException).getResponse()).toMatchObject({
      code: 10003,
      data: { tier: 'sms' },
    });
    expect(business).not.toHaveBeenCalled();
  });
}

it('[AC-B2-02ze-MUST#4] 第④条 反例：普通业务错误（以及唯一约束、序列化失败）已确认回滚，释放令牌，同一令牌重试照常执行', async () => {
  for (const failure of [
    new Error('synthetic business failure'),
    sqlstate('23505'),
    sqlstate('40001'),
  ]) {
    const { business, retry } = await retryAfter(failure);
    expect(retry.thrown, String(failure)).toBeUndefined();
    expect(retry.result).toBe(SUCCESS);
    expect(business).toHaveBeenCalledTimes(1);
  }
});
