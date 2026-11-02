// B1-02zw · what a phone change of a flagged account does (contract adminEditUserProfile「Pending
// re-verification」: every user_oauth row outside the snapshot unbound, the flag, its time, the
// snapshot and the failure count cleared; trusted identities and re-verified devices stay; BR-WDR-01
// 细则「清除标记只走人工」). No Apple refresh token here: apple.int.test.ts owns the revocation job.
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  releaseFailure,
  reserveFailure,
} from '../../../../apps/api/src/modules/identity/infra/reverify-store.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  REASON,
  decrypted,
  devices,
  edit,
  hmacOf,
  identities,
  masked,
  ok,
  row,
  sessionsOf,
  testPhone,
} from '../admin-profile/kit.ts';
import {
  FAIL_DAY,
  account,
  bind,
  bindings,
  expectCleared,
  guarded,
  providersOf,
  reverified,
  reverifiedOf,
  scene,
  state,
  type Provider,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-02zw#1] 带标记账号改手机号：解绑可信身份以外的 user_oauth 行，清标记、打标时刻、快照与失败计数；可信身份与已加验设备保留，改号与吊销会话照常', async () => {
  const s = await scene(h);
  const target = await account(s, {
    bound: ['wechat', 'huawei'],
    trusted: ['wechat'],
    realname: true,
    failures: 3,
  });
  await reverified(s, target, 'self');
  await reverified(s, target, 'admin');
  await devices(h, s.clock, target, 2);
  const before = await bindings(s, target);
  const devicesBefore = await reverifiedOf(s, target);
  expect(devicesBefore).toHaveLength(2);
  expect(await state(s, target)).toMatchObject({
    reverify_trusted: { realname: true, providers: ['wechat'] },
    reverify_fail_count: 3,
    reverify_fail_day: FAIL_DAY,
  });

  const next = testPhone();
  await ok(await edit(s, target.id, { phone: next, reason: REASON }));

  // The trusted row stays as it was, not a row written anew.
  expect(await bindings(s, target)).toEqual(before.filter((b) => b.provider === 'wechat'));
  await expectCleared(s, target);
  expect(await reverifiedOf(s, target)).toEqual(devicesBefore);
  const stored = await row(h, target);
  expect(stored.phone_hmac).toBe(hmacOf(h, next));
  expect(decrypted(h, stored.phone_cipher)).toBe(next);
  const now = s.clock.now();
  const sessions = await sessionsOf(h, target);
  expect(sessions).toHaveLength(2);
  for (const session of sessions) {
    expect(session).toMatchObject({ revoked_at: now, revoke_reason: 'phone_changed' });
  }
  expect((await identities(h, s.appId)).map((entry) => entry.phone_hmac)).toEqual([target.hmac]);
});

const SNAPSHOTS: {
  name: string;
  bound: Provider[];
  trusted: Provider[];
  realname: boolean;
  kept: Provider[];
}[] = [
  {
    name: '快照没有第三方身份：全部解绑',
    bound: ['huawei', 'wechat'],
    trusted: [],
    realname: false,
    kept: [],
  },
  {
    name: '可信的只有实名：第三方身份全部解绑',
    bound: ['huawei', 'wechat'],
    trusted: [],
    realname: true,
    kept: [],
  },
  {
    name: '快照之外只有一个：只解绑它',
    bound: ['apple', 'huawei', 'wechat'],
    trusted: ['apple', 'huawei'],
    realname: false,
    kept: ['apple', 'huawei'],
  },
  {
    name: '全部可信：一个不解绑，标记照清',
    bound: ['huawei', 'wechat'],
    trusted: ['huawei', 'wechat'],
    realname: false,
    kept: ['huawei', 'wechat'],
  },
  {
    name: '快照里的身份已不在：不补回，其余照解绑',
    bound: ['wechat'],
    trusted: ['huawei'],
    realname: false,
    kept: [],
  },
];

it.each(SNAPSHOTS)('[AC-B1-02zw#2] $name', async ({ bound, trusted, realname, kept }) => {
  const s = await scene(h);
  const target = await account(s, { bound, trusted, realname });
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(await providersOf(s, target)).toEqual(kept);
  await expectCleared(s, target);
});

it('[AC-B1-02zw#3] 同时改手机号和昵称、号码写成带 +86 的另一种拼法：改号判定在规范化之后，照样解绑并清标记，昵称也保存', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['huawei'] });
  const next = testPhone();
  const typed = `+86 ${next.slice(0, 3)} ${next.slice(3, 7)} ${next.slice(7)}`;
  const body = { phone: typed, nickname: '小狸', reason: REASON };
  const data = await ok(await edit(s, target.id, body));
  expect(data).toMatchObject({ nickname: '小狸', phone_masked: masked(next) });
  expect(await providersOf(s, target)).toEqual([]);
  await expectCleared(s, target);
});

it('[AC-B1-02zw#4] 账号原来没有手机号：第一次保存的号码也算改号，解绑并清标记，deleted_identities 不写', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['wechat'], phone: null, failures: 1 });
  const next = testPhone();
  await ok(await edit(s, target.id, { phone: next, reason: REASON }));
  expect((await row(h, target)).phone_hmac).toBe(hmacOf(h, next));
  expect(await providersOf(s, target)).toEqual([]);
  await expectCleared(s, target);
  expect(await identities(h, s.appId)).toEqual([]);
});

it('[AC-B1-02zw#5] 只动被改的账号：同 App 另一个带标记账号、别的 App 账号的绑定与标记都不动', async () => {
  const s = await scene(h);
  const spec = { bound: ['huawei', 'wechat'], trusted: ['wechat'], failures: 2 } as const;
  const target = await account(s, spec);
  const peer = await account(s, spec);
  const foreign = await account(s, spec, `rc_${randomBytes(10).toString('hex')}`);
  const peerBefore = await guarded(s, peer);
  const foreignBefore = await guarded(s, foreign);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(await providersOf(s, target)).toEqual(['wechat']);
  await expectCleared(s, target);
  expect(await guarded(s, peer)).toEqual(peerBefore);
  expect(await guarded(s, foreign)).toEqual(foreignBefore);
});

it('[AC-B1-02zw#6] 清除只发生一次：之后账号无标记，再改号时之后新绑的身份不解绑', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['huawei'] });
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  await expectCleared(s, target);
  expect(await providersOf(s, target)).toEqual([]);
  await bind(s, target, 'wechat');
  const before = await guarded(s, target);
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(await guarded(s, target)).toEqual(before);
});

it('[AC-B1-02zw#7] 计数清零让在途的失败名额失效：改号前占的名额晚到释放，不会抵掉之后新计的一次失败', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: [], realname: true });
  const subject = { app_id: target.appId, user_id: target.id };
  const late = await reserveFailure(h.db, subject, FAIL_DAY, s.clock.now());
  expect(late).toMatchObject({ count: 1 });
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  await expectCleared(s, target);
  const fresh = await reserveFailure(h.db, subject, FAIL_DAY, s.clock.now());
  expect(fresh).toMatchObject({ count: 1 });
  await releaseFailure(h.db, subject, late!, s.clock.now());
  expect((await state(s, target)).reverify_fail_count).toBe(1);
});
