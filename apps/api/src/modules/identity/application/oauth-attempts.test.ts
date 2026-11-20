import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  RedisClosedError,
  RedisUnavailableError,
  type RedisHandle,
  type RedisNamespace,
  type TokenPrincipal,
} from '../../platform/index.ts';
import { createOauthAttemptService, type OauthAttemptBinding } from './oauth-attempts.ts';

const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};
const DEVICE = { appId: 'couli', deviceId: PRINCIPAL.device_id };

/** In-memory namespace; eval stands in for the compare-and-set script (ARGV[2] → ARGV[3]). */
function memoryRedis() {
  const values = new Map<string, string>();
  const ttls: number[] = [];
  let closed = false;
  const namespace = (name: string): RedisNamespace => {
    if (closed) throw new RedisClosedError();
    return {
      async get(key) {
        return values.get(`${name}:${key}`) ?? null;
      },
      async set(key, value, ttlSeconds) {
        ttls.push(ttlSeconds);
        values.set(`${name}:${key}`, value);
      },
      async eval(_script, options) {
        const key = `${name}:${options.keys[0]}`;
        if (values.get(key) !== options.args[0]) return 0;
        ttls.push(options.ttlSeconds);
        values.set(key, options.args[1] ?? '');
        return 1;
      },
    };
  };
  const handle: RedisHandle = {
    namespace,
    async close() {
      closed = true;
    },
    async onApplicationShutdown() {
      closed = true;
    },
  };
  return { handle, values, ttls };
}

/** A Kysely stand-in for the one users read (phone_hmac by app and id). */
function usersDb(phoneHmac: string | null | undefined) {
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => (phoneHmac === undefined ? undefined : { phone_hmac: phoneHmac }),
  };
  return { selectFrom: vi.fn(() => chain) };
}

function service(options: { phone?: string | null; ttl?: number; redis?: RedisHandle } = {}) {
  const clock = new FixedClock('2026-10-08T02:00:00.000Z');
  const created = createOauthAttemptService({
    db: usersDb(options.phone === undefined ? null : options.phone) as never,
    redis: options.redis ?? memoryRedis().handle,
    clock,
    config: {
      configValue: async (_app, key) =>
        options.ttl !== undefined && key === 'auth.oauth_attempt_ttl_sec'
          ? { value: options.ttl, version: 1 }
          : null,
    },
  });
  return { ...created, clock };
}

const STEP_UP: OauthAttemptBinding = {
  app_id: 'couli',
  provider: 'wechat',
  purpose: 'step_up',
  device_id: PRINCIPAL.device_id,
  uid: PRINCIPAL.uid,
  action: 'account_deletion',
};

it('[BR-ID-04] issue: login without a token, 64 hex nonce, configured lifetime and Redis TTL', async () => {
  const redis = memoryRedis();
  const attempts = service({ ttl: 37, redis: redis.handle });
  const result = await attempts.issue({
    body: { provider: 'apple', purpose: 'login' },
    verifiedDevice: DEVICE,
  });
  expect(result).toMatchObject({ code: 0, data: { expire_at: '2026-10-08T02:00:37.000Z' } });
  if (result.code !== 0) throw new Error('unreachable after assertion');
  expect(result.data.nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(redis.ttls).toEqual([37]);
  expect([...redis.values.keys()]).toEqual([`oauth:a:couli:${result.data.attempt_id}`]);
});

it('[BR-ID-04][BR-ID-08] issue refusals: 10001 without login, 20001 for a bound phone or a bad purpose', async () => {
  const unbound = service();
  expect(
    await unbound.issue({
      body: { provider: 'wechat', purpose: 'step_up', action: 'payout_account_change' },
      verifiedDevice: DEVICE,
    }),
  ).toEqual({ code: 10001 });
  expect(
    await unbound.issue({
      body: { provider: 'apple', purpose: 'payout_bind' } as never,
      verifiedDevice: DEVICE,
      principal: PRINCIPAL,
    }),
  ).toEqual({ code: 20001, data: { fields: ['provider'] } });
  expect(
    await unbound.issue({
      body: { provider: 'wechat', purpose: 'step_up' } as never,
      verifiedDevice: DEVICE,
      principal: PRINCIPAL,
    }),
  ).toEqual({ code: 20001, data: { fields: ['action'] } });
  expect(
    await service({ phone: 'hmac-of-phone' }).issue({
      body: { provider: 'wechat', purpose: 'step_up', action: 'account_deletion' },
      verifiedDevice: DEVICE,
      principal: PRINCIPAL,
    }),
  ).toEqual({ code: 20001, data: { fields: ['provider'] } });
});

it('[BR-ID-04] consume: a mismatch leaves the attempt, the holder consumes it once, expiry is exact', async () => {
  const attempts = service();
  const issued = await attempts.issue({
    body: { provider: 'wechat', purpose: 'step_up', action: 'account_deletion' },
    verifiedDevice: DEVICE,
    principal: PRINCIPAL,
  });
  if (issued.code !== 0) throw new Error(`issue failed: ${issued.code}`);
  const correct = { ...STEP_UP, attempt_id: issued.data.attempt_id };
  expect(await attempts.consume({ ...correct, action: 'payout_account_change' })).toEqual({
    code: 20004,
  });
  expect(
    await attempts.consume({
      app_id: correct.app_id,
      provider: correct.provider,
      purpose: correct.purpose,
      device_id: correct.device_id,
      action: 'account_deletion',
      attempt_id: correct.attempt_id,
    }),
  ).toEqual({ code: 20004 });
  expect(await attempts.consume({ ...correct, purpose: 'login' })).toEqual({ code: 20004 });
  attempts.clock.advanceMs(599_999);
  expect(await attempts.consume(correct)).toEqual({
    code: 0,
    data: { nonce: issued.data.nonce },
  });
  expect(await attempts.consume(correct)).toEqual({ code: 20004 });

  const late = await attempts.issue({
    body: { provider: 'huawei', purpose: 'login' },
    verifiedDevice: DEVICE,
  });
  if (late.code !== 0) throw new Error(`issue failed: ${late.code}`);
  attempts.clock.advanceMs(600_000);
  expect(
    await attempts.consume({
      app_id: 'couli',
      provider: 'huawei',
      purpose: 'login',
      device_id: DEVICE.deviceId,
      attempt_id: late.data.attempt_id,
    }),
  ).toEqual({ code: 20004 });
});

it('[BR-ID-04] a closed or failing store answers 50001, never an in-memory fallback', async () => {
  const redis = memoryRedis();
  await redis.handle.close();
  const closed = service({ redis: redis.handle });
  expect(
    await closed.issue({ body: { provider: 'wechat', purpose: 'login' }, verifiedDevice: DEVICE }),
  ).toEqual({ code: 50001 });
  expect(await closed.consume({ ...STEP_UP, attempt_id: 'missing' })).toEqual({ code: 50001 });
  const failing: RedisHandle = {
    namespace: () => ({
      get: async () => {
        throw new RedisUnavailableError('command_timeout');
      },
      set: async () => {
        throw new RedisUnavailableError('command_timeout');
      },
      eval: async () => 0,
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  expect(await service({ redis: failing }).consume({ ...STEP_UP, attempt_id: 'x' })).toEqual({
    code: 50001,
  });
});

it('[BR-ID-07] issue: a token of another app than the signing device is 10403, nothing stored', async () => {
  const redis = memoryRedis();
  const attempts = service({ redis: redis.handle });
  expect(
    await attempts.issue({
      body: { provider: 'wechat', purpose: 'payout_bind' },
      verifiedDevice: DEVICE,
      principal: { ...PRINCIPAL, app_id: 'another_app' },
    }),
  ).toEqual({ code: 10403 });
  expect(redis.values.size).toBe(0);
});
