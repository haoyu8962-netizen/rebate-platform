import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { seedBlock } from '../../risk/blocklist/kit.ts';
import { ROOT } from '../../risk/signature/kit.ts';
import {
  PATH,
  PHONE_CONTEXT,
  bound,
  closeKit,
  fixture,
  occupied,
  openKit,
  type Kit,
} from '../bind-phone/http-kit.ts';
import { seedUser } from '../registration/kit.ts';
import { fullWidthPhone, phone, wrong } from '../sms-codes/kit.ts';
import { decode } from '../token/kit.ts';
import {
  CHANGE_SMS,
  DAY_MS,
  H5,
  ME,
  PHONE_CHANGE,
  REFRESH,
  SMS,
  SMS_LOGIN,
  STEP_UP,
  accountState,
  audits,
  holdLock,
  messages,
  newDevice,
  oldPhones,
  primary,
  readResponse,
  sendStepUp,
  setPhoneChange,
  verifyStepUp,
  waitForBlockedRequest,
  type Client,
} from './http-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

async function setup() {
  const f = await fixture(kit, { bound: true });
  await f.db
    .updateTable('users')
    .set({ avatar: 'https://example.test/avatar.png' })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.uid)
    .execute();
  return { ...f, own: f.own!, a: await primary(f) };
}
type Account = Awaited<ReturnType<typeof setup>>;

async function phoneToken(f: Account) {
  return verifyStepUp(f, f.a, await sendStepUp(f, f.a, f.own));
}

async function live(client: Client, uid: string) {
  expect(readResponse(kit, ME, await client.me(), 0, 'get').data).toMatchObject({ user_id: uid });
  const refresh = await client.refresh();
  readResponse(kit, REFRESH, refresh, 0);
  const { data } = refresh.json<Schema<'TokenPairResponse'>>();
  expect(decode(data.access_token).payload).toMatchObject({ uid, sid: client.session.sid });
}

function masked(number: string) {
  return `${number.slice(0, 3)}****${number.slice(-4)}`;
}

it('[AC-B1-20b#1] 真换号覆盖规范化号码并原子留痕，仅作废其他会话，核销两种凭证', async () => {
  const f = await setup();
  const deviceB = await newDevice(f);
  const b = await deviceB.issue();
  await f.db
    .insertInto('push_tokens')
    .values(
      [f.a, b].map((client) => ({
        id: randomUUID(),
        app_id: f.appId,
        device_id: client.deviceId,
        user_id: f.uid,
        bound_sid: client.session.sid,
        provider: 'apns',
        token: `fixture-${client.deviceId}`,
        token_set_at: kit.clock.now(),
      })),
    )
    .execute();
  const h5 = await b.post(H5, {});
  readResponse(kit, H5, h5, 0);
  const { token: h5Token } = h5.json<{ data: Schema<'H5TokenData'> }>().data;
  readResponse(kit, ME, await b.me(h5Token), 0, 'get');

  const token = await phoneToken(f);
  const code = await f.send();
  const key = randomUUID();
  const typedPhone = fullWidthPhone(f.number);
  const before = await accountState(f);
  const priorRefresh = await f.db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
  const lock = await holdLock(f, (trx) =>
    trx
      .withSchema('app')
      .selectFrom('sessions')
      .select('sid')
      .where('app_id', '=', f.appId)
      .where('sid', '=', b.session.sid)
      .forUpdate()
      .execute(),
  );
  const change = f.a.bind(typedPhone, code, token, key);
  try {
    expect(await waitForBlockedRequest(f, lock.pid, change), '换号事务应在吊销 B 时等待').toBe(
      true,
    );
    expect(await accountState(f)).toEqual(before);
  } finally {
    await lock.release();
    await change;
  }

  const response = await change;
  bound(kit, response);
  const changed = kit.clock.now();
  const user = await f.user();
  expect(user.phone_hmac).toBe(f.hmac());
  expect(kit.crypto.decrypt(user.phone_cipher!.toString('utf8'), PHONE_CONTEXT)).toBe(f.number);
  expect(await oldPhones(f)).toEqual([
    expect.objectContaining({
      phone_hmac: f.hmac(f.own),
      reason: 'phone_changed',
      device_hash: null,
      deleted_at: changed,
      expire_at: new Date(changed.getTime() + 180 * DAY_MS),
    }),
  ]);
  const snapshot = await accountState(f);
  expect(snapshot.audits).toEqual([
    expect.objectContaining({
      admin_id: null,
      system_actor: 'system:self_service',
      action: 'user_phone_change',
      target: `users:${f.uid}`,
      before: { phone_masked: masked(f.own) },
      after: { phone_masked: masked(f.number) },
    }),
  ]);
  const serialized = JSON.stringify(
    { audit: snapshot.audits, response: response.json() },
    (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
  );
  expect(serialized).not.toContain(f.own);
  expect(serialized).not.toContain(f.number);

  const aBefore = before.sessions.find((session) => session.sid === f.session.sid);
  expect(snapshot.sessions).toHaveLength(2);
  expect(snapshot.sessions.find((session) => session.sid === f.session.sid)).toEqual(aBefore);
  expect(snapshot.sessions.find((session) => session.sid === b.session.sid)).toMatchObject({
    revoked_at: changed,
    revoke_reason: 'phone_changed',
  });
  expect(snapshot.pushTokens).toEqual(
    before.pushTokens.map((push) =>
      push.device_id === b.deviceId ? { ...push, user_id: null, bound_sid: null } : push,
    ),
  );
  expect(
    await f.db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('app_id', '=', f.appId)
      .where('sid', '=', f.session.sid)
      .execute(),
  ).toEqual(priorRefresh.filter((row) => row.sid === f.session.sid));
  readResponse(kit, ME, await b.me(), 10002, 'get');
  readResponse(kit, REFRESH, await b.refresh(), 10404);
  readResponse(kit, ME, await b.me(h5Token), 10002, 'get');
  await live(f.a, f.uid);

  const unusedTarget = phone('136');
  const unusedCode = await f.send(unusedTarget);
  readResponse(kit, PATH, await f.a.bind(unusedTarget, unusedCode, token), 10003);
  expect(await f.stillValid(unusedCode, unusedTarget)).toBe(true);
  expect(
    await kit.sms.verifyAndConsume({
      app_id: f.appId,
      phone: f.number,
      purpose: 'bind',
      code,
    }),
  ).toMatchObject({ code: 20003 });

  // A new session on B after the change must survive the replay of the old request.
  const bAfter = await deviceB.issue();
  const beforeReplay = await accountState(f);
  const replay = await f.a.bind(typedPhone, code, token, key);
  bound(kit, replay);
  expect(replay.json()).toEqual(response.json());
  expect(await accountState(f)).toEqual(beforeReplay);
  expect(beforeReplay.oldPhones).toHaveLength(1);
  expect(beforeReplay.audits).toHaveLength(1);
  await live(bAfter, f.uid);
});

it('[AC-B1-20b#2] 缺令牌、错 action 或错设备均 10003，原 bind 码仍可用于换号', async () => {
  const f = await setup();
  const b = await (await newDevice(f)).issue();
  const code = await f.send();
  const before = await accountState(f);
  readResponse(kit, PATH, await f.a.bind(f.number, code), 10003);
  for (const action of ['payout_account_change', 'account_deletion'] as const) {
    const sms = await sendStepUp(f, f.a, f.own, action);
    const token = await verifyStepUp(f, f.a, sms, action);
    readResponse(kit, PATH, await f.a.bind(f.number, code, token), 10003);
    kit.clock.advanceMs(60_000);
  }
  const token = await phoneToken(f);
  readResponse(kit, PATH, await b.bind(f.number, code, token), 10003);
  expect(await accountState(f)).toEqual(before);
  await live(b, f.uid);
  bound(kit, await f.a.bind(f.number, code, token));
});

it.each([
  { label: '验证码错误', error: 20002 },
  { label: '他人已占用', error: 30411 },
  { label: '黑名单', error: 44001 },
  { label: '黑名单兼属他人', error: 44001, occupied: true },
  { label: '号码非法', error: 20001 },
])('[AC-B1-20b#3] $label 返回 $error，账户、会话和审计无变化，令牌可重试', async (scenario) => {
  const f = await setup();
  const b = await (await newDevice(f)).issue();
  const token = await phoneToken(f);
  const code = await f.send();
  if (scenario.error === 30411 || scenario.occupied) await f.owner();
  if (scenario.error === 44001) {
    await seedBlock(kit.suite.db, f.appId, 'phone', f.hmac(), kit.clock);
  }
  const before = await accountState(f);
  const target = scenario.error === 20001 ? '+1 202 555 0123' : `+86 ${f.number}`;
  const response = await f.a.bind(target, scenario.error === 20002 ? wrong(code) : code, token);
  const body = readResponse(kit, PATH, response, scenario.error);
  if (scenario.error === 20001) {
    expect(body.data).toMatchObject({ fields: ['phone'], reason: 'phone_invalid' });
  }
  if (scenario.error === 30411) occupied(kit, response);
  expect(await accountState(f)).toEqual(before);
  await live(b, f.uid);

  const blocked = scenario.error === 30411 || scenario.error === 44001;
  const correctTarget = blocked ? phone('136') : f.number;
  const correctCode = blocked ? await f.send(correctTarget) : code;
  bound(kit, await f.a.bind(correctTarget, correctCode, token));
});

it('[AC-B1-20b#4] 字符串 false 不关闭换号，login 码不能代替新号的 bind 码', async () => {
  const f = await setup();
  await setPhoneChange(f, 'false');
  const token = await phoneToken(f);
  const code = await f.send(f.number, 'login');
  const before = await accountState(f);
  readResponse(kit, PATH, await f.a.bind(f.number, code, token), 20003);
  expect(await accountState(f)).toEqual(before);
  kit.clock.advanceMs(60_000);
  bound(kit, await f.a.bind(f.number, await f.send(), token));
});

it('[AC-B1-20b#5] false 档首次绑定照常，已绑换号 30414 后保留验证码和令牌', async () => {
  const first = await fixture(kit);
  await setPhoneChange(first, false);
  const firstClient = await primary(first);
  readResponse(kit, SMS, await firstClient.post(SMS, { purpose: 'bind', phone: first.number }), 0);
  const sms = messages(first);
  expect(sms).toEqual([expect.objectContaining({ phone: first.number, purpose: 'bind' })]);
  bound(kit, await first.bind({ phone: first.number, code: sms[0]!.code }));
  expect((await first.user()).phone_hmac).toBe(first.hmac());
  expect(await audits(first)).toEqual([]);
  expect(await oldPhones(first)).toEqual([]);

  const f = await setup();
  const b = await (await newDevice(f)).issue();
  const token = await phoneToken(f);
  const code = await f.send();
  await setPhoneChange(f, false);
  const before = await accountState(f);
  expect(readResponse(kit, PATH, await f.a.bind(f.number, code, token), 30414).msg).toBe(
    '暂不支持自助更换手机号，请联系客服',
  );
  expect(await accountState(f)).toEqual(before);
  await live(b, f.uid);
  await setPhoneChange(f, true);
  bound(kit, await f.a.bind(f.number, code, token));
});

it('[AC-B1-20b#6] 关闭时发码：签名先拒绝，换号开关优先于手机号错误且不占短信额度', async () => {
  const f = await setup();
  await setPhoneChange(f, false);
  const malformed = { ...CHANGE_SMS, phone: '+1 202 555 0123' };
  readResponse(kit, SMS, await f.a.post(SMS, malformed, { 'x-sign': '0'.repeat(64) }), 10401);
  readResponse(kit, SMS, await f.a.post(SMS, malformed, { 'x-device-id': randomUUID() }), 10402);
  readResponse(kit, SMS, await f.a.post(SMS, malformed), 30414);
  readResponse(kit, SMS, await f.a.post(SMS, CHANGE_SMS), 30414);
  expect(messages(f)).toEqual([]);

  await setPhoneChange(f, true);
  const invalid = readResponse(kit, SMS, await f.a.post(SMS, malformed), 20001);
  expect(invalid.data).toMatchObject({ fields: ['phone'] });
  await sendStepUp(f, f.a, f.own);
});

it('[AC-B1-20b#7] 关闭时二次验证先判 10405，再判换号开关，且不核码、不增加错次', async () => {
  const f = await setup();
  const limited = await (await newDevice(f)).issue(f.uid, 'deletion_only');
  const code = await sendStepUp(f, f.a, f.own);
  await setPhoneChange(f, false);
  const good = { ...PHONE_CHANGE, code };
  const bad = { ...PHONE_CHANGE, code: wrong(code) };
  readResponse(kit, STEP_UP, await limited.post(STEP_UP, good), 10405);
  readResponse(kit, STEP_UP, await f.a.post(STEP_UP, bad), 30414);
  readResponse(kit, STEP_UP, await f.a.post(STEP_UP, good), 30414);

  await setPhoneChange(f, true);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    readResponse(kit, STEP_UP, await f.a.post(STEP_UP, bad), 20002);
  }
  await verifyStepUp(f, f.a, code);

  kit.clock.advanceMs(60_000);
  await setPhoneChange(f, false);
  const deletionCode = await sendStepUp(f, limited, f.own, 'account_deletion');
  await verifyStepUp(f, limited, deletionCode, 'account_deletion');
  kit.clock.advanceMs(60_000);
  const payoutCode = await sendStepUp(f, f.a, f.own, 'payout_account_change');
  await verifyStepUp(f, f.a, payoutCode, 'payout_account_change');
});

it('[AC-B1-20b#8] 规范化后等于当前号码返回 20001，不核码、不核令牌、不吊销', async () => {
  const f = await setup();
  const b = await (await newDevice(f)).issue();
  const token = await phoneToken(f);
  kit.clock.advanceMs(60_000);
  const currentCode = await f.send(f.own);
  const before = await accountState(f);
  const response = await f.a.bind(fullWidthPhone(f.own), currentCode, token);
  expect(readResponse(kit, PATH, response, 20001).data).toMatchObject({ fields: ['phone'] });
  expect(await accountState(f)).toEqual(before);
  expect(await f.stillValid(currentCode, f.own)).toBe(true);
  await live(b, f.uid);
  bound(kit, await f.a.bind(f.number, await f.send(), token));
});

it('[AC-B1-20b#9] 刚释放的旧号可短信注册新账号，旧号奖励留存于 180 天边界失效', async () => {
  const f = await setup();
  const token = await phoneToken(f);
  // Let the step-up send interval elapse before the change so the old phone can be used at once.
  kit.clock.advanceMs(60_000);
  const changeTime = kit.clock.now().getTime();
  bound(kit, await f.a.bind(f.number, await f.send(), token));
  const expireTime = changeTime + 180 * DAY_MS;
  expect(await oldPhones(f)).toEqual([
    expect.objectContaining({
      phone_hmac: f.hmac(f.own),
      reason: 'phone_changed',
      expire_at: new Date(expireTime),
    }),
  ]);
  const loginDevice = await newDevice(f);
  const code = await f.send(f.own, 'login');
  const login = await loginDevice.post(SMS_LOGIN, {
    phone: `0086 ${f.own}`,
    code,
    legal_versions: { privacy: 1, agreement: 1 },
    consent_at: kit.clock.now().toISOString(),
  });
  readResponse(kit, SMS_LOGIN, login, 0);
  const { is_new_user, user_id } = login.json<{ data: Schema<'LoginData'> }>().data;
  expect(is_new_user).toBe(true);
  expect(user_id).not.toBe(f.uid);
  const registered = await f.db
    .selectFrom('users')
    .select('phone_hmac')
    .where('app_id', '=', f.appId)
    .where('id', '=', user_id)
    .executeTakeFirstOrThrow();
  expect(registered.phone_hmac).toBe(f.hmac(f.own));

  type Identity = typeof import('../../../../apps/api/src/modules/identity/ports/invite-reward.ts');
  const identity = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as Identity;
  const reader = identity.createInviteRewardDeletedPhoneReader();
  const retained = (uid: string) =>
    f.db
      .transaction()
      .execute((trx) =>
        reader.retained(trx, { app_id: f.appId, user_id: uid, at: kit.clock.now() }),
      );
  expect(await retained(user_id)).toBe(true);
  expect(await retained(f.uid)).toBe(false);
  kit.clock.set(new Date(expireTime - 1));
  expect(await retained(user_id)).toBe(true);
  kit.clock.set(new Date(expireTime));
  expect(await retained(user_id)).toBe(false);
  kit.clock.advanceMs(1);
  expect(await retained(user_id)).toBe(false);
});

it('[AC-B1-20b#10] 刚释放的旧号不占唯一归属，同 App 的未绑账号可首次绑定', async () => {
  const f = await setup();
  const token = await phoneToken(f);
  kit.clock.advanceMs(60_000);
  bound(kit, await f.a.bind(f.number, await f.send(), token));
  const otherUid = await seedUser(f.db, f.appId, { method: 'wechat' });
  const other = await (await newDevice(f)).issue(otherUid);
  const code = await f.send(f.own);
  bound(kit, await other.bind(`+86 ${f.own}`, code));
  expect((await f.user(otherUid)).phone_hmac).toBe(f.hmac(f.own));
  expect(await oldPhones(f)).toEqual([expect.objectContaining({ phone_hmac: f.hmac(f.own) })]);
  expect(await audits(f)).toHaveLength(1);
});

it('[AC-B1-20b#11] 同一令牌并发提交两笔不同幂等键，只允许一次换号', async () => {
  const f = await setup();
  const token = await phoneToken(f);
  const targets = [f.number, phone('136')];
  const [firstCode, secondCode] = await Promise.all([f.send(targets[0]), f.send(targets[1])]);
  const responses = await Promise.all([
    f.a.bind(targets[0]!, firstCode, token, randomUUID()),
    f.a.bind(targets[1]!, secondCode, token, randomUUID()),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 403]);
  const winner = responses.findIndex((response) => response.statusCode === 200);
  bound(kit, responses[winner]!);
  readResponse(kit, PATH, responses[1 - winner]!, 10003);
  expect((await f.user()).phone_hmac).toBe(f.hmac(targets[winner]!));
  expect(await oldPhones(f)).toEqual([expect.objectContaining({ phone_hmac: f.hmac(f.own) })]);
  expect(await audits(f)).toHaveLength(1);
});

it('[AC-B1-20b#12] 同 App 两人并发换到同一新号，唯一赢家，输家返回 30411', async () => {
  const f = await setup();
  const otherPhone = phone('138');
  const otherUid = await f.owner({ to: otherPhone });
  await f.db
    .updateTable('users')
    .set({ phone_cipher: Buffer.from(kit.crypto.encrypt(otherPhone, PHONE_CONTEXT), 'utf8') })
    .where('app_id', '=', f.appId)
    .where('id', '=', otherUid)
    .execute();
  const other = await (await newDevice(f)).issue(otherUid);
  const tokenA = await phoneToken(f);
  const tokenB = await verifyStepUp(f, other, await sendStepUp(f, other, otherPhone));
  const codeA = await f.send();
  const before = await accountState(f);

  // A can authenticate and consume its bind code, then waits at the users write. Issue a
  // fresh code for B while A is still in flight because a code for this number is single-use.
  const lock = await holdLock(f, (trx) => sql`LOCK TABLE app.users IN SHARE MODE`.execute(trx));
  const first = f.a.bind(f.number, codeA, tokenA);
  let second: ReturnType<Client['bind']> | undefined;
  try {
    expect(await waitForBlockedRequest(f, lock.pid, first), 'A 尚未写入新号码').toBe(true);
    expect(await accountState(f)).toEqual(before);
    kit.clock.advanceMs(60_000);
    const codeB = await f.send();
    second = other.bind(`+86 ${f.number}`, codeB, tokenB);
  } finally {
    await lock.release();
    await Promise.allSettled([first, second]);
  }
  expect(second).toBeDefined();
  const responses = await Promise.all([first, second!]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 422]);
  const [winner, loser] = responses[0].statusCode === 200 ? [0, 1] : [1, 0];
  bound(kit, responses[winner]!);
  occupied(kit, responses[loser]!);
  const accounts = [f.uid, otherUid];
  const formerNumbers = [f.own, otherPhone];
  const owners = await f.db
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', f.appId)
    .where('phone_hmac', '=', f.hmac())
    .execute();
  expect(owners).toEqual([{ id: accounts[winner] }]);
  expect((await f.user(accounts[loser])).phone_hmac).toBe(f.hmac(formerNumbers[loser]));
  expect(await oldPhones(f)).toEqual([
    expect.objectContaining({ phone_hmac: f.hmac(formerNumbers[winner]), reason: 'phone_changed' }),
  ]);
  expect(await audits(f)).toEqual([
    expect.objectContaining({ action: 'user_phone_change', target: `users:${accounts[winner]}` }),
  ]);
});
