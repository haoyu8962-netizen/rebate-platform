// B1-10r rule tests (claude-independent, SPEC_REF ea7850e2): adminGetAgentSession
// (GET /admin/v1/agent-traces/sessions/{session_id}, CT-24zzi), follow-up of B1-10q (#3256, 编排
// D10-1341 ②). 08 BR-AI-19: the trace shows the conversation as stored. Online, the user message
// and the assistant message of one turn are written by one statement with one created_at, and their
// two ids are UUIDv7 taken in a row (same millisecond, the other bits random), so created_at → id
// puts either one first. The detail's messages go by created_at ascending, then the user message
// before the assistant message, then id (both id orders of one instant are seeded, and two messages
// of one role at one instant). Real admin entry (createHttpApp('admin')) and real
// database through ../admin-traces/kit.ts; the rows are synthetic. Top-level it() only (规划/11 §4.3).
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ago,
  detailOf,
  doneRun,
  fixture,
  insertMessage,
  insertRun,
  marker,
  messageView,
  plus,
  reply,
  seedSession,
  suite,
  userMessage,
  withTraceAdmin,
  type MessageRow,
} from '../admin-traces/kit.ts';

const s = suite();

/** A UUIDv7 (RFC 9562) of the instant: 48-bit milliseconds, version 7, variant 10, random rest. */
function uuidV7(at: Date): string {
  const time = at.getTime().toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  const variant = ((Number.parseInt(rand.charAt(3), 16) & 0x3) | 0x8).toString(16);
  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${rand.slice(0, 3)}`,
    `${variant}${rand.slice(4, 7)}`,
    rand.slice(8, 20),
  ].join('-');
}

/** Two UUIDv7 of the same instant taken in a row, ascending (the fixture checks they differ). */
function sameInstantIds(at: Date): [string, string] {
  const ids = [uuidV7(at), uuidV7(at)].sort();
  return [ids[0]!, ids[1]!];
}

it('[AC-B1-10r#1] 明细 messages 顺序：同一轮的用户与助手消息同一 created_at、助手 id 小于用户 id（线上同一语句写入、UUIDv7 同毫秒）时用户在前、助手在后；另一轮问在前答在后的照常；整体按 created_at 升序 → user 先于 assistant → id，后一轮的用户消息不越过前一轮的助手消息；另一会话里同一 created_at、助手 id 大于用户 id 的一轮同样用户在前，同角色同 created_at 的两条按 id 升序', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: ago(f, 90), lastActiveAt: ago(f, 30) });
  const first = doneRun(ago(f, 80));
  const second = doneRun(ago(f, 40));
  for (const run of [second, first]) await insertRun(f, session, run);

  // Turn one as written online: one created_at for both rows, the assistant's id the smaller one.
  const together = first.endedAt ?? plus(first.acceptedAt, 2000);
  const [assistantId, userId] = sameInstantIds(together);
  const u1: MessageRow = {
    ...userMessage(first.id, together, marker('atr-r-question-1')),
    id: userId,
  };
  const a1: MessageRow = {
    ...reply(first.id, together, marker('atr-r-answer-1')),
    id: assistantId,
  };
  expect(a1.createdAt.getTime()).toBe(u1.createdAt.getTime());
  expect(a1.id < u1.id, `${a1.id} < ${u1.id}`).toBe(true);
  for (const message of [a1, u1]) await insertMessage(f, session, message);

  // Turn two in the usual way: question first, answer two seconds later.
  const asked = second.acceptedAt;
  const answered = plus(asked, 2000);
  const u2: MessageRow = {
    ...userMessage(second.id, asked, marker('atr-r-question-2')),
    id: uuidV7(asked),
  };
  const a2: MessageRow = {
    ...reply(second.id, answered, marker('atr-r-answer-2')),
    id: uuidV7(answered),
  };
  for (const message of [a2, u2]) await insertMessage(f, session, message);

  // Another session. Turn three as written online, this time the assistant's id the larger one, so
  // ordering the ids of one instant either way round is caught by one of the two turns.
  const other = await seedSession(f, { startedAt: ago(f, 75), lastActiveAt: ago(f, 20) });
  const third = doneRun(ago(f, 70));
  const thirdAt = third.endedAt ?? plus(third.acceptedAt, 2000);
  // Turns four and five: questions a second apart, both answers stamped at one instant; the answer
  // of the later turn gets the smaller id, so only the id (not the run order) puts them in order.
  const fourth = doneRun(ago(f, 50));
  const fifth = doneRun(plus(fourth.acceptedAt, 1000));
  const answeredTogether = plus(fifth.acceptedAt, 30_000);
  for (const run of [fifth, third, fourth]) await insertRun(f, other, run);

  const [userId3, assistantId3] = sameInstantIds(thirdAt);
  const u3: MessageRow = {
    ...userMessage(third.id, thirdAt, marker('atr-r-question-3')),
    id: userId3,
  };
  const a3: MessageRow = {
    ...reply(third.id, thirdAt, marker('atr-r-answer-3')),
    id: assistantId3,
  };
  expect(a3.createdAt.getTime()).toBe(u3.createdAt.getTime());
  expect(u3.id < a3.id, `${u3.id} < ${a3.id}`).toBe(true);

  const [lowId, highId] = sameInstantIds(answeredTogether);
  const u4: MessageRow = {
    ...userMessage(fourth.id, fourth.acceptedAt, marker('atr-r-question-4')),
    id: uuidV7(fourth.acceptedAt),
  };
  const u5: MessageRow = {
    ...userMessage(fifth.id, fifth.acceptedAt, marker('atr-r-question-5')),
    id: uuidV7(fifth.acceptedAt),
  };
  const a4: MessageRow = {
    ...reply(fourth.id, answeredTogether, marker('atr-r-answer-4')),
    id: highId,
  };
  const a5: MessageRow = {
    ...reply(fifth.id, answeredTogether, marker('atr-r-answer-5')),
    id: lowId,
  };
  expect(a4.createdAt.getTime()).toBe(a5.createdAt.getTime());
  expect(a5.id < a4.id, `${a5.id} < ${a4.id}`).toBe(true);
  for (const message of [a3, a4, u5, u3, a5, u4]) await insertMessage(f, other, message);

  const expected = [u1, a1, u2, a2];
  const otherExpected = [u3, a3, u4, u5, a5, a4];
  await withTraceAdmin(f, async (h) => {
    const data = await detailOf(await h.detail(session.id));
    const messages = data['messages'] as Record<string, unknown>[];
    expect(messages.map((m) => m['role'])).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.map((m) => m['message_id'])).toEqual(expected.map((m) => m.id));
    expect(messages).toEqual(expected.map(messageView));
    // The same answer on a second read (no order left to chance).
    const again = await detailOf(await h.detail(session.id));
    expect(again['messages']).toEqual(expected.map(messageView));

    const otherData = await detailOf(await h.detail(other.id));
    const otherMessages = otherData['messages'] as Record<string, unknown>[];
    expect(otherMessages.map((m) => m['role'])).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'assistant',
      'assistant',
    ]);
    expect(otherMessages.map((m) => m['message_id'])).toEqual(otherExpected.map((m) => m.id));
    expect(otherMessages).toEqual(otherExpected.map(messageView));
    const otherAgain = await detailOf(await h.detail(other.id));
    expect(otherAgain['messages']).toEqual(otherExpected.map(messageView));
  });
});
