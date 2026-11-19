import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createOauthAttemptService } from '../../../../apps/api/src/modules/identity/application/oauth-attempts.ts';
import { createStepUpService } from '../../../../apps/api/src/modules/identity/application/step-up.ts';
import { seedUser } from '../registration/kit.ts';
import {
  ATTEMPTS,
  STEP_UP,
  accepted,
  rejected,
  fixture,
  attempt,
  oauthBody,
  client,
  jwt,
  openHttpKit,
  closeHttpKit,
  type Fixture,
  type HttpKit,
} from './http-kit.ts';

let kit: HttpKit;
beforeAll(async () => {
  kit = await openHttpKit();
}, 180_000);
afterAll(async () => {
  await closeHttpKit(kit);
});

function store(f: Fixture) {
  return createOauthAttemptService({
    db: f.db,
    redis: f.redis,
    clock: kit.clock,
    config: { configValue: async () => null },
  });
}
async function snapshots(f: Fixture) {
  return {
    users: await f.db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    oauth: await f.db
      .selectFrom('user_oauth')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    consents: await f.db
      .selectFrom('consent_records')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    sessions: await f.db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

it.each(['wechat', 'apple', 'huawei'] as const)(
  '[AC-B1-02f#30][BR-ID-04/08] %s 身份相等签发，把原凭证及尝试 nonce 交给换取端口',
  async (provider) => {
    const f = await fixture(kit);
    const unionId = await f.bindOauth(provider);
    kit.exchange.mockResolvedValue({ union_id: unionId });
    const data = await attempt(f, provider);
    const body = oauthBody(data.attempt_id, provider);
    const before = await snapshots(f);
    const response = accepted<Schema<'StepUpData'>>(kit, STEP_UP, await f.post(STEP_UP, body));
    expect(jwt(f, response.step_up_token, 'step_up', 300, response.expire_at)).toMatchObject({
      action: 'account_deletion',
      jti: expect.any(String),
    });
    const { action, attempt_id, ...credentials } = body;
    expect(action).toBe('account_deletion');
    expect(attempt_id).toBe(data.attempt_id);
    expect(kit.exchange).toHaveBeenCalledExactlyOnceWith({ ...credentials, nonce: data.nonce });
    expect(await snapshots(f)).toEqual(before);
    rejected(kit, STEP_UP, await f.post(STEP_UP, body), 20004);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-02f#31][BR-ID-08] 已绑手机请求第三方验证直接拒绝，不换取不消费', async () => {
  const f = await fixture(kit);
  const data = await attempt(f);
  await f.db
    .updateTable('users')
    .set({
      phone_hmac: f.crypto.blindIndex(f.number, 'users.phone'),
      phone_cipher: Buffer.from(f.crypto.encrypt(f.number, 'users.phone')),
    })
    .where('id', '=', f.uid)
    .execute();
  rejected(kit, STEP_UP, await f.post(STEP_UP, oauthBody(data.attempt_id)), 20001, {
    fields: ['provider'],
  });
  expect(kit.exchange).not.toHaveBeenCalled();
  expect(
    await store(f).consume({
      app_id: f.appId,
      uid: f.uid,
      device_id: f.device.deviceId,
      action: 'account_deletion',
      provider: 'wechat',
      purpose: 'step_up',
      attempt_id: data.attempt_id,
    }),
  ).toEqual({ code: 0, data: { nonce: data.nonce } });
});

it.each(['login', 'payout_bind'] as const)(
  '[AC-B1-02f#32][BR-ID-04/08] %s 尝试在 step-up 拒绝且保留原用途',
  async (purpose) => {
    const f = await fixture(kit);
    const data = await attempt(f, 'wechat', purpose);
    rejected(kit, STEP_UP, await f.post(STEP_UP, oauthBody(data.attempt_id)), 20004);
    expect(kit.exchange).not.toHaveBeenCalled();
    expect(
      await store(f).consume({
        app_id: f.appId,
        device_id: f.device.deviceId,
        provider: 'wechat',
        purpose,
        ...(purpose === 'payout_bind' ? { uid: f.uid } : {}),
        attempt_id: data.attempt_id,
      }),
    ).toEqual({ code: 0, data: { nonce: data.nonce } });
  },
);

it.each(['uid', 'device', 'action', 'provider'] as const)(
  '[AC-B1-02f#33][BR-ID-04/08] HTTP %s 不符 20004，攻击请求不能烧掉尝试',
  async (field) => {
    const f = await fixture(kit);
    const unionId = await f.bindOauth();
    kit.exchange.mockResolvedValue({ union_id: unionId });
    const data = await attempt(f);
    const body = oauthBody(data.attempt_id);
    if (field === 'uid') {
      const otherUser = await seedUser(f.db, f.appId);
      const otherSession = await f.issue(otherUser);
      rejected(kit, STEP_UP, await f.post(STEP_UP, body, otherSession.access_token), 20004);
    } else if (field === 'device') {
      const otherDevice = await client(kit, f.appId);
      const otherSession = await f.issue(f.uid, otherDevice.deviceId);
      rejected(
        kit,
        STEP_UP,
        await otherDevice.post(STEP_UP, body, otherSession.access_token),
        20004,
      );
    } else {
      const changed =
        field === 'action'
          ? { ...body, action: 'phone_change' }
          : oauthBody(data.attempt_id, 'apple');
      rejected(kit, STEP_UP, await f.post(STEP_UP, changed), 20004);
    }
    expect(kit.exchange).not.toHaveBeenCalled();
    expect(
      accepted<Schema<'StepUpData'>>(kit, STEP_UP, await f.post(STEP_UP, body)).step_up_token,
    ).toEqual(expect.any(String));
    expect(kit.exchange).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-02f#34][BR-ID-04] 签名失败在核对尝试前拒绝，原尝试仍可用', async () => {
  const f = await fixture(kit);
  kit.exchange.mockResolvedValue({ union_id: await f.bindOauth() });
  const data = await attempt(f);
  rejected(
    kit,
    STEP_UP,
    await f.post(STEP_UP, oauthBody(data.attempt_id), f.session.access_token, {
      'x-sign': '0'.repeat(64),
    }),
    10401,
  );
  expect(kit.exchange).not.toHaveBeenCalled();
  expect(
    accepted<Schema<'StepUpData'>>(kit, STEP_UP, await f.post(STEP_UP, oauthBody(data.attempt_id)))
      .step_up_token,
  ).toEqual(expect.any(String));
});

it.each(['mismatch', 'invalid', 'unavailable', 'throw'] as const)(
  '[AC-B1-02f#35][BR-ID-04/08] 换取之后 %s 不恢复尝试，不建号、不写同意、不签发令牌',
  async (failure) => {
    const f = await fixture(kit);
    await f.bindOauth();
    const data = await attempt(f);
    if (failure === 'throw') kit.exchange.mockRejectedValue(new Error('test provider unavailable'));
    else
      kit.exchange.mockResolvedValue(
        failure === 'mismatch'
          ? { union_id: 'another-identity' }
          : failure === 'invalid'
            ? { invalid: true }
            : { unavailable: true },
      );
    const before = await snapshots(f);
    const response = await f.post(STEP_UP, oauthBody(data.attempt_id));
    const unavailable = failure === 'unavailable' || failure === 'throw';
    rejected(
      kit,
      STEP_UP,
      response,
      unavailable ? 50305 : 20004,
      unavailable
        ? { provider: 'wechat' }
        : failure === 'mismatch'
          ? { reason: 'identity_mismatch' }
          : undefined,
    );
    expect(response.json()).not.toHaveProperty('data.step_up_token');
    expect(await snapshots(f)).toEqual(before);
    rejected(kit, STEP_UP, await f.post(STEP_UP, oauthBody(data.attempt_id)), 20004);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-02f#36][BR-ID-04/08] 同一授权尝试并发提交只换取一次、只签发一次', async () => {
  const f = await fixture(kit);
  kit.exchange.mockResolvedValue({ union_id: await f.bindOauth() });
  const data = await attempt(f);
  const responses = await Promise.all([
    f.post(STEP_UP, oauthBody(data.attempt_id)),
    f.post(STEP_UP, oauthBody(data.attempt_id)),
  ]);
  expect(
    responses.map((response) => response.json<{ code: number }>().code).sort((a, b) => a - b),
  ).toEqual([0, 20004]);
  accepted(
    kit,
    STEP_UP,
    responses.find((response) => response.statusCode === 200)!,
  );
  rejected(
    kit,
    STEP_UP,
    responses.find((response) => response.statusCode !== 200)!,
    20004,
  );
  expect(kit.exchange).toHaveBeenCalledTimes(1);
});

it('[AC-B1-02f#37][BR-ID-04/08] 尝试到期不向第三方换取', async () => {
  const f = await fixture(kit);
  const data = await attempt(f);
  kit.clock.advanceMs(600_000);
  rejected(kit, STEP_UP, await f.post(STEP_UP, oauthBody(data.attempt_id)), 20004);
  expect(kit.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-02f#38][BR-ID-04/08] 缺省端口不可用，真实 AppModule 回 50305', async () => {
  const fallback = await openHttpKit(false);
  try {
    const f = await fixture(fallback);
    await f.bindOauth();
    const data = await attempt(f);
    rejected(fallback, STEP_UP, await f.post(STEP_UP, oauthBody(data.attempt_id)), 50305, {
      provider: 'wechat',
    });
    expect(fallback.exchange).not.toHaveBeenCalled();
    rejected(fallback, STEP_UP, await f.post(STEP_UP, oauthBody(data.attempt_id)), 20004);
  } finally {
    await closeHttpKit(fallback);
  }
});

it('[AC-B1-02f#39][BR-ID-04] 存储不可用拒绝在第三方换取之前', async () => {
  const f = await fixture(kit);
  const service = createStepUpService({
    db: f.db,
    clock: kit.clock,
    crypto: f.crypto,
    keys: f.keys,
    config: { configValue: async () => null },
    sms: f.sms,
    attempts: { issue: async () => ({ code: 50001 }), consume: async () => ({ code: 50001 }) },
    thirdPartyIdentity: { exchange: kit.exchange },
  });
  expect(
    await service.verify({
      principal: f.principal,
      verifiedDevice: { appId: f.appId, deviceId: f.device.deviceId },
      body: oauthBody(f.uid),
    }),
  ).toEqual({ code: 50001 });
  expect(kit.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-02f#40][BR-ID-04/08] 签发尝试不写 user_oauth 或同意记录', async () => {
  const f = await fixture(kit);
  const before = await snapshots(f);
  accepted(kit, ATTEMPTS, await f.post(ATTEMPTS, { provider: 'wechat', purpose: 'payout_bind' }));
  expect(await snapshots(f)).toEqual(before);
});
