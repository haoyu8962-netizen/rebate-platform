// B3-08ze (1) · listAgentSessionMessages mounted on the stream entry (D10-1347): GET
// /v1/agent/sessions/{id}/messages is reached through the real HTTP layer (AppModule.forEntry
// 'stream' + real PG, Fastify inject; ./kit.ts) and answers as B3-08zc's read side does — 200
// AgentHistoryResponse (items oldest first, next_cursor paging, expired per BR-AI-20), and the same
// refusals (30501, 10001, 10005, 10004 with consent_type, 30504 without data, 20001 with
// data.fields) as JSON ErrorEnvelopes with the status of contracts/error-codes.yaml.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';

import { assistantItemOf, timelessItems, userItemOf } from '../reply-persist/kit.ts';
import {
  APP,
  consent,
  newGuest,
  newMember,
  openAgent,
  sessionRow,
  setConfig,
  usePgEach,
} from '../stream-mount/kit.ts';
import { runIdOf } from '../trace-persist/kit.ts';
import {
  DAY_MS,
  createSession,
  expectHistoryOk,
  expectHistoryRefused,
  guestClient,
  historyUrl,
  memberClient,
  pastSwitchCache,
  sendTurn,
  startClock,
  streamApp,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08ze#1][BR-AI-20][BR-AI-19] 真实 stream 入口 + PG：GET /v1/agent/sessions/{id}/messages 可达——所有者读到两轮的用户消息（落库形式）与助手回复，按时间先后；200 application/json 过契约 AgentHistoryResponse，code 0、msg 空串、trace_id 为请求的 X-Trace-Id，expired=false、next_cursor=null', async () => {
  const clock = startClock();
  const owner = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, owner);
  const app = await streamApp(pg.db, clock);
  try {
    const call = await memberClient(app, pg.db, clock, owner);
    const sessionId = await createSession(call);
    const first = await sendTurn(call, sessionId, '帮我找个保温杯');
    clock.advanceMs(1_000);
    const second = await sendTurn(call, sessionId, '提现记录在哪看');

    const data = await expectHistoryOk(await call('GET', historyUrl(sessionId)));
    expect(data.expired).toBe(false);
    expect(data.next_cursor).toBeNull();
    expect(timelessItems(data.items)).toEqual([
      await userItemOf(pg.db, runIdOf(first)),
      await assistantItemOf(pg.db, first),
      await userItemOf(pg.db, runIdOf(second)),
      await assistantItemOf(pg.db, second),
    ]);
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B3-08ze#1][BR-AI-20] 真实 stream 入口 + PG：分页经查询串——limit=3 得最新 3 条（时间先后）且 next_cursor 为字符串；带该 cursor 再取得更早的 1 条且 next_cursor=null；两页拼起来等于不分页的结果', async () => {
  const clock = startClock();
  const owner = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, owner);
  const app = await streamApp(pg.db, clock);
  try {
    const call = await memberClient(app, pg.db, clock, owner);
    const sessionId = await createSession(call);
    await sendTurn(call, sessionId, '帮我找个保温杯');
    clock.advanceMs(1_000);
    await sendTurn(call, sessionId, '提现记录在哪看');

    const whole = await expectHistoryOk(await call('GET', historyUrl(sessionId)));
    expect(whole.items).toHaveLength(4);
    const newest = await expectHistoryOk(await call('GET', historyUrl(sessionId, { limit: '3' })));
    expect(newest.items).toEqual(whole.items.slice(1));
    expect(newest.next_cursor, 'an earlier page exists').toBeTypeOf('string');
    const older = await expectHistoryOk(
      await call('GET', historyUrl(sessionId, { limit: '3', cursor: newest.next_cursor! })),
    );
    expect(older.items).toEqual(whole.items.slice(0, 1));
    expect(older.next_cursor).toBeNull();
    expect(older.expired).toBe(false);
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B3-08ze#1][BR-AI-20] 真实 stream 入口 + PG：过期会话所有者仍 200 只读——最后受理 + 24 小时 − 1 毫秒 expired=false，+ 24 小时 expired=true，内容不变', async () => {
  const clock = startClock();
  const owner = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, owner);
  const app = await streamApp(pg.db, clock);
  try {
    const call = await memberClient(app, pg.db, clock, owner);
    const sessionId = await createSession(call);
    await sendTurn(call, sessionId, '帮我找个保温杯');
    const lastActive = new Date(
      (await sessionRow(pg.db, sessionId))['last_active_at'] as string | Date,
    ).getTime();

    clock.advanceMs(lastActive + DAY_MS - 1 - clock.now().getTime());
    expect(clock.now().getTime()).toBe(lastActive + DAY_MS - 1);
    // A fresh token at the new time (the first one may have expired by then).
    const later = await memberClient(app, pg.db, clock, owner);
    const live = await expectHistoryOk(await later('GET', historyUrl(sessionId)));
    expect(live.expired).toBe(false);
    expect(live.items).toHaveLength(2);

    clock.advanceMs(1);
    const expired = await expectHistoryOk(await later('GET', historyUrl(sessionId)));
    expect(expired.expired).toBe(true);
    expect(expired.items).toEqual(live.items);
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B3-08ze#1][BR-AI-20] 真实 stream 入口 + PG：别的账号拿到会话 id、不存在的会话、不是 UUID 的 id 一律 30504（HTTP 状态照 error-codes.yaml，ErrorEnvelope 无 data）；所有者照常 200', async () => {
  const clock = startClock();
  const owner = await newMember(pg.db);
  const stranger = await newMember(pg.db);
  await openAgent(pg.db);
  for (const caller of [owner, stranger]) await consent(pg.db, caller);
  const app = await streamApp(pg.db, clock);
  try {
    const mine = await memberClient(app, pg.db, clock, owner);
    const theirs = await memberClient(app, pg.db, clock, stranger);
    const sessionId = await createSession(mine);
    await sendTurn(mine, sessionId, '帮我找个保温杯');

    await expectHistoryRefused(await theirs('GET', historyUrl(sessionId)), 30504);
    await expectHistoryRefused(await mine('GET', historyUrl(randomUUID())), 30504);
    await expectHistoryRefused(await mine('GET', historyUrl('not-a-session-id')), 30504);

    const own = await expectHistoryOk(await mine('GET', historyUrl(sessionId)));
    expect(own.items).toHaveLength(2);
  } finally {
    await app.close();
  }
}, 120_000);

type Identity = 'guest' | 'unbound_member';

/**
 * BR-AI-23 GET ①–④ through HTTP, peeled one check at a time (as B3-08zc's access test does on the
 * read side): a `who` caller reads the owner's session while every check fails → 30501; agent on →
 * 10001 (guest) / 10005 (member without a bound phone); no phone requirement → 10004 with
 * consent_type; consent given → 30504. The owner reads it (200) at the end.
 */
async function peel(who: Identity): Promise<void> {
  const clock = startClock();
  await openAgent(pg.db);
  const owner = await newMember(pg.db);
  await consent(pg.db, owner);
  const caller =
    who === 'guest' ? await newGuest(pg.db) : await newMember(pg.db, { phoneBound: false });
  const app = await streamApp(pg.db, clock);
  try {
    const mine = await memberClient(app, pg.db, clock, owner);
    const sessionId = await createSession(mine);
    const call =
      who === 'guest' ? guestClient(app, caller) : await memberClient(app, pg.db, clock, caller);

    await setConfig(pg.db, APP, 'agent.require_phone', true);
    await setConfig(pg.db, APP, 'agent.enabled', false);
    pastSwitchCache(clock);
    await expectHistoryRefused(await call('GET', historyUrl(sessionId)), 30501);

    await setConfig(pg.db, APP, 'agent.enabled', true);
    pastSwitchCache(clock);
    await expectHistoryRefused(
      await call('GET', historyUrl(sessionId)),
      who === 'guest' ? 10001 : 10005,
    );

    await setConfig(pg.db, APP, 'agent.require_phone', false);
    pastSwitchCache(clock);
    await expectHistoryRefused(await call('GET', historyUrl(sessionId)), 10004, {
      consent_type: 'ai_third_party',
    });

    await consent(pg.db, caller);
    await expectHistoryRefused(await call('GET', historyUrl(sessionId)), 30504);

    const own = await expectHistoryOk(await mine('GET', historyUrl(sessionId)));
    expect(own.items).toEqual([]);
  } finally {
    await app.close();
  }
}

it('[AC-B3-08ze#1][BR-AI-20][BR-AI-23] 真实 stream 入口 + PG：GET 历史按 ①–④ 经 HTTP 逐项剥离（游客，无 token 带 X-Device-Id）：30501 → 10001 → 10004（consent_type=ai_third_party）→ 30504；所有者 200', async () => {
  await peel('guest');
}, 120_000);

it('[AC-B3-08ze#1][BR-AI-20][BR-AI-23] 真实 stream 入口 + PG：GET 历史按 ①–④ 经 HTTP 逐项剥离（已登录未绑手机）：30501 → 10005 → 10004（consent_type=ai_third_party）→ 30504；所有者 200', async () => {
  await peel('unbound_member');
}, 120_000);

it('[AC-B3-08ze#1][BR-AI-20] 真实 stream 入口 + PG：所有者的查询串不合法 → 20001（HTTP 400，data.fields 指明字段）：limit=0、limit=51、limit=abc → [limit]；不是本接口给出的 cursor → [cursor]；合法查询照常 200', async () => {
  const clock = startClock();
  const owner = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, owner);
  const app = await streamApp(pg.db, clock);
  try {
    const call = await memberClient(app, pg.db, clock, owner);
    const sessionId = await createSession(call);
    await sendTurn(call, sessionId, '帮我找个保温杯');

    for (const limit of ['0', '51', 'abc']) {
      const refused = await expectHistoryRefused(
        await call('GET', historyUrl(sessionId, { limit })),
        20001,
        { fields: ['limit'] },
      );
      expect(refused['code'], `limit=${limit}`).toBe(20001);
    }
    await expectHistoryRefused(
      await call('GET', historyUrl(sessionId, { cursor: 'AAAA' })),
      20001,
      { fields: ['cursor'] },
    );

    const page = await expectHistoryOk(await call('GET', historyUrl(sessionId, { limit: '50' })));
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  } finally {
    await app.close();
  }
}, 120_000);
