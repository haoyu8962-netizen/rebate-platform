// B3-08zg · BR-AI-20（sessions/{id} 下的读写只允许所有者；所有者按 app 隔离）。真实 PG。
//
// 刻画现有行为（主干应绿）：apps/api/src/modules/agent/store/owner.ts 的 ownerSessions(connection,
// owner) 先按 owner.appId 限定 app_id，再按会员 user_id 或游客（user_id、user_hash 为空且 device_id
// 相同）筛。
//
// 为什么在 store 层钉：从 HTTP 入口打不到「只差 app」的情形——同意记录与设备、用户都带 (app_id, …)
// 外键，换 app 的请求在同意校验那一步就被拒，走不到归属判断。所以这里只在 app A 用真实 store 入口
// （createPgAgentSessionStore().open）建会话，再拿一个与 A 里那位完全相同、只把 appId 换成 B 的
// owner 去查：B 不必存在、也不在 B 下写任何行，user_id / device_id 字符串与 A 里的一模一样。
//
// 对应变异：删掉 owner.ts 里 `.where('app_id', '=', owner.appId)` 那一句。删掉后换 app 的 owner
// 只剩 user_id（会员）或 user_id/user_hash 为空 + device_id（游客）这些条件，恰好命中 A 里的会话，
// 本文件的「换 app 查不到」断言随即变红；原 app 的对照断言证明查不到不是因为别的条件。
// 只用合成数据；被测对象都在测试体内构造。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { ownerSessions } from '../../../../apps/api/src/modules/agent/store/owner.ts';
import {
  agentSessionDefaults,
  createPgAgentSessionStore,
  type AgentOwner,
} from '../../../../apps/api/src/modules/agent/store/index.ts';
import { ManualTime, newGuest, newMember, usePgEach } from '../stream-mount/kit.ts';

const pg = usePgEach(createTestDatabase);

function otherApp(): string {
  return `synthetic-b3-08zg-${randomUUID()}`;
}

function memberOwner(caller: AgentCaller, appId: string = caller.appId): AgentOwner {
  expect(caller.userId, 'a member has a user id').toBeTypeOf('string');
  return { kind: 'user', appId, userId: caller.userId!, deviceId: caller.deviceId };
}

function guestOwner(caller: AgentCaller, appId: string = caller.appId): AgentOwner {
  expect(caller.userId, 'a guest has no user id').toBeNull();
  return { kind: 'device', appId, deviceId: caller.deviceId };
}

/** ids of ownerSessions(db, owner), over the app schema as the store uses it. */
async function ownedIds(owner: AgentOwner): Promise<string[]> {
  const rows = await ownerSessions(pg.db.withSchema('app'), owner).select('id').execute();
  return rows.map((row) => row.id);
}

/** The stored owner columns of one session (to show A's row is what B's owner would match). */
async function sessionOwnerColumns(id: string) {
  const result = await sql<{
    app_id: string;
    user_id: string | null;
    user_hash: unknown;
    device_id: string | null;
  }>`SELECT app_id, user_id::text AS user_id, user_hash, device_id::text AS device_id
    FROM app.agent_sessions WHERE id = ${id}`.execute(pg.db);
  expect(result.rows, `agent_sessions row ${id}`).toHaveLength(1);
  return result.rows[0]!;
}

it('[AC-B3-08zg#1][BR-AI-20] 会员：同一 user_id、同一设备，只把 app 换掉 → ownerSessions / owned / current 都查不到；原 app 查得到', async () => {
  const member = await newMember(pg.db);
  const time = new ManualTime();
  const store = createPgAgentSessionStore({
    db: pg.db,
    clock: time.clock,
    idleMs: agentSessionDefaults().idleMs,
  });
  const inA = memberOwner(member);
  const inB = memberOwner(member, otherApp());
  expect(inB.appId).not.toBe(inA.appId);
  expect({ ...inB, appId: inA.appId }, 'B 与 A 只差 appId').toEqual(inA);

  const created = await store.open(inA, randomUUID());
  const stored = await sessionOwnerColumns(created.id);
  expect(stored.app_id).toBe(inA.appId);
  expect(stored.user_id, 'the session carries the very user id B asks with').toBe(member.userId);

  // 对照：原 app 查得到（证明查不到不是因为 user_id 等别的条件）。
  expect(await ownedIds(inA)).toEqual([created.id]);
  expect(await store.owned(inA, created.id)).toMatchObject({
    session: { id: created.id },
    expired: false,
  });
  expect((await store.current(inA))?.id).toBe(created.id);

  // 只差 app：查不到。
  expect(await ownedIds(inB), 'ownerSessions of the same user in another app').toEqual([]);
  expect(await store.owned(inB, created.id), 'owned in another app').toBeNull();
  expect(await store.current(inB), 'current in another app').toBeNull();
}, 60_000);

it('[AC-B3-08zg#2][BR-AI-20] 游客：同一 device_id，只把 app 换掉 → ownerSessions / owned / current 都查不到；原 app 查得到', async () => {
  const guest = await newGuest(pg.db);
  const time = new ManualTime();
  const store = createPgAgentSessionStore({
    db: pg.db,
    clock: time.clock,
    idleMs: agentSessionDefaults().idleMs,
  });
  const inA = guestOwner(guest);
  const inB = guestOwner(guest, otherApp());
  expect(inB.appId).not.toBe(inA.appId);
  expect({ ...inB, appId: inA.appId }, 'B 与 A 只差 appId').toEqual(inA);

  const created = await store.open(inA, randomUUID());
  const stored = await sessionOwnerColumns(created.id);
  expect(stored.app_id).toBe(inA.appId);
  expect(stored.user_id, 'a guest session has no user').toBeNull();
  expect(stored.user_hash, 'a guest session has no user hash').toBeNull();
  expect(stored.device_id, 'the session carries the very device id B asks with').toBe(
    guest.deviceId,
  );

  // 对照：原 app 查得到。
  expect(await ownedIds(inA)).toEqual([created.id]);
  expect(await store.owned(inA, created.id)).toMatchObject({
    session: { id: created.id },
    expired: false,
  });
  expect((await store.current(inA))?.id).toBe(created.id);

  // 只差 app：查不到。
  expect(await ownedIds(inB), 'ownerSessions of the same device in another app').toEqual([]);
  expect(await store.owned(inB, created.id), 'owned in another app').toBeNull();
  expect(await store.current(inB), 'current in another app').toBeNull();
}, 60_000);
