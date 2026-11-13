// 2026-11-13 按编排 D10-1522 从 reply-persist-tighten/ 机械拆出（测试体逐字未改）。
// B3-08zd · BR-AI-20 / BR-AI-23。真实 PG；历史分页从最新页向前取，每页内部正序。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createPersonalDataCopyAgentReader } from '../../../../apps/api/src/modules/agent/application/personal-data-copy-read.ts';
import { consent, newMember, openAgent, openSession, rig, usePgEach } from '../stream-mount/kit.ts';
import { insertRun } from '../stream-assembly-orders/kit.ts';
import {
  expectHistory,
  expectHistoryRefused,
  historySide,
  listHistory,
  type HistoryItem,
} from '../reply-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

// 插入时就让每轮 assistant.id < user.id，不绕过不可变消息约束去改主键。
async function seededHistory() {
  await openAgent(pg.db);
  const owner = await newMember(pg.db);
  await consent(pg.db, owner);
  const r = await rig(pg.db);
  try {
    const session = await openSession(r, owner);
    const expected: { message_id: string; role: 'user' | 'assistant'; text: string }[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const runId = await insertRun(pg.db, session);
      const at = new Date(r.time.clock.now().getTime() + turn * 1_000);
      const suffix = String(turn + 1).padStart(12, '0');
      const assistant = `0192f3a1-7c00-7000-8000-${suffix}`;
      const user = `0192f3a1-7c00-7000-9000-${suffix}`;
      expect(assistant < user).toBe(true);
      for (const role of ['user', 'assistant'] as const) {
        const id = role === 'user' ? user : assistant;
        const text = `合成第${String(turn)}轮${role}`;
        await pg.db
          .insertInto('agent_messages')
          .values({
            id,
            app_id: owner.appId,
            session_id: session,
            run_id: runId,
            role,
            text,
            client_msg_id: role === 'user' ? randomUUID() : null,
            created_at: at,
            updated_at: at,
          })
          .execute();
        expected.push({ message_id: id, role, text });
      }
    }
    return { r, owner, session, expected };
  } catch (error) {
    await r.runtime.close();
    throw error;
  }
}

it('[AC-B3-08zd#7][BR-AI-20] 真库历史逐页翻到底：limit=3 跨轮切页，不重不漏、末页无游标，同轮同时间用户在前；外会话游标返回 20001', async () => {
  const x = await seededHistory();
  try {
    const history = await historySide(pg.pool(), x.r.time.clock);
    let cursor: string | null = null;
    const pages: (readonly HistoryItem[])[] = [];
    const cursors: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const answer = await listHistory(history, x.owner, x.session, {
        limit: '3',
        ...(cursor === null ? {} : { cursor }),
      });
      const data = await expectHistory(answer.reply, answer.caller);
      expect(data.items).toHaveLength(page === 2 ? 2 : 3);
      pages.unshift(data.items);
      cursor = data.next_cursor;
      if (page < 2) {
        expect(cursor).toBeTypeOf('string');
        expect(cursors).not.toContain(cursor);
        cursors.push(cursor!);
      } else expect(cursor).toBeNull();
    }
    expect(pages.flat().map(({ message_id, role, text }) => ({ message_id, role, text }))).toEqual(
      x.expected,
    );
    const otherSession = await openSession(x.r, x.owner);
    const foreign = await listHistory(history, x.owner, otherSession, {
      cursor: cursors[0],
      limit: '3',
    });
    await expectHistoryRefused(foreign.reply, foreign.caller, 20001, { fields: ['cursor'] });
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08zd#7][BR-AI-20] 个人信息副本的 Agent 对话：同轮同时间用户在前，即使助手 id 更小', async () => {
  const x = await seededHistory();
  try {
    const read = createPersonalDataCopyAgentReader({ clock: x.r.time.clock });
    const copy = await read(pg.pool(), { appId: x.owner.appId, userId: x.owner.userId! });
    expect(copy).toHaveLength(1);
    expect(copy[0]?.session_id).toBe(x.session);
    expect(copy[0]?.messages.map(({ role, text }) => ({ role, text }))).toEqual(
      x.expected.map(({ role, text }) => ({ role, text })),
    );
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
