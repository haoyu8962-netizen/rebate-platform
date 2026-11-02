// B1-02zw · one transaction (contract adminEditUserProfile: the same transaction as the phone write
// and the session revocation; task §9 #2 #4). Both directions are needed: a failing audit row (the
// save's last write) catches unbinding that committed earlier; a failing send and a binding row
// held by another transaction catch unbinding done after the commit. Reads of the flag happen under
// the users row lock, so a flag committed while the save waits still counts (D10-161).
import { sql } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../admin/auth/kit.ts';
import {
  REASON,
  devices,
  edit,
  hmacOf,
  ok,
  row,
  sessionsOf,
  stepUp,
  testPhone,
} from '../admin-profile/kit.ts';
import { settledOrWaiting } from '../deletion-processing/kit.ts';
import {
  TOKEN,
  account,
  breakableAudit,
  expectCleared,
  hold,
  onlyJob,
  phoneChangeClears,
  providersOf,
  queued,
  reverified,
  scene,
  world,
} from './kit.ts';

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

const FLAGGED = {
  bound: ['apple', 'huawei', 'wechat'],
  trusted: ['wechat'],
  realname: true,
  token: TOKEN,
  failures: 2,
} as const;

it('[AC-B1-02zw#12] 改号后段出错（审计写失败）：改号、吊销、解绑、清标记、作业一起回滚，返回 50001；重试成功才清', async () => {
  const s = await scene(h);
  const target = await account(s, FLAGGED);
  await reverified(s, target, 'self');
  await devices(h, s.clock, target, 2);
  await breakableAudit(s);
  const before = await world(s);
  s.control.failAudit = true;
  const response = await edit(s, target.id, { phone: testPhone(), reason: REASON });
  expect(s.control.failAudit, '审计失败没有发生').toBe(false);
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ code: 50001 });
  expect(await world(s)).toEqual(before);
  expect(await queued(s)).toEqual([]);
  await phoneChangeClears(s, target);
});

it('[AC-B1-02zw#13] 撤销作业入队失败：整次保存回滚，号码、会话、绑定、标记不变，事务里已写的作业不留；重试成功才清', async () => {
  const s = await scene(h);
  const target = await account(s, FLAGGED);
  await devices(h, s.clock, target, 1);
  const before = await world(s);
  s.control.failSend = true;
  const response = await edit(s, target.id, { phone: testPhone(), reason: REASON });
  expect(s.control.failSend, '入队失败没有发生').toBe(false);
  expect(response.statusCode).toBe(500);
  expect(await world(s)).toEqual(before);
  expect(await queued(s)).toEqual([]);
  await phoneChangeClears(s, target);
  await onlyJob(s);
});

it('[AC-B1-02zw#14] 解绑不含 Apple 时也在改号事务里：绑定行被别的事务占着，保存等它，期间改号与吊销都没提交', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['huawei', 'wechat'], trusted: ['wechat'] });
  await devices(h, s.clock, target, 1);
  const next = testPhone();
  const held = await hold(s, async (trx) => {
    const { rows } = await sql`SELECT 1 FROM app.user_oauth
      WHERE app_id = ${target.appId} AND user_id = ${target.id} AND provider = 'huawei'
      FOR UPDATE`.execute(trx);
    expect(rows).toHaveLength(1);
  });
  const saving = edit(s, target.id, { phone: next, reason: REASON });
  const watch = { ended: false };
  const ended = () => {
    watch.ended = true;
  };
  void saving.then(ended, ended);
  try {
    await settledOrWaiting(h.db, saving);
    expect(watch.ended, '保存没有去解绑这一行').toBe(false);
    expect((await row(h, target)).phone_hmac).toBe(target.hmac);
    for (const session of await sessionsOf(h, target)) expect(session.revoked_at).toBeNull();
  } finally {
    await held.release();
  }
  await ok(await saving);
  expect((await row(h, target)).phone_hmac).toBe(hmacOf(h, next));
  expect(await providersOf(s, target)).toEqual(['wechat']);
  await expectCleared(s, target);
});

it('[AC-B1-02zw#15] 标记在行锁下读：保存等 users 行锁时另一事务提交了标记，这次保存照样解绑并清除', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['huawei', 'wechat'], flagged: false });
  const trusted = JSON.stringify({ realname: false, providers: ['wechat'] });
  const held = await hold(s, (trx) =>
    sql`UPDATE app.users SET reverify_flagged_at = ${s.clock.now()},
        reverify_trusted = ${trusted}::jsonb
      WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(trx),
  );
  const saving = edit(s, target.id, { phone: testPhone(), reason: REASON });
  try {
    await settledOrWaiting(h.db, saving);
  } finally {
    await held.release();
  }
  await ok(await saving);
  expect(await providersOf(s, target)).toEqual(['wechat']);
  await expectCleared(s, target);
});

it('[AC-B1-02zw#16] 两个管理员同时把账号改成同一个新号：都成功，只解绑、入队一次', async () => {
  const s = await scene(h);
  const target = await account(s, FLAGGED);
  const second = await seed(h, s.appId, { isSuper: true });
  const session = await signedIn(s, second);
  const admin = { who: second, token: session.admin_token };
  const body = { phone: testPhone(), reason: REASON };
  const tokens = [await stepUp(s), await stepUp(s, second, admin.token)];
  const responses = await Promise.all([
    edit(s, target.id, body, { stepUp: tokens[0]! }),
    edit(s, target.id, body, { as: admin, stepUp: tokens[1]! }),
  ]);
  for (const response of responses) await ok(response);
  expect(await providersOf(s, target)).toEqual(['wechat']);
  await expectCleared(s, target);
  await onlyJob(s);
  expect(s.sent).toHaveLength(1);
});
