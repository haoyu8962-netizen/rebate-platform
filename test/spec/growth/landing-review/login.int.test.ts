// Real AppModule wiring. Only the external OAuth exchange is replaced by the existing test kit.
// Each test owns startup so a future NotImplemented factory fails the test, not beforeAll.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  LOGIN,
  accepted,
  client,
  closeOauthKit,
  fixture as oauthFixture,
  loginBody,
  openOauthKit,
  type Client,
  type Fixture,
  type Provider,
} from '../../identity/oauth-login/kit.ts';
import { outbox, type Response } from '../../identity/sms-codes/http-kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import {
  assertHit,
  assertSilent,
  hits,
  landing,
  loginLog,
  relationLogs,
  seedUser,
  user,
} from './kit.ts';

async function boundAccount(f: Fixture, provider?: Provider) {
  const number = phone();
  const uid =
    provider === undefined
      ? await seedUser(f.db, f.appId, f.crypto.blindIndex(number, 'users.phone'))
      : (await f.account(provider)).uid;
  const parentId = await seedUser(f.db, f.appId);
  await landing(f.db, f.appId, uid, parentId);
  const hash = f.crypto.blindIndex(f.device.deviceId, 'login_logs.device_id');
  await loginLog(f.db, f.appId, parentId, hash);
  return { uid, parentId, number, hash };
}

async function sms(f: Fixture, uid: string, number: string, device: Client = f.device) {
  f.kit.clock.advanceMs(61_000);
  const sent = await device.post('/v1/auth/sms-codes', { phone: number, purpose: 'login' });
  expect(sent.statusCode).toBe(200);
  expect(sent.json()).toMatchObject({ code: 0 });
  const message = outbox(f.kit.app).findLast((m) => m.phone === number && m.purpose === 'login');
  expect(message?.code).toMatch(/^\d{6}$/);
  const response = await device.post('/v1/auth/login/sms', {
    phone: number,
    code: message!.code,
    legal_versions: { privacy: 7, agreement: 4 },
    consent_at: f.kit.clock.now().toISOString(),
  });
  const data = accepted(f.kit, '/v1/auth/login/sms', response);
  expect(data).toMatchObject({
    user_id: uid,
    is_new_user: false,
    tokens: { session_scope: 'full' },
  });
  expect(await f.tokens.verifyAccess(data.tokens.access_token)).toMatchObject({
    uid,
    app_id: f.appId,
    device_id: device.deviceId,
  });
  return data;
}

async function oauth(
  f: Fixture,
  uid: string,
  provider: Provider,
  device: Client = f.device,
  headers: Record<string, string> = {},
) {
  const identity = await f.db
    .selectFrom('user_oauth')
    .select('union_id')
    .where('app_id', '=', f.appId)
    .where('user_id', '=', uid)
    .where('provider', '=', provider)
    .executeTakeFirstOrThrow();
  f.kit.exchange.mockResolvedValue({ union_id: identity.union_id! });
  const attempt = await device.attempt(provider, headers);
  const data = accepted(
    f.kit,
    LOGIN[provider],
    await device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id), headers),
  );
  expect(data).toMatchObject({
    user_id: uid,
    is_new_user: false,
    tokens: { session_scope: 'full' },
  });
  expect(await f.tokens.verifyAccess(data.tokens.access_token)).toMatchObject({
    uid,
    app_id: f.appId,
    device_id: device.deviceId,
  });
  return data;
}

async function successfulLog(f: Fixture, uid: string, method: string, hash: string, count = 1) {
  const rows = await f.db
    .selectFrom('login_logs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('user_id', '=', uid)
    .execute();
  expect(rows).toHaveLength(count);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method,
        device_id_hash: hash,
        created_at: f.kit.clock.now(),
      }),
    ]),
  );
  expect(
    await f.db
      .selectFrom('sessions')
      .select('id')
      .where('app_id', '=', f.appId)
      .where('user_id', '=', uid)
      .execute(),
  ).toHaveLength(count);
}

it('[AC-B1-11f#10] 真实短信登录注入 growth 复核，命中也返回有效会话、不通知双方', async () => {
  const kit = await openOauthKit();
  try {
    const f = await oauthFixture(kit);
    const a = await boundAccount(f);
    const data = await sms(f, a.uid, a.number);
    expect(data.user_id).toBe(a.uid);
    await assertHit(f.db, f.appId, a.uid, a.parentId, a.hash, kit.clock.now());
    await successfulLog(f, a.uid, 'sms', a.hash);
    await assertSilent(f.db, f.appId);
    const http = kit.app as unknown as {
      inject(request: {
        method: 'GET';
        url: string;
        headers: Record<string, string>;
      }): Promise<Response>;
    };
    const me = await http.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        'x-app-id': f.appId,
        'x-platform': 'ios',
        'x-device-id': f.device.deviceId,
        'x-app-version': '2.0.0',
        authorization: `Bearer ${data.tokens.access_token}`,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      code: 0,
      data: {
        user_id: a.uid,
        inviter_bound: false,
        invite_backfill: { eligible: false },
      },
    });
    const operation = kit.document.paths['/v1/me'] as unknown as {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: Parameters<typeof kit.compile>[0]['schema'];
              };
            };
          };
        };
      };
    };
    const validate = kit.compile({
      schema: operation.get.responses['200'].content['application/json'].schema,
      httpPart: 'body',
    });
    expect(validate(me.json()), JSON.stringify(validate.errors)).toBe(true);
  } finally {
    await closeOauthKit(kit);
  }
});

it.each(['wechat', 'apple'] as const)(
  '[AC-B1-11f#11] 真实 %s 登录注入同一复核，命中后仍登录成功且不会重复解除',
  async (provider) => {
    const kit = await openOauthKit();
    try {
      const f = await oauthFixture(kit);
      const a = await boundAccount(f, provider);
      await oauth(f, a.uid, provider);
      const at = kit.clock.now();
      await assertHit(f.db, f.appId, a.uid, a.parentId, a.hash, at);
      await successfulLog(f, a.uid, provider, a.hash);
      const after = await user(f.db, f.appId, a.uid);
      kit.clock.advanceMs(61_000);
      await oauth(f, a.uid, provider);
      const { expectRowOnlyLoginActivity } =
        await import('../../identity/reverify/login-activity.ts');
      expectRowOnlyLoginActivity(after, await user(f.db, f.appId, a.uid), {
        at: kit.clock.now(),
        hash: f.device.deviceHash,
      });
      await assertHit(f.db, f.appId, a.uid, a.parentId, a.hash, at);
      await successfulLog(f, a.uid, provider, a.hash, 2);
      await assertSilent(f.db, f.appId);
    } finally {
      await closeOauthKit(kit);
    }
  },
);

it.each(['sms', 'wechat'] as const)(
  '[AC-B1-11f#12] %s 首次异设备未命中，后来同设备登录不复核；新账号首次同设备才解除',
  async (method) => {
    const kit = await openOauthKit();
    try {
      const f = await oauthFixture(kit);
      const a = await boundAccount(f, method === 'sms' ? undefined : method);
      const other = await client(kit, f.appId);
      const before = await user(f.db, f.appId, a.uid);
      if (method === 'sms') await sms(f, a.uid, a.number, other);
      else await oauth(f, a.uid, method, other);
      const { expectRowOnlyLoginActivity } =
        await import('../../identity/reverify/login-activity.ts');
      expectRowOnlyLoginActivity(before, await user(f.db, f.appId, a.uid), {
        at: kit.clock.now(),
        hash: other.deviceHash,
      });
      expect(await relationLogs(f.db, f.appId)).toEqual([]);
      expect(await hits(f.db, f.appId)).toEqual([]);
      kit.clock.advanceMs(61_000);
      if (method === 'sms') await sms(f, a.uid, a.number);
      else await oauth(f, a.uid, method);
      const settled = await user(f.db, f.appId, a.uid);
      expectRowOnlyLoginActivity(before, settled, {
        at: kit.clock.now(),
        hash: f.device.deviceHash,
      });
      expect(await relationLogs(f.db, f.appId)).toEqual([]);
      expect(await hits(f.db, f.appId)).toEqual([]);
      await successfulLog(f, a.uid, method, a.hash, 2);
      // Positive control: prevents missing assembly from making this exclusion case pass.
      const b = await boundAccount(f, method === 'sms' ? undefined : method);
      kit.clock.advanceMs(61_000);
      if (method === 'sms') await sms(f, b.uid, b.number);
      else await oauth(f, b.uid, method);
      await assertHit(f.db, f.appId, b.uid, b.parentId, b.hash, kit.clock.now());
      expect(await user(f.db, f.appId, a.uid)).toEqual(settled);
      await assertSilent(f.db, f.appId);
    } finally {
      await closeOauthKit(kit);
    }
  },
);

it('[AC-B1-11f#13] 首次登录的 register 关系不复核；同一装配的 landing 关系必须复核', async () => {
  const kit = await openOauthKit();
  try {
    const f = await oauthFixture(kit);
    const a = await boundAccount(f);
    await f.db
      .updateTable('users')
      .set({ parent_bind_source: 'register' })
      .where('app_id', '=', f.appId)
      .where('id', '=', a.uid)
      .execute();
    const before = await user(f.db, f.appId, a.uid);
    await sms(f, a.uid, a.number);
    const settled = await user(f.db, f.appId, a.uid);
    const { expectRowOnlyLoginActivity } =
      await import('../../identity/reverify/login-activity.ts');
    expectRowOnlyLoginActivity(before, settled, { at: kit.clock.now(), hash: f.device.deviceHash });
    expect(await relationLogs(f.db, f.appId)).toEqual([]);
    expect(await hits(f.db, f.appId)).toEqual([]);
    const b = await boundAccount(f);
    await sms(f, b.uid, b.number);
    await assertHit(f.db, f.appId, b.uid, b.parentId, b.hash, kit.clock.now());
    expect(await user(f.db, f.appId, a.uid)).toEqual(settled);
  } finally {
    await closeOauthKit(kit);
  }
});

it('[AC-B1-11f#14] H5 登录不触发 App 复核，同一装配的首次 App 登录才触发', async () => {
  const kit = await openOauthKit();
  try {
    const f = await oauthFixture(kit);
    const a = await boundAccount(f, 'wechat');
    const before = await user(f.db, f.appId, a.uid);
    await oauth(f, a.uid, 'wechat', f.device, { 'x-platform': 'h5' });
    const { expectRowOnlyLoginActivity } =
      await import('../../identity/reverify/login-activity.ts');
    expectRowOnlyLoginActivity(before, await user(f.db, f.appId, a.uid), {
      at: kit.clock.now(),
      hash: f.device.deviceHash,
    });
    expect(await relationLogs(f.db, f.appId)).toEqual([]);
    expect(await hits(f.db, f.appId)).toEqual([]);
    const b = await boundAccount(f, 'wechat');
    kit.clock.advanceMs(61_000);
    await oauth(f, b.uid, 'wechat');
    await assertHit(f.db, f.appId, b.uid, b.parentId, b.hash, kit.clock.now());
  } finally {
    await closeOauthKit(kit);
  }
});

it('[AC-B1-11f#15] 首次短信未命中后改用微信同设备登录，也不能重新复核', async () => {
  const kit = await openOauthKit();
  try {
    const f = await oauthFixture(kit);
    const a = await boundAccount(f);
    await f.db
      .insertInto('user_oauth')
      .values({
        id: randomUUID(),
        app_id: f.appId,
        user_id: a.uid,
        provider: 'wechat',
        union_id: `union-${randomUUID()}`,
      })
      .execute();
    const before = await user(f.db, f.appId, a.uid);
    const other = await client(kit, f.appId);
    await sms(f, a.uid, a.number, other);
    kit.clock.advanceMs(61_000);
    await oauth(f, a.uid, 'wechat');
    const { expectRowOnlyLoginActivity } =
      await import('../../identity/reverify/login-activity.ts');
    expectRowOnlyLoginActivity(before, await user(f.db, f.appId, a.uid), {
      at: kit.clock.now(),
      hash: f.device.deviceHash,
    });
    expect(await relationLogs(f.db, f.appId)).toEqual([]);
    expect(await hits(f.db, f.appId)).toEqual([]);
    await successfulLog(f, a.uid, 'wechat', a.hash, 2);
    const b = await boundAccount(f, 'wechat');
    kit.clock.advanceMs(61_000);
    await oauth(f, b.uid, 'wechat');
    await assertHit(f.db, f.appId, b.uid, b.parentId, b.hash, kit.clock.now());
  } finally {
    await closeOauthKit(kit);
  }
});
