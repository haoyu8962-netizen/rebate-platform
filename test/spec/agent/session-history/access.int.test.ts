// B3-08zc · listAgentSessionMessages access (BR-AI-20; BR-AI-23 GET ①–④ in that order): only the
// session's owner reads it — with an access token by user_id alone (never by the device), without
// one by device_id of a session with no user; a guest session does not become its user's after
// login, a member's session is not a guest's of the same device; another caller, a missing session
// and an id that is not a UUID are all 30504 without data (never told apart). ① 30501, ② 10001 /
// 10005 and ③ 10004 come first, in that order (peeled one check at a time). Real sessions of a
// minimal stream runtime (../stream-mount/kit.ts rig) over real PG; the history read side is
// createAgentHistoryRuntime on another pool; contract in ../reply-persist/kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  anotherDevice,
  consent,
  loginOnDevice,
  newGuest,
  newMember,
  openAgent,
  openSession,
  rig,
  setConfig,
  usePgEach,
} from '../stream-mount/kit.ts';
import { newId } from '../stream-recovery/kit.ts';
import {
  expectHistory,
  expectHistoryRefused,
  historySide,
  listHistory,
} from '../reply-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 归属：别的用户拿到会话 id、不存在的会话、不是 UUID 的 id 一律 30504 且无 data；所有者照常 200', async () => {
  await openAgent(pg.db);
  const owner = await newMember(pg.db);
  const stranger = await newMember(pg.db);
  for (const caller of [owner, stranger]) await consent(pg.db, caller);
  const r = await rig(pg.db);
  try {
    const sessionId = await openSession(r, owner);
    const history = await historySide(pg.pool(), r.time.clock);

    for (const [who, id] of [
      [stranger, sessionId],
      [owner, newId()],
      [owner, 'not-a-session-id'],
    ] as const) {
      const { reply, caller } = await listHistory(history, who, id);
      await expectHistoryRefused(reply, caller, 30504);
    }
    const own = await listHistory(history, owner, sessionId);
    const data = await expectHistory(own.reply, own.caller);
    expect(data.items).toEqual([]);
    expect(data.expired).toBe(false);
  } finally {
    await r.runtime.close();
  }
}, 60_000);

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 游客会话登录后不可见：设备 D 上游客建的会话，同一设备登录 u 后读 → 30504；游客身份（device_id）仍读得到', async () => {
  await openAgent(pg.db);
  const guest = await newGuest(pg.db);
  const member = await newMember(pg.db);
  for (const caller of [guest, member]) await consent(pg.db, caller);
  const r = await rig(pg.db);
  try {
    const sessionId = await openSession(r, guest);
    const history = await historySide(pg.pool(), r.time.clock);
    const asGuest = await listHistory(history, guest, sessionId);
    expect((await expectHistory(asGuest.reply, asGuest.caller)).items).toEqual([]);

    const loggedIn = await loginOnDevice(pg.db, guest, member);
    const asUser = await listHistory(history, loggedIn, sessionId);
    await expectHistoryRefused(asUser.reply, asUser.caller, 30504);
  } finally {
    await r.runtime.close();
  }
}, 60_000);

type Identity = 'guest' | 'unbound_member';

/**
 * BR-AI-23 GET ①–④ in that order, peeled one check at a time: a caller of `who` reads another
 * member's session while it fails every check (agent.enabled off, agent.require_phone on, no
 * consent, not the owner) → 30501; agent on → ② (guest 10001, member without a bound phone 10005);
 * no phone requirement → 10004; consent given → 30504. Each step leaves exactly the checks after
 * one failing, so every pair of adjacent checks (and every other pair) is told apart.
 */
async function peel(who: Identity): Promise<void> {
  await openAgent(pg.db);
  const owner = await newMember(pg.db);
  await consent(pg.db, owner);
  const caller =
    who === 'guest' ? await newGuest(pg.db) : await newMember(pg.db, { phoneBound: false });
  const r = await rig(pg.db);
  try {
    const sessionId = await openSession(r, owner);
    await setConfig(pg.db, owner.appId, 'agent.require_phone', true);
    await setConfig(pg.db, owner.appId, 'agent.enabled', false);

    const allFail = await historySide(pg.pool(), r.time.clock);
    const first = await listHistory(allFail, caller, sessionId);
    await expectHistoryRefused(first.reply, first.caller, 30501);

    await setConfig(pg.db, owner.appId, 'agent.enabled', true);
    const identityOn = await historySide(pg.pool(), r.time.clock);
    const second = await listHistory(identityOn, caller, sessionId);
    await expectHistoryRefused(second.reply, second.caller, who === 'guest' ? 10001 : 10005);

    await setConfig(pg.db, owner.appId, 'agent.require_phone', false);
    const consentLeft = await historySide(pg.pool(), r.time.clock);
    const third = await listHistory(consentLeft, caller, sessionId);
    await expectHistoryRefused(third.reply, third.caller, 10004, {
      consent_type: 'ai_third_party',
    });

    await consent(pg.db, caller);
    const ownerLeft = await historySide(pg.pool(), r.time.clock);
    const fourth = await listHistory(ownerLeft, caller, sessionId);
    await expectHistoryRefused(fourth.reply, fourth.caller, 30504);

    const own = await listHistory(ownerLeft, owner, sessionId);
    expect((await expectHistory(own.reply, own.caller)).items).toEqual([]);
  } finally {
    await r.runtime.close();
  }
}

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20][BR-AI-23] GET 按 ①–④ 顺序校验（游客逐项剥离）：四项全不过 → 30501；开 agent → 10001（身份先于同意）；不要求手机 → 10004（consent_type=ai_third_party，同意先于归属）；同意后 → 30504；所有者 200', async () => {
  await peel('guest');
}, 60_000);

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20][BR-AI-23] GET 按 ①–④ 顺序校验（已登录未绑手机逐项剥离）：四项全不过 → 30501；开 agent → 10005；不要求手机 → 10004；同意后 → 30504；所有者 200', async () => {
  await peel('unbound_member');
}, 60_000);

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 游客不能读同设备上会员的会话：会员在设备 D 上开的会话，D 上不带 token 的游客（已同意）读 → 30504；会员本人照常 200', async () => {
  await openAgent(pg.db);
  const member = await newMember(pg.db);
  await consent(pg.db, member);
  // The same device without an access token (logged out on a shared phone, the app still holding
  // the session id): a guest of device D.
  const guestOnD: AgentCaller = { ...member, userId: null, phoneBound: false };
  await consent(pg.db, guestOnD);
  const r = await rig(pg.db);
  try {
    const sessionId = await openSession(r, member);
    const history = await historySide(pg.pool(), r.time.clock);
    const asGuest = await listHistory(history, guestOnD, sessionId);
    await expectHistoryRefused(asGuest.reply, asGuest.caller, 30504);
    const asMember = await listHistory(history, member, sessionId);
    expect((await expectHistory(asMember.reply, asMember.caller)).items).toEqual([]);
  } finally {
    await r.runtime.close();
  }
}, 60_000);

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 带 token 只按 user_id 判定：会员 u1 在设备 D 上开的会话，另一账号 u2 登录到同一设备 D 后读 → 30504（不回退匹配 device_id）；u1 换一台设备读 → 200', async () => {
  await openAgent(pg.db);
  const owner = await newMember(pg.db);
  const other = await newMember(pg.db);
  await consent(pg.db, owner);
  const r = await rig(pg.db);
  try {
    const sessionId = await openSession(r, owner);
    const otherOnD = await loginOnDevice(pg.db, owner, other);
    expect(otherOnD.deviceId, 'the owner’s device').toBe(owner.deviceId);
    await consent(pg.db, otherOnD);
    const ownerElsewhere = await anotherDevice(pg.db, owner);
    expect(ownerElsewhere.deviceId).not.toBe(owner.deviceId);

    const history = await historySide(pg.pool(), r.time.clock);
    const asOther = await listHistory(history, otherOnD, sessionId);
    await expectHistoryRefused(asOther.reply, asOther.caller, 30504);
    const asOwner = await listHistory(history, ownerElsewhere, sessionId);
    const data = await expectHistory(asOwner.reply, asOwner.caller);
    expect(data.items).toEqual([]);
    expect(data.expired).toBe(false);
  } finally {
    await r.runtime.close();
  }
}, 60_000);
