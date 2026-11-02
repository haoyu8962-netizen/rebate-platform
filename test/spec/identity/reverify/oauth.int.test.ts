// B1-02zp §9 #8, #10 (BR-WDR-01 细则「加验依据」; contract reverifyByOauth, createOauthAttempt
// purpose=reverify): the separate "verify an existing third-party identity" flow. Only the
// provider exchange is a test double; attempts, identities and counters are real.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ATTEMPTS,
  BY_OAUTH,
  FAIL_LIMIT,
  LOGIN,
  NOT_REQUIRED,
  PENDING_MANUAL,
  SECOND,
  TODAY,
  attemptOf,
  closeKit,
  envelope,
  fixture,
  mismatch,
  oauthBody,
  oauthRequired,
  openKit,
  passed,
  pending,
  statusOf,
  trustedOf,
  type Fixture,
  type Kit,
  type Provider,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const ATTEMPT_TTL_MS = 600 * SECOND;

/** An account with a bound phone, flagged with `provider` as its trusted identity. */
async function flagged(f: Fixture, provider: Provider = 'wechat') {
  const { uid } = await f.user();
  const device = await f.device();
  const unionId = await f.bind(uid, provider);
  await f.flag(uid, { realname: false, providers: [provider] });
  return { uid, device, unionId, c: f.client(uid, device) };
}

it.each(['wechat', 'apple', 'huawei'] as const)(
  '[AC-B1-02zp#70] %s 授权身份与可信身份一致 → passed（已绑手机也能用），只记本设备，不发 step_up_token',
  async (provider) => {
    const f = await fixture(kit);
    const { uid, device, unionId, c } = await flagged(f, provider);
    const other = await f.device();
    await f.failures(uid, 2);
    const attempt = attemptOf(kit, await c.attempt(provider));
    kit.exchange.mockResolvedValue({ union_id: unionId });
    const body = oauthBody(provider, attempt.attempt_id);
    passed(kit, BY_OAUTH, await c.byOauth(body));
    expect(kit.exchange).toHaveBeenCalledTimes(1);
    expect(kit.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ provider, nonce: attempt.nonce }),
    );
    expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
    const state = await f.state(uid);
    expect(state.reverify_flagged_at).not.toBeNull();
    expect(state.reverify_fail_count).toBe(0);
    expect(trustedOf(state)).toEqual({ realname: false, providers: [provider] });
    expect(statusOf(kit, await c.status())).toEqual(NOT_REQUIRED);
    expect(statusOf(kit, await f.client(uid, other).status())).toEqual(
      oauthRequired([provider], FAIL_LIMIT),
    );
  },
);

it('[AC-B1-02zp#71] 授权回来是另一个身份 → 20005 带 fail_limit、fail_remaining，计失败，不记设备；尝试已用，重交 → 20004 不再计', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
  const body = oauthBody('wechat', attempt.attempt_id);
  mismatch(kit, BY_OAUTH, await c.byOauth(body), FAIL_LIMIT - 1);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TODAY });
  expect(await f.devices(uid)).toEqual([]);
  envelope(kit, BY_OAUTH, await c.byOauth(body), 20004);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1 });
});

it('[AC-B1-02zp#72] 别的账号绑定的身份也算不符 → 20005', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const someone = await f.user();
  const theirs = await f.bind(someone.uid, 'wechat');
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ union_id: theirs });
  mismatch(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', attempt.attempt_id)), 4);
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#73] 凭证无效（上游答 invalid）→ 20004，不计失败、不记设备', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 2);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ invalid: true });
  envelope(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', attempt.attempt_id)), 20004);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 2 });
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#74] 授权尝试无效（不存在、过期、别的设备、别的用途、别的 provider）→ 20004，不计失败、不换取身份', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const [device, other] = [await f.device(), await f.device()];
  await f.bind(uid, 'wechat');
  await f.bind(uid, 'apple');
  await f.flag(uid, { realname: false, providers: ['wechat', 'apple'] });
  await f.failures(uid, 2);
  const c = f.client(uid, device);
  const expectRefused = async (body: object) => {
    envelope(kit, BY_OAUTH, await c.byOauth(body), 20004);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 2 });
  };

  await expectRefused(oauthBody('wechat', randomUUID()));

  const foreign = attemptOf(kit, await f.client(uid, other).attempt('wechat'));
  await expectRefused(oauthBody('wechat', foreign.attempt_id));

  const login = attemptOf(
    kit,
    await f.post(device, ATTEMPTS, { provider: 'wechat', purpose: 'login' }),
  );
  await expectRefused(oauthBody('wechat', login.attempt_id));

  const wrongProvider = attemptOf(kit, await c.attempt('apple'));
  await expectRefused(oauthBody('wechat', wrongProvider.attempt_id));

  const expired = attemptOf(kit, await c.attempt('wechat'));
  kit.clock.advanceMs(ATTEMPT_TTL_MS);
  await expectRefused(oauthBody('wechat', expired.attempt_id));

  expect(kit.exchange).not.toHaveBeenCalled();
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#75] 上游不可用（答 unavailable 或抛错）→ 50305 带 provider，不计失败、不记设备', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 3);
  const first = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ unavailable: true });
  const answered = envelope(
    kit,
    BY_OAUTH,
    await c.byOauth(oauthBody('wechat', first.attempt_id)),
    50305,
  );
  expect(answered.data).toMatchObject({ provider: 'wechat' });
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 3 });

  const second = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockRejectedValue(new Error('provider timeout'));
  const thrown = envelope(
    kit,
    BY_OAUTH,
    await c.byOauth(oauthBody('wechat', second.attempt_id)),
    50305,
  );
  expect(thrown.data).toMatchObject({ provider: 'wechat' });
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 3 });
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#76] purpose=reverify 的授权尝试：provider 不在可信身份里 → 20001 fields=[provider]；可信的才发（已绑手机也发）', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.bind(uid, 'apple');
  const refused = envelope(kit, ATTEMPTS, await c.attempt('apple'), 20001);
  expect(refused.data).toMatchObject({ fields: ['provider'] });
  expect(attemptOf(kit, await c.attempt('wechat')).attempt_id).toEqual(expect.any(String));
});

it('[AC-B1-02zp#77] 无标记账号要 purpose=reverify 的授权尝试 → 20001 fields=[provider]（没有可信身份）', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const device = await f.device();
  await f.bind(uid, 'wechat');
  const refused = envelope(kit, ATTEMPTS, await f.client(uid, device).attempt('wechat'), 20001);
  expect(refused.data).toMatchObject({ fields: ['provider'] });
});

it.each(['id_number', 'manual'] as const)(
  '[AC-B1-02zp#78] 可信身份没有第三方（当前方式 %s）→ 提交回 10010，不计失败、不记设备',
  async (method) => {
    const f = await fixture(kit);
    const { uid, unionId, c } = await flagged(f);
    const attempt = attemptOf(kit, await c.attempt('wechat'));
    // The attempt was issued under the earlier snapshot, so only the identities can refuse it.
    const realname = method === 'id_number';
    await f.flag(uid, { realname, providers: [] });
    kit.exchange.mockResolvedValue({ union_id: unionId });
    pending(
      kit,
      BY_OAUTH,
      await c.byOauth(oauthBody('wechat', attempt.attempt_id)),
      realname ? { method, fail_limit: FAIL_LIMIT } : PENDING_MANUAL,
    );
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
    expect(await f.devices(uid)).toEqual([]);
  },
);

it('[AC-B1-02zp#79] 无标记账号、本设备已加验再提交 → passed，不新增设备行、不计失败', async () => {
  const f = await fixture(kit);
  const cleared = await flagged(f);
  const attempt = attemptOf(kit, await cleared.c.attempt('wechat'));
  await f.unflag(cleared.uid);
  kit.exchange.mockResolvedValue({ union_id: cleared.unionId });
  passed(kit, BY_OAUTH, await cleared.c.byOauth(oauthBody('wechat', attempt.attempt_id)));
  expect(await f.devices(cleared.uid)).toEqual([]);
  expect(await f.state(cleared.uid)).toMatchObject({ reverify_fail_count: 0 });

  const done = await flagged(f);
  const second = attemptOf(kit, await done.c.attempt('wechat'));
  await f.reverified(done.uid, done.device);
  await f.failures(done.uid, 2);
  passed(kit, BY_OAUTH, await done.c.byOauth(oauthBody('wechat', second.attempt_id)));
  expect(await f.devices(done.uid)).toEqual([{ device_hash: done.device.hash, source: 'self' }]);
  expect(await f.state(done.uid)).toMatchObject({ reverify_fail_count: 2 });
});

it('[AC-B1-02zp#80] 用途隔离：reverify 的尝试不能拿去登录（20004，尝试不被消费），回到本接口仍可用', async () => {
  const f = await fixture(kit);
  const { uid, device, unionId, c } = await flagged(f);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ union_id: unionId });
  const login = await f.post(device, LOGIN.wechat, {
    attempt_id: attempt.attempt_id,
    code: `wechat-code-${randomUUID()}`,
    legal_versions: { privacy: 7, agreement: 4 },
    consent_at: kit.clock.now().toISOString(),
  });
  expect(login.statusCode).toBe(400);
  expect(login.json()).toMatchObject({ code: 20004 });
  expect(kit.exchange).not.toHaveBeenCalled();
  passed(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', attempt.attempt_id)));
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
});

it('[AC-B1-02zp#81] 幂等：20005 不写结果，同键换新尝试每次都计；通过写结果，同键同体重放不再换取身份', async () => {
  const f = await fixture(kit);
  const { uid, device, unionId, c } = await flagged(f);
  const key = randomUUID();
  kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
  for (const remaining of [4, 3]) {
    const attempt = attemptOf(kit, await c.attempt('wechat'));
    const body = oauthBody('wechat', attempt.attempt_id);
    mismatch(kit, BY_OAUTH, await c.byOauth(body, { key }), remaining);
  }
  expect(await f.idempotencyRows(BY_OAUTH)).toEqual([]);

  const attempt = attemptOf(kit, await c.attempt('wechat'));
  const body = oauthBody('wechat', attempt.attempt_id);
  kit.exchange.mockReset().mockResolvedValue({ union_id: unionId });
  passed(kit, BY_OAUTH, await c.byOauth(body, { key }));
  passed(kit, BY_OAUTH, await c.byOauth(body, { key }));
  expect(kit.exchange).toHaveBeenCalledTimes(1);
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  // Without an idempotency result the replay would also answer passed (device already
  // re-verified); the completed row and the 20901 tell the two apart.
  const records = await f.idempotencyRows(BY_OAUTH);
  expect(records).toHaveLength(1);
  expect(records[0]!.status).toBe('completed');
  envelope(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', attempt.attempt_id), { key }), 20901);
  expect(kit.exchange).toHaveBeenCalledTimes(1);
});

it('[AC-B1-02zp#106] 缺 Idempotency-Key → 20001，不换取身份、不计失败、不记设备', async () => {
  const f = await fixture(kit);
  const { uid, unionId, c } = await flagged(f);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ union_id: unionId });
  const body = oauthBody('wechat', attempt.attempt_id);
  envelope(kit, BY_OAUTH, await c.byOauth(body, { noKey: true }), 20001);
  expect(kit.exchange).not.toHaveBeenCalled();
  expect(await f.devices(uid)).toEqual([]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
});
