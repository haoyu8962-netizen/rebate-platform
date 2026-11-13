import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { createAgentDataPurge } from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import { guestClient, memberClient } from '../session-history-http/kit.ts';
import {
  agentSnapshot,
  anotherDevice,
  consent,
  loginOnDevice,
  newGuest,
  newMember,
  usePgEach,
} from '../stream-mount/kit.ts';
import { actions, answer, seedMessages, url, validBody, withHttp } from './kit.ts';

const pg = usePgEach(createTestDatabase);

it.each(actions)(
  '[AC-B3-08zf#5][BR-AI-20] %s：别人的消息与不存在的消息响应一致，自己的 user 消息也不可写',
  async (action) => {
    await withHttp(pg.db, 'member', async (f) => {
      const stranger = await newMember(f.db);
      await consent(f.db, stranger);
      const theirs = await memberClient(f.app, f.db, f.clock, stranger);
      const before = await agentSnapshot(f.db);
      const foreign = await theirs('POST', url(action, f.messages.assistantId), validBody[action]);
      const absent = await theirs('POST', url(action, randomUUID()), validBody[action]);
      const a = await answer(action, foreign, 30504);
      const b = await answer(action, absent, 30504);
      expect({
        status: foreign.response.statusCode,
        code: a['code'],
        msg: a['msg'],
        data: a['data'],
      }).toEqual({
        status: absent.response.statusCode,
        code: b['code'],
        msg: b['msg'],
        data: b['data'],
      });
      await answer(
        action,
        await f.call('POST', url(action, f.messages.userId), validBody[action]),
        30504,
      );
      expect(await agentSnapshot(f.db)).toBe(before);
    });
  },
  120_000,
);

it.each(actions)(
  '[AC-B3-08zf#6][BR-AI-20] %s：会员设备上的游客没有会话所有权',
  async (action) => {
    await withHttp(pg.db, 'member', async (f) => {
      const guest: AgentCaller = { ...f.owner, userId: null, phoneBound: false };
      await consent(f.db, guest);
      const before = await agentSnapshot(f.db);
      await answer(
        action,
        await guestClient(f.app, guest)(
          'POST',
          url(action, f.messages.assistantId),
          validBody[action],
        ),
        30504,
      );
      expect(await agentSnapshot(f.db)).toBe(before);
    });
  },
  120_000,
);

it.each(actions)(
  '[AC-B3-08zf#7][BR-AI-20] %s：登录后不回退匹配设备，不能写以前的游客会话',
  async (action) => {
    await withHttp(pg.db, 'member', async (f) => {
      const guest = await newGuest(f.db);
      const old = await seedMessages(f.db, f.clock, guest);
      const loggedIn = await loginOnDevice(f.db, guest, f.owner);
      const call = await memberClient(f.app, f.db, f.clock, loggedIn);
      const before = await agentSnapshot(f.db);
      await answer(
        action,
        await call('POST', url(action, old.assistantId), validBody[action]),
        30504,
      );
      expect(await agentSnapshot(f.db)).toBe(before);
      // The same account does own its member session from a different device.
      const otherDevice = await anotherDevice(f.db, f.owner);
      const own = await memberClient(f.app, f.db, f.clock, otherDevice);
      await answer(
        action,
        await own('POST', url(action, f.messages.assistantId), validBody[action]),
      );
    });
  },
  120_000,
);

it.each(actions)(
  '[AC-B3-08zf#8][BR-AI-20] %s：注销清理保留设备但移除用户后，同设备游客仍不可写',
  async (action) => {
    await withHttp(pg.db, 'member', async (f) => {
      const guest: AgentCaller = { ...f.owner, userId: null, phoneBound: false };
      await consent(f.db, guest);
      const purge = createAgentDataPurge({ userHashKey: 'synthetic-b3-08zf-user-hash-key' });
      await f.db.transaction().execute((trx) =>
        purge.purgeAgentDataForUser(trx, {
          appId: f.owner.appId,
          userId: f.owner.userId!,
          at: f.clock.now(),
        }),
      );
      const session = await f.db
        .selectFrom('agent_sessions')
        .selectAll()
        .where('id', '=', f.messages.sessionId)
        .executeTakeFirstOrThrow();
      expect(session).toMatchObject({ user_id: null, device_id: f.owner.deviceId });
      expect(session.user_hash).toMatch(/^[0-9a-f]{64}$/u);
      const before = await agentSnapshot(f.db);
      await answer(
        action,
        await guestClient(f.app, guest)(
          'POST',
          url(action, f.messages.assistantId),
          validBody[action],
        ),
        30504,
      );
      expect(await agentSnapshot(f.db)).toBe(before);
    });
  },
  120_000,
);
