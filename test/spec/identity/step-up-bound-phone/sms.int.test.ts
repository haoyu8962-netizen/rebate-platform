// BR-ID-08 / task B1-02zzz: exercise the signed public route, not SmsCodeService.send directly.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../registration/kit.ts';
import { phone } from '../sms-codes/kit.ts';
import { accepted, client, jwt, STEP_UP, validate } from '../step-up/http-kit.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  ACTIONS,
  SMS,
  account,
  messages,
  sendBound,
  restrictedSession,
  openHttpKit,
  closeHttpKit,
  rejected,
  type HttpKit,
} from './kit.ts';

let kit: HttpKit;
beforeAll(async () => {
  kit = await openHttpKit();
}, 180_000);
afterAll(async () => {
  await closeHttpKit(kit);
});

it.each(ACTIONS)(
  '[AC-B1-02zzz#4] %s 从登录账号取绑定手机发码，并能完成相应用途的二次验证',
  async (action) => {
    const f = await account(kit);
    const message = await sendBound(f, action);
    const summary =
      action === 'withdraw'
        ? { payout_account_id: f.uid, amount_fen: 10000 }
        : action === 'payout_account_change'
          ? { payout_method: 'alipay', alipay_logon_id: '13800138000' }
          : undefined;
    const data = accepted<Schema<'StepUpData'>>(
      kit,
      STEP_UP,
      await f.post(STEP_UP, {
        action,
        code: message.code,
        ...(summary === undefined ? {} : { summary }),
      }),
    );
    expect(jwt(f, data.step_up_token, 'step_up', 300, data.expire_at)).toMatchObject({ action });
    const logs = kit.lines.join('');
    expect(logs).not.toContain(f.number);
    expect(logs).not.toContain(data.step_up_token);
  },
);

it('[AC-B1-02zzz#5] 未登录发 step_up 返回 10001；拒绝不占次数，登录后无需提交手机号', async () => {
  const f = await account(kit);
  rejected(
    kit,
    SMS,
    await f.device.post(SMS, {
      purpose: 'step_up',
      action: 'account_deletion',
    }),
    10001,
  );
  expect(messages(f)).toEqual([]);
  await sendBound(f);
});

it.each(['own', 'other', 'empty', 'null'] as const)(
  '[AC-B1-02zzz#6] step_up 出现 phone（%s）一律 20001 fields=[phone]，不发码也不占次数',
  async (kind) => {
    const f = await account(kit);
    const supplied = { own: f.number, other: phone('138'), empty: '', null: null }[kind];
    rejected(
      kit,
      SMS,
      await f.post(SMS, {
        purpose: 'step_up',
        action: 'account_deletion',
        phone: supplied,
      }),
      20001,
      { fields: ['phone'] },
    );
    expect(messages(f)).toEqual([]);
    await sendBound(f);
  },
);

it('[AC-B1-02zzz#7] 未绑手机沿用短信 step-up 的 20001 fields=[code]，不得发送短信', async () => {
  const f = await account(kit, false);
  rejected(
    kit,
    SMS,
    await f.post(SMS, {
      purpose: 'step_up',
      action: 'account_deletion',
    }),
    20001,
    { fields: ['code'] },
  );
  expect(messages(f)).toEqual([]);
  expect(kit.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-02zzz#8] 同 app、同设备切换账号后，只向令牌所属账号的手机发码', async () => {
  const f = await account(kit);
  const otherPhone = phone('138');
  const otherUid = await seedUser(f.db, f.appId);
  await f.db
    .updateTable('users')
    .set({
      phone_hmac: f.crypto.blindIndex(otherPhone, 'users.phone'),
      phone_cipher: Buffer.from(f.crypto.encrypt(otherPhone, 'users.phone'), 'utf8'),
    })
    .where('id', '=', otherUid)
    .where('app_id', '=', f.appId)
    .execute();
  const otherSession = await f.issue(otherUid);
  accepted(
    kit,
    SMS,
    await f.post(
      SMS,
      {
        purpose: 'step_up',
        action: 'account_deletion',
      },
      otherSession.access_token,
    ),
  );
  expect(messages(f)).toHaveLength(1);
  expect(messages(f)[0]).toMatchObject({ phone: otherPhone, purpose: 'step_up' });
  accepted(kit, SMS, await f.post(SMS, { purpose: 'step_up', action: 'account_deletion' }));
  expect(messages(f).map((message) => message.phone)).toEqual([otherPhone, f.number]);
});

it('[AC-B1-02zzz#9] 跨 app 令牌不得借用本设备取号；合法本人令牌仍能发码', async () => {
  const f = await account(kit);
  const other = await account(kit);
  rejected(
    kit,
    SMS,
    await f.post(
      SMS,
      {
        purpose: 'step_up',
        action: 'account_deletion',
      },
      other.session.access_token,
    ),
    10403,
  );
  expect(messages(f)).toEqual([]);
  expect(messages(other)).toEqual([]);
  await sendBound(f);
});

it('[AC-B1-02zzz#10] 伪造令牌不得作为匿名请求发 step_up；拒绝后本人仍能发码', async () => {
  const f = await account(kit);
  rejected(
    kit,
    SMS,
    await f.post(
      SMS,
      {
        purpose: 'step_up',
        action: 'account_deletion',
      },
      'invalid.access.token',
    ),
    10002,
  );
  expect(messages(f)).toEqual([]);
  await sendBound(f);
});

it('[AC-B1-02zzz#11] 不同设备和 action 仍共享绑定手机号的发送间隔', async () => {
  const f = await account(kit);
  await sendBound(f);
  const secondDevice = await client(kit, f.appId);
  const session = await f.issue(f.uid, secondDevice.deviceId);
  const response = await secondDevice.post(
    SMS,
    {
      purpose: 'step_up',
      action: 'withdraw',
    },
    session.access_token,
  );
  expect(response.statusCode).toBe(429);
  expect(response.json()).toMatchObject({ code: 42901 });
  expect(String(response.headers['retry-after'])).toBe('60');
  validate(kit, SMS, response);
  expect(messages(f)).toHaveLength(1);
});

it('[AC-B1-02zzz#12] deletion_only 只放行 login 与注销 step_up；其他用途拒绝且不发码', async () => {
  const f = await account(kit);
  const session = await restrictedSession(f);
  for (const action of ['withdraw', 'payout_account_change', 'phone_change']) {
    rejected(
      kit,
      SMS,
      await f.post(SMS, { purpose: 'step_up', action }, session.access_token),
      10403,
    );
  }
  rejected(
    kit,
    SMS,
    await f.post(SMS, { purpose: 'bind', phone: phone('138') }, session.access_token),
    10403,
  );
  expect(messages(f)).toEqual([]);
  accepted(
    kit,
    SMS,
    await f.post(
      SMS,
      {
        purpose: 'step_up',
        action: 'account_deletion',
      },
      session.access_token,
    ),
  );
  expect(messages(f)).toHaveLength(1);
  expect(messages(f)[0]).toMatchObject({ phone: f.number, purpose: 'step_up' });
  const loginPhone = phone('138');
  accepted(
    kit,
    SMS,
    await f.post(SMS, { purpose: 'login', phone: loginPhone }, session.access_token),
  );
  expect(messages(f).map((message) => [message.phone, message.purpose])).toEqual([
    [f.number, 'step_up'],
    [loginPhone, 'login'],
  ]);
});

it.each(['login', 'bind'] as const)(
  '[AC-B1-02zzz#13] %s 仍允许匿名传号，登录时仍用传入号；step_up 才用绑定号',
  async (purpose) => {
    const f = await account(kit);
    await sendBound(f);
    const anonymousPhone = phone('138');
    accepted(kit, SMS, await f.device.post(SMS, { purpose, phone: anonymousPhone }));
    const explicitPhone = phone('137');
    accepted(kit, SMS, await f.post(SMS, { purpose, phone: explicitPhone }));
    rejected(kit, SMS, await f.device.post(SMS, { purpose }), 20001, { fields: ['phone'] });
    expect(messages(f).map((message) => [message.phone, message.purpose])).toEqual([
      [f.number, 'step_up'],
      [anonymousPhone, purpose],
      [explicitPhone, purpose],
    ]);
  },
);

it('[AC-B1-02zzz#14] 换绑后下一次发码读取最新绑定号码，不复用设备或会话中的旧号', async () => {
  const f = await account(kit);
  await sendBound(f);
  const nextPhone = phone('138');
  await f.db
    .updateTable('users')
    .set({
      phone_hmac: f.crypto.blindIndex(nextPhone, 'users.phone'),
      phone_cipher: Buffer.from(f.crypto.encrypt(nextPhone, 'users.phone'), 'utf8'),
    })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.uid)
    .execute();
  accepted(kit, SMS, await f.post(SMS, { purpose: 'step_up', action: 'account_deletion' }));
  expect(messages(f).map((message) => message.phone)).toEqual([f.number, nextPhone]);
});
