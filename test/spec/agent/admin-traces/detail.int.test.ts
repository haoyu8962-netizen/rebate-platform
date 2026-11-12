// B1-10q detail rule tests (claude-independent, SPEC_REF a36eb936): adminGetAgentSession
// (GET /admin/v1/agent-traces/sessions/{session_id}, CT-24zzi). Only the console's app: a session
// of another app and an unknown session are both 20001 data.fields=[session_id], the same answer
// (not probed), and other apps' sessions never show in the list. The data is the session header
// (as in the list) and four lists: messages in time order with the stored (masked) text,
// null after the owner's deletion (BR-AI-22, rows kept); runs in accepted_at order, the columns of a
// run without a model or still going null; tool_calls by run then seq with args as stored (null
// kept); cards in the order sent, shaped as the user's history cards. Never user_text, a device id,
// a phone number, user_hash or app_id. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ago,
  detailOf,
  doneRun,
  fixture,
  insertRun,
  invalid,
  leaksNone,
  otherApp,
  page,
  plus,
  runView,
  seedConversation,
  seedMember,
  seedSession,
  sessionHeader,
  sessionItem,
  suite,
  withTraceAdmin,
  withoutTrace,
} from './kit.ts';

const s = suite();

function header(data: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: data['session_id'],
    user_id: data['user_id'],
    started_at: data['started_at'],
    last_active_at: data['last_active_at'],
    expired: data['expired'],
  };
}

function column(data: Record<string, unknown>, name: string, key: string): unknown[] {
  const value = data[name];
  expect(Array.isArray(value), name).toBe(true);
  return (value as Record<string, unknown>[]).map((entry) => entry[key]);
}

it('[AC-B1-10q#8] app 隔离与不探测：别的 app 的会话（会员或游客）不出现在列表、total 也不算，按它的 session_id / user_id 筛选得空；明细读别的 app 的会话与不存在的 session_id 都是 20001 data.fields=[session_id]，两者响应除 trace_id 外完全一致，不带对方任何内容', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  const mine = await seedConversation(f, { startedAt: ago(f, 90) });
  const foreignMember = await seedMember(g);
  const foreign = await seedConversation(g, { member: foreignMember, startedAt: ago(f, 60) });
  const foreignGuest = await seedSession(g, { startedAt: ago(f, 30) });
  await withTraceAdmin(f, async (h) => {
    const all = await page(await h.list({ page_size: '200' }));
    expect(all.total).toBe(1);
    expect(all.items.map((item) => item['session_id'])).toEqual([mine.session.id]);
    const queries: Record<string, string>[] = [
      { session_id: foreign.session.id },
      { session_id: foreignGuest.id },
      { user_id: foreignMember.id },
    ];
    for (const query of queries) {
      const result = await page(await h.list(query));
      expect(result.total, JSON.stringify(query)).toBe(0);
      expect(result.items, JSON.stringify(query)).toEqual([]);
    }
    expect(await detailOf(await h.detail(mine.session.id))).toEqual(mine.detail);

    const unknown = await h.detail(randomUUID());
    const other = await h.detail(foreign.session.id);
    const otherGuest = await h.detail(foreignGuest.id);
    for (const sent of [unknown, other, otherGuest]) await invalid(sent, ['session_id']);
    expect(withoutTrace(other)).toEqual(withoutTrace(unknown));
    expect(withoutTrace(otherGuest)).toEqual(withoutTrace(unknown));
    leaksNone(other, [...foreign.texts, ...foreign.hidden, foreignMember.id]);
  });
});

it('[AC-B1-10q#9] 明细会话头与消息：会话头与列表同口径（游客 user_id 为 null）；messages 只含本会话、按时间顺序、字段恰为契约所列，text 原样返回库里的（已脱敏）文本，card_ids、feedback、badcase 与举报四项照库；响应里查不到 user_text、设备标识、手机号、app_id、别的会话的文本', async () => {
  const f = fixture(s);
  const member = await seedMember(f);
  const c = await seedConversation(f, { member });
  const guest = await seedConversation(f, { startedAt: ago(f, 200) });
  await withTraceAdmin(f, async (h) => {
    const sent = await h.detail(c.session.id);
    const data = await detailOf(sent);
    expect(header(data)).toEqual(sessionHeader(c.session, false));
    expect(data['user_id']).toBe(member.id);
    const listed = await page(await h.list({ session_id: c.session.id }));
    expect(listed.items).toEqual([
      sessionItem(c.session, { expired: false, run_count: 3, badcase_count: 1, report_count: 2 }),
    ]);
    const item = listed.items[0];
    expect(item === undefined ? undefined : header(item)).toEqual(header(data));

    expect(data['messages']).toEqual(c.detail['messages']);
    expect(column(data, 'messages', 'message_id')).toEqual([...c.messageIds]);
    expect(column(data, 'messages', 'role')).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    leaksNone(sent, [...c.hidden, ...guest.texts, ...guest.hidden]);

    const guestSent = await h.detail(guest.session.id);
    const guestData = await detailOf(guestSent);
    expect(guestData['user_id']).toBeNull();
    expect(guestData).toEqual(guest.detail);
    leaksNone(guestSent, [...guest.hidden, ...c.texts]);
  });
});

it('[AC-B1-10q#10] 用户数据删除后（BR-AI-22：user_id 换成 user_hash、文本与 report_reason 置空、行保留）：明细 user_id 为 null，消息行都在、text 为 null，被举报的回复 report_reason 为 null 而 report_status 等照旧，工具参数为 null，卡片照库；查不到 user_hash', async () => {
  const f = fixture(s);
  const erased = await seedConversation(f, { erased: true });
  await withTraceAdmin(f, async (h) => {
    const sent = await h.detail(erased.session.id);
    const data = await detailOf(sent);
    expect(data).toEqual(erased.detail);
    expect(data['user_id']).toBeNull();
    expect(column(data, 'messages', 'message_id')).toEqual([...erased.messageIds]);
    expect(column(data, 'messages', 'text')).toEqual([null, null, null, null, null]);
    expect(column(data, 'messages', 'report_reason')).toEqual([null, null, null, null, null]);
    expect(column(data, 'messages', 'report_status')).toEqual([
      null,
      'pending',
      null,
      'handled',
      null,
    ]);
    expect(column(data, 'messages', 'badcase')).toEqual([false, true, false, false, false]);
    expect(column(data, 'tool_calls', 'args')).toEqual([null, null, null, null]);
    expect(column(data, 'runs', 'run_id')).toEqual([...erased.runIds]);
    leaksNone(sent, erased.hidden);
    const listed = await page(await h.list({ session_id: erased.session.id }));
    expect(listed.items).toEqual([
      sessionItem(erased.session, {
        expired: false,
        run_count: 3,
        badcase_count: 1,
        report_count: 2,
      }),
    ]);
  });
});

it('[AC-B1-10q#11] 明细 runs：按 accepted_at 顺序（与 run_id 大小、写入顺序无关），字段恰为契约 14 个；未调模型的 run model / model_snapshot / cost_mfen / token 为 null，进行中的 run latency_ms / finish_reason / ended_at 为 null；filter_hits 照库；不带 user_text', async () => {
  const f = fixture(s);
  const c = await seedConversation(f);
  // A second session whose run ids descend while accepted_at ascends.
  const other = await seedSession(f, { startedAt: ago(f, 600), lastActiveAt: ago(f, 500) });
  const runIds = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
  const runs = runIds.map((id, index) =>
    doneRun(plus(other.startedAt, (index + 1) * 60_000), {
      id,
      intent: index === 1 ? null : 'rule_qa',
      filterHits: index === 2 ? ['tpwd'] : [],
    }),
  );
  for (const index of [1, 2, 0]) await insertRun(f, other, runs[index]!);
  await withTraceAdmin(f, async (h) => {
    const sent = await h.detail(c.session.id);
    const data = await detailOf(sent);
    expect(data['runs']).toEqual(c.detail['runs']);
    expect(column(data, 'runs', 'run_id')).toEqual([...c.runIds]);
    const [done, bare, going] = (data['runs'] as Record<string, unknown>[]).map((run) => ({
      ...run,
    }));
    expect(done).toMatchObject({ model: 'qwen-plus', cost_mfen: 4500, finish_reason: 'stop' });
    expect(done?.['filter_hits']).toEqual(['amount', 'url']);
    expect(bare).toMatchObject({
      model: null,
      model_snapshot: null,
      cost_mfen: null,
      input_tokens: null,
      output_tokens: null,
      finish_reason: 'fallback',
    });
    expect(going).toMatchObject({ latency_ms: null, finish_reason: null, ended_at: null });
    expect(going?.['model']).toBe('qwen-max');
    leaksNone(sent, c.hidden);

    const otherData = await detailOf(await h.detail(other.id));
    expect(otherData['runs']).toEqual(runs.map(runView));
    expect(column(otherData, 'runs', 'run_id')).toEqual(runIds);
    expect(otherData['messages']).toEqual([]);
    expect(otherData['tool_calls']).toEqual([]);
    expect(otherData['cards']).toEqual([]);
    expect(header(otherData)).toEqual(sessionHeader(other, false));
  });
});

it('[AC-B1-10q#12] 明细 tool_calls 与 cards：tool_calls 只含本会话的，按 run（accepted_at 顺序）再按 seq，args 原样（含 null）、status 与 latency_ms 照库；cards 只含本会话的，按发送顺序，形状同用户侧历史卡片（card_id、type、schema_version、data、fallback_text），收益卡只有 as_of 与 actions', async () => {
  const f = fixture(s);
  const c = await seedConversation(f);
  const sibling = await seedConversation(f, { startedAt: ago(f, 400) });
  await withTraceAdmin(f, async (h) => {
    const data = await detailOf(await h.detail(c.session.id));
    expect(data['tool_calls']).toEqual(c.detail['tool_calls']);
    const [r1, r2, r3] = c.runIds;
    expect(column(data, 'tool_calls', 'run_id')).toEqual([r1, r2, r2, r3]);
    expect(column(data, 'tool_calls', 'seq')).toEqual([1, 1, 2, 1]);
    expect(column(data, 'tool_calls', 'args')[2]).toBeNull();
    expect(column(data, 'tool_calls', 'latency_ms')).toEqual([120, 300, null, 80]);
    expect(data['cards']).toEqual(c.detail['cards']);
    expect(column(data, 'cards', 'card_id')).toEqual(['c1', 'c2', 'c3']);
    const earnings = (data['cards'] as Record<string, unknown>[])[0];
    expect(Object.keys((earnings?.['data'] ?? {}) as object).sort()).toEqual(['actions', 'as_of']);

    const siblingData = await detailOf(await h.detail(sibling.session.id));
    expect(siblingData['tool_calls']).toEqual(sibling.detail['tool_calls']);
    expect(siblingData['cards']).toEqual(sibling.detail['cards']);
    expect(column(siblingData, 'tool_calls', 'run_id')).toEqual([
      sibling.runIds[0],
      sibling.runIds[1],
      sibling.runIds[1],
      sibling.runIds[2],
    ]);
  });
});
