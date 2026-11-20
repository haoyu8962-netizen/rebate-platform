import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  idempotencyPostMissTransaction,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import { createStepUpCheck } from './step-up-verify.ts';
import { RiskModule } from '../../risk/index.ts';

vi.mock('../../platform/index.ts', async (original) => ({
  ...(await original<typeof import('../../platform/index.ts')>()),
  idempotencyPostMissTransaction: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(idempotencyPostMissTransaction).mockReset();
});

it('[AC-B1-02y#first-binding] first phone binding passes without withStepUp or a Redis reservation', async () => {
  vi.spyOn(RiskModule, 'hasHttpRequestScope').mockReturnValue(true);
  const query = {
    withSchema: vi.fn().mockReturnThis(),
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue({ phone_hmac: null }),
  };
  vi.mocked(idempotencyPostMissTransaction).mockReturnValue(query as never);
  const namespace = vi.fn();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const check = createStepUpCheck({
    keys: {
      kid: 'unit',
      privateKey: pair.privateKey,
      publicKeys: new Map([['unit', pair.publicKey]]),
    },
    clock: new FixedClock('2026-10-17T00:00:00.000Z'),
    redis: { namespace } as unknown as RedisHandle,
    logger: { warn: vi.fn() } as unknown as RootLogger,
  });

  await expect(
    check({
      appId: 'couli',
      actor: { userId: '019a0000-0000-7000-8000-000000000010', deviceId: null, phoneHmac: null },
      method: 'POST',
      path: '/v1/me/phone',
      key: 'first-binding',
      body: {},
      traceId: 'first-binding',
    }),
  ).resolves.toBeUndefined();
  expect(query.withSchema).toHaveBeenCalledWith('app');
  expect(query.selectFrom).toHaveBeenCalledWith('users');
  expect(query.where.mock.calls).toEqual([
    ['app_id', '=', 'couli'],
    ['id', '=', '019a0000-0000-7000-8000-000000000010'],
  ]);
  expect(namespace).not.toHaveBeenCalled();
});

it('[AC-B1-02zzzc#unit] POST /v1/withdrawals is no step-up operation: passes in HTTP without withStepUp, no Redis', async () => {
  const namespace = vi.fn();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const check = createStepUpCheck({
    keys: {
      kid: 'unit',
      privateKey: pair.privateKey,
      publicKeys: new Map([['unit', pair.publicKey]]),
    },
    clock: new FixedClock('2026-11-15T00:00:00.000Z'),
    redis: { namespace } as unknown as RedisHandle,
    logger: { warn: vi.fn() } as unknown as RootLogger,
  });
  vi.spyOn(RiskModule, 'hasHttpRequestScope').mockReturnValue(true);
  await expect(
    check({
      appId: 'couli',
      actor: { userId: '019a0000-0000-7000-8000-000000000010', deviceId: null, phoneHmac: null },
      method: 'POST',
      path: '/v1/withdrawals',
      key: 'no-step-up',
      body: { amount_fen: 1000 },
      traceId: 'no-step-up',
    }),
  ).resolves.toBeUndefined();
  expect(idempotencyPostMissTransaction).not.toHaveBeenCalled();
  expect(namespace).not.toHaveBeenCalled();
});

it.each([
  ['PUT', '/v1/me/payout-account'],
  ['POST', '/v1/me/phone'],
  ['POST', '/v1/me/deletion'],
] as const)(
  '[AC-B1-02y#http-scope] %s %s skips non-HTTP calls but rejects HTTP without withStepUp',
  async (method, path) => {
    const namespace = vi.fn();
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const check = createStepUpCheck({
      keys: {
        kid: 'unit',
        privateKey: pair.privateKey,
        publicKeys: new Map([['unit', pair.publicKey]]),
      },
      clock: new FixedClock('2026-10-17T00:00:00.000Z'),
      redis: { namespace } as unknown as RedisHandle,
      logger: { warn: vi.fn() } as unknown as RootLogger,
    });
    const command = {
      appId: 'couli',
      actor: { userId: '019a0000-0000-7000-8000-000000000010', deviceId: null, phoneHmac: null },
      method,
      path,
      key: 'http-scope',
      body: {},
      traceId: 'http-scope',
    };

    expect(RiskModule.hasHttpRequestScope()).toBe(false);
    await expect(check(command)).resolves.toBeUndefined();
    expect(idempotencyPostMissTransaction).not.toHaveBeenCalled();
    expect(namespace).not.toHaveBeenCalled();

    vi.spyOn(RiskModule, 'hasHttpRequestScope').mockReturnValue(true);
    const query = {
      withSchema: vi.fn().mockReturnThis(),
      selectFrom: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ phone_hmac: 'bound-phone' }),
    };
    vi.mocked(idempotencyPostMissTransaction).mockReturnValue(query as never);
    await expect(check(command)).rejects.toMatchObject({ code: 10003, statusCode: 403 });
    expect(namespace).not.toHaveBeenCalled();
  },
);
