// B1-02zp §9 #1–#5 (BR-WDR-01 细则「判定」): every login overwrites last_active_at and
// last_login_device_hash; a login judges on the values from before that overwrite; a refresh only
// overwrites. Real logins and refreshes over the real switch and the injected Clock.
//
// Every "no flag" test also asserts the overwrite, so it is red until the overwrite exists rather
// than green because nothing flags yet.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { phone } from '../sms-codes/kit.ts';
import {
  DAY,
  DORMANT,
  HOUR,
  RESTRICTED,
  SECOND,
  SMS_LOGIN,
  ago,
  closeKit,
  fixture,
  openKit,
  trustedOf,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-02zp#10] 短信登录覆盖最近活动与上次登录设备（未到期，不打标）', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, DAY), earlier.hash);
  expect((await f.smsLogin(number, current)).user_id).toBe(uid);
  expect(await f.state(uid)).toMatchObject({
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_flagged_at: null,
    reverify_trusted: null,
  });
});

it.each(['wechat', 'apple'] as const)(
  '[AC-B1-02zp#11] %s 登录覆盖最近活动与上次登录设备（未到期，不打标）',
  async (provider) => {
    const f = await fixture(kit);
    const [earlier, current] = [await f.device(), await f.device()];
    const { uid } = await f.user();
    const unionId = await f.bind(uid, provider);
    await f.active(uid, ago(kit, DAY), earlier.hash);
    expect((await f.oauthLogin(provider, unionId, current)).user_id).toBe(uid);
    expect(await f.state(uid)).toMatchObject({
      last_active_at: kit.clock.now(),
      last_login_device_hash: current.hash,
      reverify_flagged_at: null,
    });
  },
);

it('[AC-B1-02zp#12] 刷新只覆盖、不判定：久未活动且设备不同也不打标', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, DAY), current.hash);
  const login = await f.smsLogin(number, current);
  kit.clock.advanceMs(HOUR);
  await f.active(uid, ago(kit, 2 * DORMANT), earlier.hash);
  await f.refresh(login.tokens.refresh_token, current);
  expect(await f.state(uid)).toMatchObject({
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_flagged_at: null,
    reverify_trusted: null,
  });
});

it('[AC-B1-02zp#13] 边界：距最近活动恰好等于开关天数且设备不同 → 打标，记注入时钟的时刻；账号没有余额也打（不看余额）', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  await f.smsLogin(number, current);
  const state = await f.state(uid);
  expect(state).toMatchObject({
    reverify_flagged_at: kit.clock.now(),
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_fail_count: 0,
  });
  expect(trustedOf(state)).toEqual({ realname: false, providers: [] });
});

it('[AC-B1-02zp#14] 边界：差 1 秒不到开关天数 → 不打标，照常覆盖', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, DORMANT - SECOND), earlier.hash);
  await f.smsLogin(number, current);
  expect(await f.state(uid)).toMatchObject({
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_flagged_at: null,
    reverify_trusted: null,
  });
});

it('[AC-B1-02zp#15] 开关 0 表示关闭：久未活动且设备不同也不打标，照常覆盖', async () => {
  const f = await fixture(kit, { days: 0 });
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, 10 * DORMANT), earlier.hash);
  await f.smsLogin(number, current);
  expect(await f.state(uid)).toMatchObject({
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_flagged_at: null,
    reverify_trusted: null,
  });
});

it('[AC-B1-02zp#16] 开关值来自真实配置：配 30 天时 30 天打标、差 1 秒不打', async () => {
  const f = await fixture(kit, { days: 30 });
  const [earlier, current] = [await f.device(), await f.device()];
  const due = await f.user();
  const short = await f.user();
  await f.active(due.uid, ago(kit, 30 * DAY), earlier.hash);
  await f.active(short.uid, ago(kit, 30 * DAY - SECOND), earlier.hash);
  await f.smsLogin(due.number, current);
  await f.smsLogin(short.number, current);
  expect(await f.state(due.uid)).toMatchObject({
    reverify_flagged_at: kit.clock.now(),
    last_active_at: kit.clock.now(),
  });
  expect(await f.state(short.uid)).toMatchObject({
    reverify_flagged_at: null,
    last_active_at: kit.clock.now(),
  });
});

it('[AC-B1-02zp#17] 同一台设备久未登录不打标（判定比的是覆盖之前的上次登录设备）', async () => {
  const f = await fixture(kit);
  const current = await f.device();
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, 2 * DORMANT), current.hash);
  await f.smsLogin(number, current);
  expect(await f.state(uid)).toMatchObject({
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_flagged_at: null,
    reverify_trusted: null,
  });
});

it('[AC-B1-02zp#18] 新注册账号首次登录不打标，两项写入本次的值', async () => {
  const f = await fixture(kit);
  const current = await f.device();
  const login = await f.smsLogin(phone('137'), current);
  expect(login.is_new_user).toBe(true);
  expect(await f.state(login.user_id)).toMatchObject({
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_flagged_at: null,
    reverify_trusted: null,
  });
});

it('[AC-B1-02zp#19] 可信身份固定打标这一刻之前已完成的实名与已绑第三方，别人的不算', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  const other = await f.user();
  await f.realname(uid);
  await f.bind(uid, 'wechat');
  await f.bind(uid, 'apple');
  await f.bind(other.uid, 'huawei');
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  await f.smsLogin(number, current);
  expect(trustedOf(await f.state(uid))).toEqual({
    realname: true,
    providers: ['apple', 'wechat'],
  });
});

it('[AC-B1-02zp#20] 没有完成的实名（核验失败的记录）不进可信身份', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.failedRealname(uid);
  await f.bind(uid, 'wechat');
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  await f.smsLogin(number, current);
  expect(trustedOf(await f.state(uid))).toEqual({ realname: false, providers: ['wechat'] });
});

it.each(['wechat', 'apple'] as const)(
  '[AC-B1-02zp#21] %s 登录同样判定（任一登录方式）：打标并固定可信身份',
  async (provider) => {
    const f = await fixture(kit);
    const [earlier, current] = [await f.device(), await f.device()];
    const { uid } = await f.user();
    const unionId = await f.bind(uid, provider);
    await f.active(uid, ago(kit, DORMANT), earlier.hash);
    await f.oauthLogin(provider, unionId, current);
    const state = await f.state(uid);
    expect(state).toMatchObject({
      reverify_flagged_at: kit.clock.now(),
      last_active_at: kit.clock.now(),
      last_login_device_hash: current.hash,
    });
    expect(trustedOf(state)).toEqual({ realname: false, providers: [provider] });
  },
);

it('[AC-B1-02zp#22] 受限登录（deletion_only 会话）也是建立会话，同样覆盖与判定', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  const login = await f.smsLogin(number, current, RESTRICTED);
  expect(login.tokens.session_scope).toBe('deletion_only');
  expect(await f.state(uid)).toMatchObject({
    reverify_flagged_at: kit.clock.now(),
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
  });
});

it('[AC-B1-02zp#23] 已有标记不重判：之后的登录不动打标时刻与可信身份，新实名、新绑定都不进去，活动照常覆盖', async () => {
  const f = await fixture(kit);
  const [earlier, first, second] = [await f.device(), await f.device(), await f.device()];
  const { uid } = await f.user();
  const unionId = await f.bind(uid, 'wechat');
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  await f.oauthLogin('wechat', unionId, first);
  const flaggedAt = kit.clock.now();
  expect(await f.state(uid)).toMatchObject({ reverify_flagged_at: flaggedAt });

  kit.clock.advanceMs(DAY);
  await f.realname(uid);
  await f.bind(uid, 'apple');
  await f.active(uid, ago(kit, 2 * DORMANT), earlier.hash);
  await f.oauthLogin('wechat', unionId, second);
  const state = await f.state(uid);
  expect(state).toMatchObject({
    reverify_flagged_at: flaggedAt,
    last_active_at: kit.clock.now(),
    last_login_device_hash: second.hash,
  });
  expect(trustedOf(state)).toEqual({ realname: false, providers: ['wechat'] });
});

it('[AC-B1-02zp#24] 标记打上后，刷新与同设备登录都不清除它', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  const login = await f.smsLogin(number, current);
  const flaggedAt = kit.clock.now();

  kit.clock.advanceMs(HOUR);
  await f.refresh(login.tokens.refresh_token, current);
  expect(await f.state(uid)).toMatchObject({
    reverify_flagged_at: flaggedAt,
    last_active_at: kit.clock.now(),
  });

  kit.clock.advanceMs(HOUR);
  await f.smsLogin(number, current);
  const state = await f.state(uid);
  expect(state).toMatchObject({
    reverify_flagged_at: flaggedAt,
    last_active_at: kit.clock.now(),
  });
  expect(trustedOf(state)).toEqual({ realname: false, providers: [] });
});

it('[AC-B1-02zp#25] 登录失败不是建立会话：验证码错误时不覆盖、不判定', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.smsLogin(number, current);
  expect(await f.state(uid)).toMatchObject({ last_active_at: kit.clock.now() });

  kit.clock.advanceMs(HOUR);
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  const before = await f.state(uid);
  const code = await f.sendLoginCode(number, current);
  const wrong = code === '000000' ? '000001' : '000000';
  const response = await f.post(current, SMS_LOGIN, f.smsBody(number, wrong));
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20002 });
  expect(await f.state(uid)).toEqual(before);
});

it('[AC-B1-02zp#108] 配置行缺失取注册表缺省 0（关闭，D10-567 ②）：久未活动且设备不同也不打标，照常覆盖', async () => {
  const f = await fixture(kit, { days: null });
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.active(uid, ago(kit, 10 * DORMANT), earlier.hash);
  await f.smsLogin(number, current);
  expect(await f.state(uid)).toMatchObject({
    last_active_at: kit.clock.now(),
    last_login_device_hash: current.hash,
    reverify_flagged_at: null,
    reverify_trusted: null,
  });
});

it.each([
  { gap: '最近活动与上次登录设备都为空', hasActivity: false, hasDevice: false },
  { gap: '最近活动为空', hasActivity: false, hasDevice: true },
  { gap: '上次登录设备为空', hasActivity: true, hasDevice: false },
])(
  '[AC-B1-02zp#109] $gap：不打标，只写入本次的值（D10-567 ③）',
  async ({ hasActivity, hasDevice }) => {
    const f = await fixture(kit);
    const [earlier, current] = [await f.device(), await f.device()];
    const { uid, number } = await f.user();
    await f.active(
      uid,
      hasActivity ? ago(kit, 2 * DORMANT) : null,
      hasDevice ? earlier.hash : null,
    );
    await f.smsLogin(number, current);
    expect(await f.state(uid)).toMatchObject({
      last_active_at: kit.clock.now(),
      last_login_device_hash: current.hash,
      reverify_flagged_at: null,
      reverify_trusted: null,
    });
  },
);
