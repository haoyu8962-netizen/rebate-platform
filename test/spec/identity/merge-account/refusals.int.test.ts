// B1-20c: merges that are refused (规划/08 BR-ID-06: a ticket that is expired, used or not this
// account's → 30411 only; 04 §6.1 mergeAccount: body only merge_ticket, x-auth login, signed,
// idempotent, version gate; the ticket store unavailable → 50001, nothing merged; BR-ID-01 判定顺序:
// a banned source → 10006, a source in deletion → 10007). Nothing is written and nobody's ticket is
// consumed by a refusal.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, storedTicket, type Kit } from '../bind-phone/http-kit.ts';
import {
  MERGE_PATH,
  answer,
  expire,
  failTicketScripts,
  idempotencyRows,
  merged,
  plantTicket,
  refused,
  scene,
  usable,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-20c#22] 不存在的 ticket → 只返回 30411，什么都不写', async () => {
  const s = await scene(kit);
  const before = await s.snapshot();

  refused(kit, await s.merge(randomBytes(32).toString('hex')));

  expect(await s.snapshot()).toEqual(before);
  await usable(s, s.session.access_token);
});

it('[AC-B1-20c#23] AC-S1-59 ③ ticket 过期（超过 5 分钟）→ 只返回 30411，什么都不写', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  await expire(kit, ticket);
  const before = await s.snapshot();

  refused(kit, await s.merge(ticket));

  expect(await s.snapshot()).toEqual(before);
});

it('[AC-B1-20c#24] 用同 App 另一个空号的 ticket → 只返回 30411，不删别人的票；票主随后照常并号', async () => {
  const owner = await scene(kit);
  const ticket = await owner.offer();
  const other = await scene(kit, { appId: owner.appId });
  const before = await owner.snapshot();

  refused(kit, await other.merge(ticket));

  expect(await owner.snapshot()).toEqual(before);
  await owner.ticketKept(ticket);
  merged(kit, await owner.merge(ticket), owner.target);
});

it('[AC-B1-20c#25] 别的 App 的空号拿这张 ticket → 只返回 30411，不删票', async () => {
  const owner = await scene(kit);
  const ticket = await owner.offer();
  const stranger = await scene(kit);
  const before = { owner: await owner.snapshot(), stranger: await stranger.snapshot() };

  refused(kit, await stranger.merge(ticket));

  expect(await owner.snapshot()).toEqual(before.owner);
  expect(await stranger.snapshot()).toEqual(before.stranger);
  await owner.ticketKept(ticket);
});

it('[AC-B1-20c#26] ticket 记的 app_id 与请求的 App 不符（uid 相同）→ 只返回 30411，不删票', async () => {
  const s = await scene(kit);
  const value = { app_id: `${s.appId}_other`, uid: s.source, phone_hmac: s.hmac(s.number) };
  const ticket = await plantTicket(kit, value);
  const before = await s.snapshot();

  refused(kit, await s.merge(ticket));

  expect(await s.snapshot()).toEqual(before);
  expect(JSON.parse((await storedTicket(kit, ticket)).value!)).toEqual(value);
});

it('[AC-B1-20c#27] 源账号被封禁 → 10006，什么都不写，ticket 不核销；解封后照常并号', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  await s.setRisk(s.source, 'banned');
  const before = await s.snapshot();

  answer(kit, await s.merge(ticket), 10006);

  expect(await s.snapshot()).toEqual(before);
  await s.ticketKept(ticket);
  await s.setRisk(s.source, 'normal');
  merged(kit, await s.merge(ticket), s.target);
});

it('[AC-B1-20c#28] 源账号申请了注销（冷静期）→ 10007，什么都不写，ticket 不核销；撤回后照常并号', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  await s.deletion(s.source, 'cooling');
  const before = await s.snapshot();

  answer(kit, await s.merge(ticket), 10007);

  expect(await s.snapshot()).toEqual(before);
  await s.ticketKept(ticket);
  await s.db
    .updateTable('deletion_requests')
    .set({ status: 'cancelled', cancelled_at: kit.clock.now(), cancel_reason: 'user' })
    .where('app_id', '=', s.appId)
    .where('user_id', '=', s.source)
    .execute();
  merged(kit, await s.merge(ticket), s.target);
});

it('[AC-B1-20c#29] merge_ticket 存储不可用 → 50001，不并号；恢复后同一 ticket 照常并号', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  const before = await s.snapshot();
  kit.faults.ticketStore = true;
  const response = await s.merge(ticket).finally(() => {
    kit.faults.ticketStore = false;
  });

  const body = answer(kit, response, 50001);

  expect(JSON.stringify(body)).not.toContain('tokens');
  expect(await s.snapshot()).toEqual(before);
  await s.ticketKept(ticket);
  merged(kit, await s.merge(ticket), s.target);
});

it('[AC-B1-20c#50] 票已读到、并号已在等目标行锁；之后读票照常、只有提交前「比对后删除」的核销失败 → 50001，整笔回滚：身份、绑定、墓碑、源会话、目标新会话、推送令牌、幂等存档都不变；恢复后同一 ticket（同一幂等键）照常并号', async () => {
  const s = await scene(kit);
  await s.binding(s.source, { platform: 'taobao', status: 'active' });
  await s.pushToken(s.source, s.session.sid);
  const ticket = await s.offer();
  const key = randomUUID();
  const before = { rows: await s.snapshot(), idempotency: await idempotencyRows(s.db, s.appId) };
  const gate = await s.hold(s.target);

  // The merge read the ticket and now waits on the target's row. From here on GET / SET of the
  // ticket store keep working (a second read after the lock succeeds); only the script that
  // consumes the ticket (compare-and-delete) fails, the last step before the commit.
  const pending = s.merge(ticket, { key });
  await s.queued(gate, [pending]);
  let fault: { disarm(): void } | undefined;
  try {
    fault = await failTicketScripts(kit);
  } finally {
    await gate.release();
  }
  const response = await pending.finally(() => {
    fault?.disarm();
  });

  const body = answer(kit, response, 50001);

  expect(JSON.stringify(body)).not.toContain('tokens');
  expect(await s.snapshot()).toEqual(before.rows);
  expect(await idempotencyRows(s.db, s.appId)).toEqual(before.idempotency);
  expect(await s.rows.sessions(s.target)).toEqual([]);
  await usable(s, s.session.access_token);
  await s.ticketKept(ticket);

  merged(kit, await s.merge(ticket, { key }), s.target);
  expect(await s.user(s.source)).toMatchObject({ status: 'deleted', deleted_reason: 'merged' });
  expect((await s.rows.oauth(s.target)).map((row) => row.id)).toEqual([s.sourceOauth]);
});

it('[AC-B1-20c#30] 请求体只收 merge_ticket：缺失、空串、多余字段 → 20001，什么都不写；合法请求体照常并号', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  const before = await s.snapshot();

  for (const body of [{}, { merge_ticket: '' }, { merge_ticket: ticket, phone: s.number }]) {
    answer(kit, await s.post(MERGE_PATH, body), 20001);
  }

  expect(await s.snapshot()).toEqual(before);
  await s.ticketKept(ticket);
  merged(kit, await s.post(MERGE_PATH, { merge_ticket: ticket }), s.target);
});

it('[AC-B1-20c#31] 未登录 → 10001；低于最低支持版本 → 10405；都不写、不核销 ticket；版本够时照常并号', async () => {
  const s = await scene(kit, { minVersion: '2.0.0' });
  const ticket = await s.offer();
  const before = await s.snapshot();

  answer(kit, await s.merge(ticket, { token: null }), 10001);
  answer(kit, await s.merge(ticket, { headers: { 'x-app-version': '1.9.9' } }), 10405);

  expect(await s.snapshot()).toEqual(before);
  await s.ticketKept(ticket);
  merged(kit, await s.merge(ticket), s.target);
});
