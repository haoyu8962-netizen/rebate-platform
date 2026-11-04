import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type FieldCrypto,
  type TokenPrincipal,
} from '../../platform/index.ts';
import type { TokenKeyProvider } from './access-tokens.ts';
import type { OauthAttemptService } from './oauth-attempts.ts';
import type { SmsCodeService } from './sms-codes.ts';
import { createStepUpService, type ThirdPartyIdentityPort } from './step-up.ts';

const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};
const DEVICE = { appId: 'couli', deviceId: PRINCIPAL.device_id };
const PHONE = '+8613800000000';
const ATTEMPT = '019a0000-0000-7000-8000-0000000000aa';

/** Kysely stand-in: each table answers its one row (or none) to executeTakeFirst. */
function tables(rows: Record<string, object | undefined>) {
  return {
    selectFrom: (table: string) => {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => rows[table],
      };
      return chain;
    },
  };
}

/** The stored cipher is the number itself here; the context must be the users.phone one. */
const crypto = {
  decrypt: (text: string, context: string) => (context === 'users.phone' ? text : ''),
} as unknown as FieldCrypto;

function setup(options: {
  bound: boolean;
  union?: string;
  verify?: { code: 0 | 20002 | 20003 };
  consume?: Awaited<ReturnType<OauthAttemptService['consume']>>;
  port?: ThirdPartyIdentityPort;
}) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keys: TokenKeyProvider = {
    kid: 'unit',
    privateKey: pair.privateKey,
    publicKeys: new Map([['unit', pair.publicKey]]),
  };
  const clock = new FixedClock('2026-10-08T02:00:00.400Z');
  const verifyAndConsume = vi.fn(async () => options.verify ?? { code: 0 as const });
  const consume = vi.fn(async () => options.consume ?? { code: 0 as const, data: { nonce: 'n1' } });
  const service = createStepUpService({
    db: tables({
      users: options.bound
        ? { phone_hmac: 'hmac', phone_cipher: Buffer.from(PHONE, 'utf8') }
        : { phone_hmac: null, phone_cipher: null },
      user_oauth: options.union === undefined ? undefined : { union_id: options.union },
    }) as never,
    clock,
    crypto,
    keys,
    config: { configValue: async () => null },
    sms: { send: vi.fn(), verifyAndConsume } as unknown as SmsCodeService,
    attempts: { issue: vi.fn(), consume } as unknown as OauthAttemptService,
    ...(options.port === undefined ? {} : { thirdPartyIdentity: options.port }),
  });
  return { service, keys, pair, verifyAndConsume, consume };
}

const WECHAT = {
  action: 'account_deletion' as const,
  provider: 'wechat' as const,
  attempt_id: ATTEMPT,
  code: 'test-wechat-credential',
};

it('[BR-ID-08] SMS: the account phone with purpose step_up; a token bound to uid, sid, device and action', async () => {
  const context = setup({ bound: true });
  const result = await context.service.verify({
    principal: PRINCIPAL,
    verifiedDevice: DEVICE,
    body: { action: 'withdraw', code: '123456' },
  });
  expect(context.verifyAndConsume).toHaveBeenCalledExactlyOnceWith({
    app_id: 'couli',
    phone: PHONE,
    purpose: 'step_up',
    code: '123456',
  });
  expect(result).toMatchObject({ code: 0, data: { expire_at: '2026-10-08T02:05:00.000Z' } });
  if (result.code !== 0) throw new Error('unreachable after assertion');
  const token = result.data.step_up_token;
  expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'unit', typ: 'JWT' });
  const { payload } = await jwtVerify(token, context.pair.publicKey, {
    audience: 'step_up',
    issuer: 'couli-api',
    currentDate: new FixedClock('2026-10-08T02:00:00.400Z').now(),
  });
  expect(payload).toMatchObject({
    uid: PRINCIPAL.uid,
    app_id: 'couli',
    sid: PRINCIPAL.sid,
    device_id: PRINCIPAL.device_id,
    action: 'withdraw',
    jti: expect.any(String),
  });
  expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
});

it('[BR-ID-08] SMS refusals: no bound phone 20001 [code]; 20002 / 20003 passed through, no token', async () => {
  const unbound = setup({ bound: false });
  expect(
    await unbound.service.verify({
      principal: PRINCIPAL,
      verifiedDevice: DEVICE,
      body: { action: 'withdraw', code: '123456' },
    }),
  ).toEqual({ code: 20001, data: { fields: ['code'] } });
  expect(unbound.verifyAndConsume).not.toHaveBeenCalled();
  for (const code of [20002, 20003] as const) {
    expect(
      await setup({ bound: true, verify: { code } }).service.verify({
        principal: PRINCIPAL,
        verifiedDevice: DEVICE,
        body: { action: 'withdraw', code: '123456' },
      }),
    ).toEqual({ code });
  }
});

it('[BR-ID-04][BR-ID-08] third party: bound phone 20001 [provider] before the attempt; attempt failures pass through', async () => {
  const exchange = vi.fn<ThirdPartyIdentityPort['exchange']>();
  const bound = setup({ bound: true, port: { exchange } });
  expect(
    await bound.service.verify({ principal: PRINCIPAL, verifiedDevice: DEVICE, body: WECHAT }),
  ).toEqual({ code: 20001, data: { fields: ['provider'] } });
  expect(bound.consume).not.toHaveBeenCalled();
  for (const code of [20004, 50001] as const) {
    const refused = setup({ bound: false, consume: { code }, port: { exchange } });
    expect(
      await refused.service.verify({ principal: PRINCIPAL, verifiedDevice: DEVICE, body: WECHAT }),
    ).toEqual({ code });
    expect(refused.consume).toHaveBeenCalledWith({
      app_id: 'couli',
      provider: 'wechat',
      purpose: 'step_up',
      device_id: DEVICE.deviceId,
      uid: PRINCIPAL.uid,
      action: 'account_deletion',
      attempt_id: ATTEMPT,
    });
  }
  expect(exchange).not.toHaveBeenCalled();
});

it('[BR-ID-04][BR-ID-08] third party after consumption: no port / unavailable / thrown 50305, invalid 20004, mismatch, match', async () => {
  const run = async (port: ThirdPartyIdentityPort | undefined, union = 'union-1') =>
    setup({ bound: false, union, ...(port === undefined ? {} : { port }) }).service.verify({
      principal: PRINCIPAL,
      verifiedDevice: DEVICE,
      body: {
        action: 'account_deletion',
        provider: 'apple',
        attempt_id: ATTEMPT,
        identity_token: 'test-identity',
        authorization_code: 'test-authorization',
      },
    });
  const unavailable = { code: 50305, data: { provider: 'apple' } };
  expect(await run(undefined)).toEqual(unavailable);
  expect(await run({ exchange: async () => ({ unavailable: true }) })).toEqual(unavailable);
  expect(
    await run({
      exchange: async () => {
        throw new Error('test provider down');
      },
    }),
  ).toEqual(unavailable);
  expect(await run({ exchange: async () => ({ invalid: true }) })).toEqual({ code: 20004 });
  expect(await run({ exchange: async () => ({ union_id: 'union-2' }) })).toEqual({
    code: 20004,
    data: { reason: 'identity_mismatch' },
  });
  const exchange = vi.fn<ThirdPartyIdentityPort['exchange']>(async () => ({ union_id: 'union-1' }));
  const accepted = await run({ exchange });
  expect(accepted.code).toBe(0);
  expect(exchange).toHaveBeenCalledExactlyOnceWith({
    provider: 'apple',
    identity_token: 'test-identity',
    authorization_code: 'test-authorization',
    nonce: 'n1',
  });
  if (accepted.code !== 0) throw new Error('unreachable after assertion');
  expect(decodeJwt(accepted.data.step_up_token)).toMatchObject({
    aud: 'step_up',
    action: 'account_deletion',
  });
});

it('[BR-ID-07] a token of another app than the signing device is 10403 before any code or attempt', async () => {
  const context = setup({ bound: true });
  expect(
    await context.service.verify({
      principal: PRINCIPAL,
      verifiedDevice: { ...DEVICE, appId: 'another_app' },
      body: { action: 'withdraw', code: '123456' },
    }),
  ).toEqual({ code: 10403 });
  const third = setup({ bound: false, union: 'u1' });
  expect(
    await third.service.verify({
      principal: PRINCIPAL,
      verifiedDevice: { ...DEVICE, appId: 'another_app' },
      body: WECHAT,
    }),
  ).toEqual({ code: 10403 });
  expect(context.verifyAndConsume).not.toHaveBeenCalled();
  expect(third.consume).not.toHaveBeenCalled();
});

it('[AC-B1-02zza#u6] a staging test phone’s SMS step-up writes one pino audit line (masked number, no code); other answers write none', async () => {
  const phone = '19900000099';
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verifyAndConsume = vi.fn<SmsCodeService['verifyAndConsume']>(async () => ({ code: 0 }));
  const service = createStepUpService({
    db: tables({
      users: { phone_hmac: 'hmac', phone_cipher: Buffer.from(phone, 'utf8') },
    }) as never,
    clock: new FixedClock('2026-11-04T02:00:00.000Z'),
    crypto,
    keys: {
      kid: 'unit',
      privateKey: pair.privateKey,
      publicKeys: new Map([['unit', pair.publicKey]]),
    },
    config: { configValue: async () => null },
    sms: { send: vi.fn(), verifyAndConsume } as unknown as SmsCodeService,
    attempts: { issue: vi.fn(), consume: vi.fn() } as unknown as OauthAttemptService,
    logger,
  });
  const command = {
    principal: PRINCIPAL,
    verifiedDevice: DEVICE,
    body: { action: 'withdraw' as const, code: '864213' },
  };
  verifyAndConsume.mockResolvedValueOnce({ code: 20002 });
  expect(await service.verify(command)).toEqual({ code: 20002 });
  expect((await service.verify(command)).code).toBe(0);
  const audit = () =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['event'] === 'staging_test_phone_login');
  expect(audit()).toEqual([]);
  verifyAndConsume.mockResolvedValueOnce({ code: 0, staging_test_phone: true });
  expect((await service.verify(command)).code).toBe(0);
  expect(audit()).toEqual([
    expect.objectContaining({
      purpose: 'step_up',
      is_new_user: false,
      phone_masked: '199****0099',
      user_id: PRINCIPAL.uid,
    }),
  ]);
  expect(lines.join('')).not.toContain(phone);
  expect(lines.join('')).not.toContain('864213');
});
