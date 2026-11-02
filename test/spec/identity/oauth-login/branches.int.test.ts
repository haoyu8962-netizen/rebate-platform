// B1-02d: account branches of the third-party logins — restricted login (BR-ID-01 细则「受限登录」),
// status=deleting (BR-ID-27), banned users (BR-ID-31), the same-device limit (BR-ID-05) and the
// concurrent first login (BR-ID-04 细则「并发的首次登录」).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  APPLE_REFRESH_CONTEXT,
  LOGIN,
  RESTRICTED,
  accepted,
  column,
  fixture,
  gate,
  issueSession,
  loginBody,
  openOauthKit,
  closeOauthKit,
  rejected,
  rows,
  type OauthKit,
} from './kit.ts';

let kit: OauthKit;
beforeAll(async () => {
  kit = await openOauthKit();
}, 180_000);
afterAll(async () => {
  await closeOauthKit(kit);
});

const PROVIDERS = ['wechat', 'apple'] as const;

it.each(PROVIDERS)(
  '[AC-B1-02d#15][BR-ID-01] %s 受限登录查不到绑定 → 403/10405 no_account：不建号、不写同意与日志、尝试已消费',
  async (provider) => {
    const f = await fixture(kit);
    kit.exchange.mockResolvedValue({
      union_id: `union-${randomUUID()}`,
      ...(provider === 'apple' ? { apple_refresh_token: `apple-refresh-${randomUUID()}` } : {}),
    });
    const attempt = await f.device.attempt(provider, RESTRICTED);
    const body = loginBody(provider, attempt.attempt_id);
    const before = await rows(f);
    const response = await f.device.post(LOGIN[provider], body, RESTRICTED);
    rejected(kit, LOGIN[provider], response, 10405, { reason: 'no_account' });
    expect(kit.exchange).toHaveBeenCalledTimes(1);
    expect(await rows(f)).toEqual(before);
    rejected(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body, RESTRICTED), 20004);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#16][BR-ID-01] %s 受限登录查到已绑账号 → deletion_only 会话，is_new_user=false，同意与日志照常写',
  async (provider) => {
    const f = await fixture(kit);
    const bound = await f.account(provider);
    const refresh = `apple-refresh-${randomUUID()}`;
    kit.exchange.mockResolvedValue({
      union_id: bound.unionId,
      ...(provider === 'apple' ? { apple_refresh_token: refresh } : {}),
    });
    const attempt = await f.device.attempt(provider, RESTRICTED);
    const before = await rows(f);
    const data = accepted(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id), RESTRICTED),
    );
    expect(data).toMatchObject({
      user_id: bound.uid,
      is_new_user: false,
      tokens: { session_scope: 'deletion_only' },
    });
    expect(await f.tokens.verifyAccess(data.tokens.access_token)).toMatchObject({
      uid: bound.uid,
      scp: 'deletion_only',
    });
    const after = await rows(f);
    const { expectOnlyLoginActivity } = await import('../reverify/login-activity.ts');
    expectOnlyLoginActivity(before.users, after.users, {
      uid: bound.uid,
      at: kit.clock.now(),
      hash: f.device.deviceHash,
    });
    expect(after.registrations).toEqual(before.registrations);
    expect(after.sessions.filter((row) => row.user_id === bound.uid)).toHaveLength(1);
    expect(
      after.consents.filter((row) => row.user_id === bound.uid && row.channel === 'login_page'),
    ).toHaveLength(2);
    expect(after.logs.filter((row) => row.user_id === bound.uid)).toEqual([
      expect.objectContaining({ method: provider }),
    ]);
    const cipher = column(after.oauth[0], 'apple_refresh_token_cipher');
    if (provider === 'apple') {
      expect(Buffer.isBuffer(cipher)).toBe(true);
      expect(f.crypto.decrypt((cipher as Buffer).toString('utf8'), APPLE_REFRESH_CONTEXT)).toBe(
        refresh,
      );
    } else {
      expect(cipher).toBeNull();
    }
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#17][BR-ID-27] %s 绑定账号 status=deleting → 403/10007 data.stage=processing，不建号、不签发',
  async (provider) => {
    const f = await fixture(kit);
    const bound = await f.account(provider, 'deleting');
    kit.exchange.mockResolvedValue({ union_id: bound.unionId });
    const attempt = await f.device.attempt(provider);
    const before = await rows(f);
    rejected(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id)),
      10007,
      { stage: 'processing' },
    );
    expect(await rows(f)).toEqual(before);
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#18][BR-ID-31] %s 封禁用户（即使带自己的令牌）照常登录，不返回 10006',
  async (provider) => {
    const f = await fixture(kit);
    const bound = await f.account(provider);
    await f.db
      .insertInto('user_risk_state')
      .values({
        user_id: bound.uid,
        app_id: f.appId,
        state: 'banned',
        reason_category: 'other',
        changed_by: 'test',
        changed_at: kit.clock.now(),
      })
      .execute();
    const session = await issueSession(f, bound.uid);
    kit.exchange.mockResolvedValue({ union_id: bound.unionId });
    const attempt = await f.device.attempt(provider);
    const data = accepted(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id), {
        authorization: `Bearer ${session.access_token}`,
      }),
    );
    expect(data).toMatchObject({ user_id: bound.uid, is_new_user: false });
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#19][BR-ID-05] %s 首次登录撞同设备注册上限 → 403/44001，不建号、不写 user_oauth',
  async (provider) => {
    const f = await fixture(kit);
    for (let i = 0; i < 3; i++) {
      const uid = (await f.account('wechat')).uid;
      await f.db
        .insertInto('device_registrations')
        .values({
          app_id: f.appId,
          device_hash: f.device.deviceHash,
          user_id: uid,
          register_method: 'wechat',
          created_at: new Date(kit.clock.now().getTime() - 1000),
        })
        .execute();
    }
    kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
    const attempt = await f.device.attempt(provider);
    const before = await rows(f);
    rejected(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id)),
      44001,
    );
    expect(await rows(f)).toEqual(before);
  },
);

it.each(PROVIDERS)(
  '[AC-B1-02d#20][BR-ID-04] %s 同一身份两个首次登录并发：只建一个号，两次各得一个会话，后到者 is_new_user=false',
  async (provider) => {
    const f = await fixture(kit);
    const unionId = `union-${randomUUID()}`;
    kit.exchange.mockImplementation(gate(2, { union_id: unionId }));
    const first = await f.device.attempt(provider);
    const second = await f.device.attempt(provider);
    const responses = await Promise.all([
      f.device.post(LOGIN[provider], loginBody(provider, first.attempt_id)),
      f.device.post(LOGIN[provider], loginBody(provider, second.attempt_id)),
    ]);
    const data = responses.map((response) => accepted(kit, LOGIN[provider], response));
    expect(data[0]!.user_id).toBe(data[1]!.user_id);
    expect(data.map((item) => item.is_new_user).sort()).toEqual([false, true]);
    expect(kit.exchange).toHaveBeenCalledTimes(2);
    const state = await rows(f);
    expect(state.users).toHaveLength(1);
    expect(state.oauth).toEqual([
      expect.objectContaining({ user_id: data[0]!.user_id, provider, union_id: unionId }),
    ]);
    // The later login does not count as a second registration on this device.
    expect(state.registrations).toHaveLength(1);
    expect(state.sessions.filter((row) => row.user_id === data[0]!.user_id)).toHaveLength(2);
    expect(state.logs.filter((row) => row.user_id === data[0]!.user_id)).toHaveLength(2);
    expect(
      state.consents.filter(
        (row) => row.user_id === data[0]!.user_id && row.channel === 'login_page',
      ),
    ).toHaveLength(4);
  },
);
