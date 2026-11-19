// B1-02zzzb (BR-ID-08: any step-up failure is 10003, no reason told apart): the 10003 of
// PUT /v1/me/payout-account when the token's digest does not bind the account (or there is none)
// is stage ⑫'s 10003 body byte for byte apart from trace_id. Stage ⑫'s body is what the global
// error filter writes for its RequestRejection: status statusCode, { code, msg: message, trace_id }
// and no data (platform/http/request-checks.ts).
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock, type RedisHandle, type RootLogger } from '../../../platform/index.ts';
import { RiskModule } from '../../../risk/index.ts';
import { STEP_UP_MISMATCH } from '../../application/payout-account.ts';
import { createStepUpCheck, withStepUp } from '../../application/step-up-verify.ts';
import { STEP_UP_FAILURE } from '../../domain/step-up-digest.ts';
import { handlerResult } from './payout-account.controller.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const USER = '019a0000-0000-7000-8000-000000000010';

/** Stage ⑫'s rejections of PUT /v1/me/payout-account, as the global error filter answers them. */
async function stageTwelveBodies(traceId: string) {
  vi.spyOn(RiskModule, 'hasHttpRequestScope').mockReturnValue(true);
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const check = createStepUpCheck({
    keys: {
      kid: 'unit',
      privateKey: pair.privateKey,
      publicKeys: new Map([['unit', pair.publicKey]]),
    },
    clock: new FixedClock('2026-11-14T04:00:00.000Z'),
    redis: { namespace: vi.fn() } as unknown as RedisHandle,
    logger: { warn: vi.fn() } as unknown as RootLogger,
  });
  const command = {
    appId: 'couli',
    actor: { userId: USER, deviceId: 'd-1', phoneHmac: null },
    method: 'PUT' as const,
    path: '/v1/me/payout-account',
    key: 'k-1',
    body: {},
    traceId,
  };
  const rejections: unknown[] = [];
  // No step-up context at all, and a token the verifier refuses.
  await check(command).catch((error: unknown) => rejections.push(error));
  await withStepUp(
    {
      headers: { 'x-step-up-token': 'not-a-token' },
      principal: { uid: USER, app_id: 'couli', sid: 's-1', device_id: 'd-1', scp: 'app' } as never,
    },
    async () => {
      await check(command);
      throw new Error('stage ⑫ passed');
    },
  ).catch((error: unknown) => rejections.push(error));
  return rejections.map((error) => {
    const { code, statusCode, message } = error as {
      code: number;
      statusCode: number;
      message: string;
    };
    return { status: statusCode, envelope: { code, msg: message, trace_id: traceId } };
  });
}

it("[AC-B1-02zzzb#6] payout account: the digest mismatch 10003 is stage ⑫'s 10003 body (status, code, msg, no data)", async () => {
  const bodies = await stageTwelveBodies('trace-1');
  expect(bodies).toHaveLength(2);
  const mismatch = handlerResult(STEP_UP_MISMATCH, 'trace-1');
  for (const body of bodies) expect(mismatch).toStrictEqual(body);
  expect(mismatch).toStrictEqual({
    status: STEP_UP_FAILURE.status,
    envelope: { code: 10003, msg: STEP_UP_FAILURE.msg, trace_id: 'trace-1' },
  });
  expect(JSON.stringify(mismatch.envelope)).toBe(
    JSON.stringify({ code: 10003, msg: STEP_UP_FAILURE.msg, trace_id: 'trace-1' }),
  );
});
