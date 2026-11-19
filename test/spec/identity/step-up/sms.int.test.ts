import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createStepUpService } from '../../../../apps/api/src/modules/identity/application/step-up.ts';
import {
  STEP_UP,
  accepted,
  rejected,
  fixture,
  jwt,
  openHttpKit,
  closeHttpKit,
  type HttpKit,
} from './http-kit.ts';

let kit: HttpKit;
beforeAll(async () => {
  kit = await openHttpKit();
}, 180_000);
afterAll(async () => {
  await closeHttpKit(kit);
});

it('[AC-B1-02f#29][BR-ID-08] 配置 step-up TTL，复用短信核销端口并指定绑定手机号与用途', async () => {
  const f = await fixture(kit, true);
  const code = await f.send();
  const verifyAndConsume = vi.fn(f.sms.verifyAndConsume);
  const service = createStepUpService({
    db: f.db,
    clock: kit.clock,
    crypto: f.crypto,
    keys: f.keys,
    config: {
      configValue: async (app, key) => {
        expect(app).toBe(f.appId);
        return key === 'auth.step_up_ttl_sec' ? { value: 75, version: 1 } : null;
      },
    },
    sms: { ...f.sms, verifyAndConsume },
    attempts: { issue: async () => ({ code: 50001 }), consume: async () => ({ code: 50001 }) },
  });
  const result = await service.verify({
    principal: f.principal,
    verifiedDevice: { appId: f.appId, deviceId: f.device.deviceId },
    body: { action: 'withdraw', code },
  });
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after assertion');
  expect(jwt(f, result.data.step_up_token, 'step_up', 75, result.data.expire_at)).toHaveProperty(
    'action',
    'withdraw',
  );
  expect(verifyAndConsume).toHaveBeenCalledExactlyOnceWith({
    app_id: f.appId,
    phone: f.number,
    purpose: 'step_up',
    code,
  });
  expect(
    await f.sms.verifyAndConsume({ app_id: f.appId, phone: f.number, purpose: 'step_up', code }),
  ).toEqual({ code: 20003 });
});

it.each(['withdraw', 'payout_account_change', 'phone_change', 'account_deletion'] as const)(
  '[AC-B1-02f#20][BR-ID-08] 短信签发 %s：ES256、300 秒、身份与 action 绑定',
  async (action) => {
    const f = await fixture(kit, true);
    const code = await f.send();
    const data = accepted<Schema<'StepUpData'>>(
      kit,
      STEP_UP,
      // B1-02zzzb (BR-ID-08 细则「绑定业务摘要」): payout_account_change is issued with the summary
      // of the account it is for; the other actions take none.
      await f.post(STEP_UP, {
        action,
        code,
        ...(action === 'payout_account_change'
          ? { summary: { payout_method: 'alipay', alipay_logon_id: 'step-up@example.com' } }
          : {}),
      }),
    );
    expect(jwt(f, data.step_up_token, 'step_up', 300, data.expire_at)).toMatchObject({
      action,
      jti: expect.any(String),
    });
    const logs = kit.lines.join('');
    expect(logs).not.toContain(data.step_up_token);
    expect(logs).not.toContain(f.number);
    expect(logs).not.toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
  },
);

it('[AC-B1-02f#21][BR-ID-08] 验证码核销，同码再次提交 20003，无第二个 token', async () => {
  const f = await fixture(kit, true);
  const code = await f.send();
  accepted(kit, STEP_UP, await f.post(STEP_UP, { action: 'withdraw', code }));
  const again = await f.post(STEP_UP, { action: 'withdraw', code });
  rejected(kit, STEP_UP, again, 20003);
  expect(again.json()).not.toHaveProperty('data.step_up_token');
});

it('[AC-B1-02f#22][BR-ID-08] 错码 20002，随后正确码仍可验证', async () => {
  const f = await fixture(kit, true);
  const code = await f.send();
  rejected(
    kit,
    STEP_UP,
    await f.post(STEP_UP, { action: 'withdraw', code: code === '000000' ? '000001' : '000000' }),
    20002,
  );
  expect(
    accepted<Schema<'StepUpData'>>(
      kit,
      STEP_UP,
      await f.post(STEP_UP, { action: 'withdraw', code }),
    ).step_up_token,
  ).toEqual(expect.any(String));
});

it('[AC-B1-02f#23][BR-ID-08] 短信满 300 秒失效，返回 20003', async () => {
  const f = await fixture(kit, true);
  const code = await f.send();
  kit.clock.advanceMs(300_000);
  rejected(kit, STEP_UP, await f.post(STEP_UP, { action: 'withdraw', code }), 20003);
});

it('[AC-B1-02f#24][BR-ID-08] 未绑定手机不能走短信', async () => {
  const f = await fixture(kit);
  rejected(
    kit,
    STEP_UP,
    await f.post(STEP_UP, { action: 'account_deletion', code: '123456' }),
    20001,
    { fields: ['code'] },
  );
});

it('[AC-B1-02f#25][BR-ID-08] 账号手机号从服务端取，另一账号验证码不能验证本账号', async () => {
  const f = await fixture(kit, true);
  const other = await fixture(kit, true);
  const foreign = await other.send();
  rejected(kit, STEP_UP, await f.post(STEP_UP, { action: 'withdraw', code: foreign }), 20003);
  expect(
    await other.sms.verifyAndConsume({
      app_id: other.appId,
      phone: other.number,
      purpose: 'step_up',
      code: foreign,
    }),
  ).toEqual({ code: 0 });
});

it('[AC-B1-02f#26][BR-ID-08] login 短信不能替代 purpose=step_up 的验证码', async () => {
  const f = await fixture(kit, true);
  const code = await f.send('login');
  rejected(kit, STEP_UP, await f.post(STEP_UP, { action: 'withdraw', code }), 20003);
  expect(
    await f.sms.verifyAndConsume({ app_id: f.appId, phone: f.number, purpose: 'login', code }),
  ).toEqual({ code: 0 });
});

it('[AC-B1-02f#27][BR-ID-08] 混用短信与 Apple 凭证不能绕过 oneOf 校验', async () => {
  const f = await fixture(kit, true);
  const code = await f.send();
  rejected(
    kit,
    STEP_UP,
    await f.post(STEP_UP, {
      action: 'withdraw',
      code,
      provider: 'apple',
      attempt_id: f.uid,
      identity_token: 'test-token',
      authorization_code: 'test-code',
    }),
    20001,
  );
  expect(
    await f.sms.verifyAndConsume({ app_id: f.appId, phone: f.number, purpose: 'step_up', code }),
  ).toEqual({ code: 0 });
});

it('[AC-B1-02f#28][BR-ID-08] 无令牌 10001；其他 app 令牌 10403，均不核销验证码', async () => {
  const f = await fixture(kit, true);
  const code = await f.send();
  rejected(kit, STEP_UP, await f.device.post(STEP_UP, { action: 'withdraw', code }), 10001);
  const other = await fixture(kit, true);
  rejected(
    kit,
    STEP_UP,
    await f.post(STEP_UP, { action: 'withdraw', code }, other.session.access_token),
    10403,
  );
  expect(
    await f.sms.verifyAndConsume({ app_id: f.appId, phone: f.number, purpose: 'step_up', code }),
  ).toEqual({ code: 0 });
});
