// B1-20c: a merge that succeeds (规划/08 BR-ID-06 正文「同一事务内把当前账号的 user_oauth 迁到手机号
// 账号，当前账号联盟绑定直接置 released（不冷却），当前账号置墓碑（status=deleted，deleted_reason=merged，
// 不进冷静期、不写 deleted_identities），吊销其全部 sid，并为手机号账号签发令牌」; 细则「并号时的其余
// 记录」: login_logs method=merge, devices.last_login_sid, push token binding, BR-ID-12 login_merge of
// this device's device-level consents (the source's own records stay with it); 10 AC-S1-59 ②⑥;
// D10-1099 Q-5: a frozen target is merged). Real AppModule over PG and Redis; the ticket comes from
// the real POST /v1/me/phone.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, storedTicket, type Kit } from '../bind-phone/http-kit.ts';
import { merged, quiet, revoked, scene, usable } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

for (const provider of ['wechat', 'apple', 'huawei'] as const) {
  it(`[AC-B1-20c#3] AC-S1-59 ② ${provider} 空号确认并号 → 手机号账号的令牌；身份整行迁到手机号账号，源置墓碑，ticket 用掉`, async () => {
    const s = await scene(kit, { provider });
    const ticket = await s.offer();
    const identities = await s.rows.oauth(s.source);
    expect(identities).toHaveLength(1);
    const target = await s.user(s.target);

    const tokens = merged(kit, await s.merge(ticket), s.target);

    // The source's identity row moves as it is (same id, union_id, open_id), marked as merged.
    expect(await s.rows.oauth(s.source)).toEqual([]);
    expect(await s.rows.oauth(s.target)).toEqual([
      {
        ...identities[0]!,
        user_id: s.target,
        merged_from_user_id: s.source,
        row_version: expect.any(Number),
        updated_at: expect.any(Date),
      },
    ]);
    // The source is a tombstone: no cooling period, no deleted_identities row.
    expect(await s.user(s.source)).toMatchObject({
      status: 'deleted',
      deleted_reason: 'merged',
      phone_hmac: null,
      phone_cipher: null,
    });
    const after = await s.snapshot();
    expect(after.deletions).toEqual([]);
    expect(after.deletedIdentities).toEqual([]);
    // The target keeps its number, status and relations.
    expect(await s.user(s.target)).toMatchObject({
      status: 'normal',
      deleted_reason: null,
      phone_hmac: target.phone_hmac,
      phone_cipher: target.phone_cipher,
      parent_id: target.parent_id,
      register_method: 'sms',
    });
    // Once only: the ticket is gone.
    expect((await storedTicket(kit, ticket)).value).toBeNull();
    quiet(kit, s.number, ticket, tokens.access_token, tokens.refresh_token);
  });
}

it('[AC-B1-20c#4] 源的全部会话吊销（revoke_reason=merged），旧令牌再请求 10002；手机号账号在本设备新建一个会话（login_method=merge），新令牌可用', async () => {
  const s = await scene(kit);
  const elsewhere = await s.newDevice();
  const second = await s.login(s.source, elsewhere);
  const ticket = await s.offer();

  const tokens = merged(kit, await s.merge(ticket), s.target);
  const now = kit.clock.now();

  const ended = await s.rows.sessions(s.source);
  expect(ended).toHaveLength(2);
  for (const sid of [s.session.sid, second.sid]) {
    expect(ended.find((row) => row.sid === sid)).toMatchObject({
      revoked_at: now,
      revoke_reason: 'merged',
    });
  }
  await revoked(s, s.session.access_token);
  await revoked(s, second.access_token, elsewhere);

  const sessions = await s.rows.sessions(s.target);
  expect(sessions).toEqual([
    expect.objectContaining({
      user_id: s.target,
      device_id: s.device.id,
      login_method: 'merge',
      revoked_at: null,
      revoke_reason: null,
    }),
  ]);
  // The device's current session is the target's new one (BR-ID-07 细则).
  expect((await s.rows.device()).last_login_sid).toBe(sessions[0]!.sid);
  await usable(s, tokens.access_token);
});

it('[AC-B1-20c#5] 推送令牌：源在别的设备上的令牌解绑；本设备的令牌随新会话绑到手机号账号', async () => {
  const s = await scene(kit);
  const elsewhere = await s.newDevice();
  const second = await s.login(s.source, elsewhere);
  const here = await s.pushToken(s.source, s.session.sid);
  const there = await s.pushToken(s.source, second.sid, elsewhere);
  const ticket = await s.offer();

  merged(kit, await s.merge(ticket), s.target);

  const [session] = await s.rows.sessions(s.target);
  const tokens = await s.rows.pushTokens();
  expect(tokens.find((row) => row.id === there)).toMatchObject({
    user_id: null,
    bound_sid: null,
    revoked_at: null,
  });
  expect(tokens.find((row) => row.id === here)).toMatchObject({
    user_id: s.target,
    bound_sid: session!.sid,
    revoked_at: null,
  });
});

it('[AC-B1-20c#6] AC-S1-59 ⑥ 源的注册来源记录只多了 merged_into_user_id=目标；源原有登录记录不改；目标写一条 login_logs（method=merge，本设备）', async () => {
  const s = await scene(kit);
  await s.loginLog(s.source, s.provider);
  const [registration] = await s.rows.registrations(s.source);
  const earlier = await s.rows.loginLogs(s.source);
  expect(earlier).toHaveLength(1);
  const ticket = await s.offer();

  merged(kit, await s.merge(ticket), s.target);

  expect(await s.rows.registrations(s.source)).toEqual([
    { ...registration, merged_into_user_id: s.target },
  ]);
  expect(await s.rows.registrations(s.target)).toEqual([]);
  expect(await s.rows.loginLogs(s.source)).toEqual(earlier);
  expect(await s.rows.loginLogs(s.target)).toEqual([
    expect.objectContaining({
      app_id: s.appId,
      user_id: s.target,
      method: 'merge',
      device_hash: s.device.hash,
    }),
  ]);
});

it('[AC-B1-20c#7] AC-S1-59 ② 目标的上下级、订单与别的第三方身份不变，只多了迁入的这一条', async () => {
  const s = await scene(kit, { provider: 'wechat' });
  const parent = await s.bystander();
  const child = await s.bystander();
  await s.setParent(s.target, parent);
  await s.setParent(child, s.target);
  await s.order(s.target);
  const apple = await s.oauth(s.target, 'apple');
  const ticket = await s.offer();

  merged(kit, await s.merge(ticket), s.target);

  expect((await s.user(s.target)).parent_id).toBe(parent);
  expect((await s.user(child)).parent_id).toBe(s.target);
  const identities = await s.rows.oauth(s.target);
  expect(identities.map((row) => row.provider).sort()).toEqual(['apple', 'wechat']);
  expect(identities.find((row) => row.id === apple)).toMatchObject({
    merged_from_user_id: null,
  });
  expect(identities.find((row) => row.id === s.sourceOauth)).toMatchObject({
    merged_from_user_id: s.source,
  });
});

it('[AC-B1-20c#8] 源的联盟绑定：active / invalid 直接置 released，released_at = cooldown_until = 并号时刻（不冷却）；已释放、未绑定的行不动', async () => {
  const s = await scene(kit);
  const active = await s.binding(s.source, { platform: 'taobao', status: 'active' });
  const invalid = await s.binding(s.source, { platform: 'jd', status: 'invalid' });
  const history = await s.binding(s.source, { platform: 'eleme', status: 'released' });
  const unbound = await s.binding(s.source, { platform: 'kuaishou', status: 'unbound' });
  const ticket = await s.offer();

  merged(kit, await s.merge(ticket), s.target);
  const now = kit.clock.now();

  const rows = await s.rows.bindings(s.source);
  for (const before of [active, invalid]) {
    expect(rows.find((row) => row.id === before.id)).toMatchObject({
      user_id: s.source,
      status: 'released',
      released_at: now,
      cooldown_until: now,
      blocked_reason: null,
      relation_id: before.relation_id,
      bound_at: before.bound_at,
      union_account_id: before.union_account_id,
    });
  }
  expect(rows.find((row) => row.id === history.id)).toEqual(history);
  expect(rows.find((row) => row.id === unbound.id)).toEqual(unbound);
  // The bindings stay with the tombstone: nothing is moved to the target.
  expect(await s.rows.bindings(s.target)).toEqual([]);
});

it('[AC-B1-20c#51] 细则「并号时的其余记录」：手机号账号按一次登录执行 login_merge，本设备的设备级同意并入；源的用户级同意原样留在源下，不复制给目标；别的设备的设备级同意不并', async () => {
  const s = await scene(kit);
  const here = await s.consent({
    type: 'personalization',
    version: 3,
    agoMs: 2000,
    accepted: false,
  });
  const elsewhere = await s.newDevice();
  await s.consent({ on: elsewhere, type: 'agreement', version: 7, agoMs: 2000 });
  // The source's own records: a later personalization of a higher version, and a privacy record.
  await s.consent({ user: s.source, type: 'personalization', version: 9, agoMs: 1000 });
  await s.consent({ user: s.source, type: 'privacy', version: 5, agoMs: 1000 });
  const ticket = await s.offer();
  const before = await s.snapshot();
  const sourceRecords = await s.rows.consents(s.source);
  expect(sourceRecords).toHaveLength(2);
  expect(await s.rows.consents(s.target)).toEqual([]);

  merged(kit, await s.merge(ticket), s.target);

  const after = await s.snapshot();
  expect(after.consents.filter((row) => before.consents.some((old) => old.id === row.id))).toEqual(
    before.consents,
  );
  expect(await s.rows.consents(s.target)).toEqual([
    expect.objectContaining({
      subject_type: 'user',
      user_id: s.target,
      type: 'personalization',
      version: 3,
      accepted: false,
      channel: 'login_merge',
      client_at: here.client_at,
      server_at: kit.clock.now(),
    }),
  ]);
  expect(await s.rows.consents(s.source)).toEqual(sourceRecords);
});

it('[AC-B1-20c#9] D10-1099 Q-5 目标被冻结（frozen）照常并号', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  await s.setRisk(s.target, 'frozen');

  const tokens = merged(kit, await s.merge(ticket), s.target);

  expect(await s.user(s.source)).toMatchObject({ status: 'deleted', deleted_reason: 'merged' });
  expect((await s.rows.oauth(s.target)).map((row) => row.id)).toEqual([s.sourceOauth]);
  expect(tokens.session_scope).toBe('full');
});
