// B1-02zp §9 #6, #12: GET /v1/me/reverify, and who may reach the three interfaces. Flags and
// failure counters are seeded on the columns of migration 0111; the request is real.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BY_ID,
  BY_OAUTH,
  ATTEMPTS,
  DORMANT,
  FAIL_LIMIT,
  ID,
  MANUAL_REQUIRED,
  MIDNIGHT,
  NOT_REQUIRED,
  RESTRICTED,
  STATUS,
  YESTERDAY,
  ago,
  attemptOf,
  closeKit,
  envelope,
  fixture,
  idNumberRequired,
  oauthBody,
  oauthRequired,
  openKit,
  statusOf,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-02zp#30] 无标记 → required false，其余 null / 空', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const device = await f.device();
  await f.realname(uid);
  await f.bind(uid, 'wechat');
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(NOT_REQUIRED);
});

it.each(['self', 'admin'] as const)(
  '[AC-B1-02zp#31] 有标记但本设备已加验（source=%s）→ required false；别的设备仍要加验',
  async (source) => {
    const f = await fixture(kit);
    const { uid } = await f.user();
    const [verified, other] = [await f.device(), await f.device()];
    await f.flag(uid, { realname: true, providers: [] });
    await f.reverified(uid, verified, source);
    expect(statusOf(kit, await f.client(uid, verified).status())).toEqual(NOT_REQUIRED);
    expect(statusOf(kit, await f.client(uid, other).status())).toEqual(
      idNumberRequired(FAIL_LIMIT),
    );
  },
);

it('[AC-B1-02zp#32] 可信身份含实名 → id_number 优先；同时有第三方时 providers 仍为空', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const device = await f.device();
  await f.flag(uid, { realname: true, providers: ['wechat'] });
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(idNumberRequired(FAIL_LIMIT));
});

it('[AC-B1-02zp#33] 可信身份只有第三方 → oauth，providers 只列可信的，打标后新绑的不列', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const device = await f.device();
  await f.bind(uid, 'wechat');
  await f.bind(uid, 'apple');
  await f.flag(uid, { realname: false, providers: ['wechat'] });
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(
    oauthRequired(['wechat'], FAIL_LIMIT),
  );
});

it('[AC-B1-02zp#34] 可信身份两样都没有 → manual，providers 空，fail_* 为 null', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const device = await f.device();
  await f.flag(uid, { realname: false, providers: [] });
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(MANUAL_REQUIRED);
});

it('[AC-B1-02zp#35] 打标后才完成的实名不算：method 按固定的可信身份给', async () => {
  const f = await fixture(kit);
  const { uid } = await f.user();
  const device = await f.device();
  await f.realname(uid);
  await f.flag(uid, { realname: false, providers: [] });
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(MANUAL_REQUIRED);
});

it('[AC-B1-02zp#36] fail_remaining 按当天（+08:00）失败数，前一天的计数不算', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const today = await f.user();
  await f.flag(today.uid, { realname: true, providers: [] });
  await f.failures(today.uid, 2);
  expect(statusOf(kit, await f.client(today.uid, device).status())).toEqual(idNumberRequired(3));

  const earlier = await f.user();
  await f.flag(earlier.uid, { realname: true, providers: [] });
  await f.failures(earlier.uid, 4, YESTERDAY);
  expect(statusOf(kit, await f.client(earlier.uid, device).status())).toEqual(
    idNumberRequired(FAIL_LIMIT),
  );
});

it('[AC-B1-02zp#37] 当天失败满 5 次转 manual，providers 空、fail_* 为 null；+08:00 次日恢复', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const { uid } = await f.user();
  await f.flag(uid, { realname: false, providers: ['wechat'] });
  await f.failures(uid, FAIL_LIMIT);
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(MANUAL_REQUIRED);
  kit.clock.set(MIDNIGHT);
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(
    oauthRequired(['wechat'], FAIL_LIMIT),
  );
});

it('[AC-B1-02zp#38] 查询本身不改账号：标记、计数、已加验设备都不变', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const { uid } = await f.user();
  await f.flag(uid, { realname: true, providers: [] });
  await f.failures(uid, 2);
  const before = await f.state(uid);
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(idNumberRequired(3));
  expect(await f.state(uid)).toEqual(before);
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#39] 登录打标后，本次设备与旧设备都要加验（端到端）', async () => {
  const f = await fixture(kit);
  const [earlier, current] = [await f.device(), await f.device()];
  const { uid, number } = await f.user();
  await f.realname(uid);
  await f.active(uid, ago(kit, DORMANT), earlier.hash);
  await f.smsLogin(number, current);
  expect(statusOf(kit, await f.client(uid, current).status())).toEqual(
    idNumberRequired(FAIL_LIMIT),
  );
  expect(statusOf(kit, await f.client(uid, earlier).status())).toEqual(
    idNumberRequired(FAIL_LIMIT),
  );
});

it('[AC-B1-02zp#40] 未登录 → 10001（三接口）', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const { uid } = await f.user();
  const c = f.client(uid, device);
  envelope(kit, STATUS, await c.status({ guest: true }), 10001, 'get');
  envelope(kit, BY_ID, await c.byId(ID, { guest: true }), 10001);
  envelope(
    kit,
    BY_OAUTH,
    await c.byOauth(oauthBody('wechat', randomUUID()), { guest: true }),
    10001,
  );
  // purpose=reverify requires a logged-in user too.
  envelope(kit, ATTEMPTS, await c.attempt('wechat', { guest: true }), 10001);
});

it('[AC-B1-02zp#41] deletion_only 会话不提供自助加验：三接口与 purpose=reverify 的授权尝试都 → 10405，不动账号', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const { uid } = await f.user();
  await f.realname(uid);
  await f.bind(uid, 'wechat');
  await f.flag(uid, { realname: true, providers: ['wechat'] });
  const before = await f.state(uid);
  const c = f.client(uid, device, 'deletion_only');
  envelope(kit, STATUS, await c.status(), 10405, 'get');
  envelope(kit, BY_ID, await c.byId(ID), 10405);
  envelope(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', randomUUID())), 10405);
  envelope(kit, ATTEMPTS, await c.attempt('wechat'), 10405);
  expect(await f.state(uid)).toEqual(before);
  expect(await f.devices(uid)).toEqual([]);
  expect(kit.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-02zp#42] 封禁账号不在 10006 白名单：三接口都 → 10006，不动账号（白名单不因本项增加接口）', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const { uid } = await f.user();
  await f.realname(uid);
  await f.flag(uid, { realname: true, providers: ['wechat'] });
  await f.ban(uid);
  const before = await f.state(uid);
  const c = f.client(uid, device);
  envelope(kit, STATUS, await c.status(), 10006, 'get');
  envelope(kit, BY_ID, await c.byId(ID), 10006);
  envelope(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', randomUUID())), 10006);
  expect(await f.state(uid)).toEqual(before);
  expect(await f.devices(uid)).toEqual([]);
});

it('[AC-B1-02zp#43] 版本闸：低于最低版本时提交接口 → 10405；GET 不受版本闸', async () => {
  const f = await fixture(kit);
  const device = await f.device();
  const { uid } = await f.user();
  await f.realname(uid);
  await f.bind(uid, 'wechat');
  await f.flag(uid, { realname: true, providers: ['wechat'] });
  const c = f.client(uid, device);
  const headers = RESTRICTED;
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  envelope(kit, BY_ID, await c.byId(ID, { headers }), 10405);
  const body = oauthBody('wechat', attempt.attempt_id);
  envelope(kit, BY_OAUTH, await c.byOauth(body, { headers }), 10405);
  expect(statusOf(kit, await c.status({ headers }))).toEqual(idNumberRequired(FAIL_LIMIT));
  expect(await f.devices(uid)).toEqual([]);
});
