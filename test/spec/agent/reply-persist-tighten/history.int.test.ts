// B3-08zd · BR-AI-20 / BR-AI-23。真实 PG；历史分页从最新页向前取，每页内部正序。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import {
  consent,
  newMember,
  openAgent,
  openSession,
  rig,
  setConfig,
  usePgEach,
} from '../stream-mount/kit.ts';
import {
  expectHistory,
  expectHistoryRefused,
  historySide,
  listHistory,
} from '../reply-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08zd#1][BR-AI-23] 白名单开启：已绑手机、已同意的非名单会员读自己的历史也返回 30501；先于归属校验', async () => {
  await openAgent(pg.db);
  const owner = await newMember(pg.db);
  await consent(pg.db, owner);
  const r = await rig(pg.db);
  try {
    const session = await openSession(r, owner);
    await setConfig(pg.db, owner.appId, 'agent.whitelist_only', true);
    await setConfig(pg.db, owner.appId, 'agent.whitelist_user_ids', [randomUUID()]);
    const history = await historySide(pg.pool(), r.time.clock);
    for (const id of [session, randomUUID()]) {
      const answer = await listHistory(history, owner, id);
      await expectHistoryRefused(answer.reply, answer.caller, 30501);
    }
    await setConfig(pg.db, owner.appId, 'agent.whitelist_user_ids', [owner.userId!]);
    const allowed = await listHistory(await historySide(pg.pool(), r.time.clock), owner, session);
    expect((await expectHistory(allowed.reply, allowed.caller)).items).toEqual([]);
  } finally {
    await r.runtime.close();
  }
}, 60_000);

it('[AC-B3-08zd#5][BR-AI-20] 归属不符的已同意会员读历史 → 30504，无 data，与不存在一致', async () => {
  await openAgent(pg.db);
  const owner = await newMember(pg.db);
  await consent(pg.db, owner);
  const r = await rig(pg.db);
  try {
    const session = await openSession(r, owner);
    const other = await newMember(pg.db, { appId: `synthetic-b3-08zd-${randomUUID()}` });
    await openAgent(pg.db, other.appId);
    await consent(pg.db, other);
    const history = await historySide(pg.pool(), r.time.clock);
    const bodies: unknown[] = [];
    for (const id of [session, randomUUID()]) {
      const answer = await listHistory(history, other, id);
      await expectHistoryRefused(answer.reply, answer.caller, 30504);
      const { trace_id: traceId, ...body } = answer.reply.single().body;
      expect(traceId).toBe(answer.caller.traceId);
      bodies.push(body);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    const own = await listHistory(history, owner, session);
    expect((await expectHistory(own.reply, own.caller)).items).toEqual([]);
  } finally {
    await r.runtime.close();
  }
}, 60_000);
