import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import {
  append,
  detail,
  expectItems,
  FROM,
  grant,
  page,
  seed,
  setup,
  signedIn,
  TO,
} from '../audit-query/kit.ts';
import {
  CLOCK_DAY,
  derived,
  inWindow,
  MESSAGE_PREFIX,
  MESSAGE_TYPE,
  REPORT,
  REPORT_HANDLE,
  seedAgentSession,
  SESSION_PREFIX,
  SESSION_TYPE,
  TRACE,
  TRACE_SESSIONS,
  TRACE_VIEW,
} from './kit.ts';

// B1-10s (编排 D10-1341 ③, task §9): the audit console's derivation table registers the two Agent
// admin actions. Real HTTP (admin entry) and PG, run only by the container runner. Expected values
// are written out here, never computed by the production table.
const h = useHarness();
const WINDOW = { from: FROM, to: TO };

it('[AC-B1-10s#1] agent_trace_view 与 agent_report_handle 在列表与详情里推出会话、消息与权限点，且别的已登记 action 推导不变', async () => {
  const f = await setup(h);
  const sessionId = randomUUID();
  const messageId = randomUUID();
  await append(h, f.actor, {
    action: TRACE_VIEW,
    target: `${SESSION_PREFIX}${sessionId}`,
    at: inWindow(60),
  });
  const before = { report_status: 'pending' };
  const after = { report_status: 'handled' };
  await append(h, f.actor, {
    action: REPORT_HANDLE,
    target: `${MESSAGE_PREFIX}${messageId}`,
    before,
    after,
    at: inWindow(120),
  });
  const result = await page(f);
  expect(result.total).toBe(2);
  expect(result.items.map(derived)).toEqual([
    {
      action: REPORT_HANDLE,
      target_type: MESSAGE_TYPE,
      target_id: messageId,
      permission: REPORT,
    },
    {
      action: TRACE_VIEW,
      target_type: SESSION_TYPE,
      target_id: sessionId,
      permission: TRACE,
    },
  ]);
  const [report, view] = [result.items[0]!, result.items[1]!];
  expect(await detail(f, report.id)).toEqual({ ...report, before, after });
  expect(await detail(f, view.id)).toEqual({ ...view, before: null, after: null });

  // Other registered actions keep their derivation and filters (was #4; merged per 第 2 轮裁定 2).
  const userId = randomUUID();
  const orderId = randomUUID();
  const taskId = randomUUID();
  await append(h, f.actor, { at: inWindow(1) });
  await append(h, f.actor, {
    action: 'user_risk_state_change',
    target: userId,
    after: { user_id: userId, action: 'ban', reason: 'fixture' },
    at: inWindow(2),
  });
  await append(h, f.actor, {
    action: 'order_reason_sub_set',
    target: `orders:${orderId}`,
    at: inWindow(3),
  });
  await append(h, f.actor, {
    action: 'export_unmasked',
    target: `export_tasks:${taskId}`,
    after: { task_id: taskId, resource: 'users', reason: 'fixture', row_count: 1 },
    at: inWindow(4),
  });
  // Agent rows sharing the other rows' ids.
  await append(h, f.actor, {
    action: TRACE_VIEW,
    target: `${SESSION_PREFIX}${userId}`,
    at: inWindow(5),
  });
  await append(h, f.actor, {
    action: REPORT_HANDLE,
    target: `${MESSAGE_PREFIX}${orderId}`,
    at: inWindow(6),
  });
  const all = await page(f);
  const others = all.items.filter(
    (item) => item.action !== TRACE_VIEW && item.action !== REPORT_HANDLE,
  );
  expect(others.map(derived)).toEqual([
    {
      action: 'export_unmasked',
      target_type: 'export_task',
      target_id: taskId,
      permission: 'pii.reveal_phone',
    },
    {
      action: 'order_reason_sub_set',
      target_type: 'order',
      target_id: orderId,
      permission: 'order.claim',
    },
    {
      action: 'user_risk_state_change',
      target_type: 'user',
      target_id: userId,
      permission: 'risk.ban',
    },
    { action: 'admin.login', target_type: 'admin_user', target_id: f.actor.id, permission: null },
  ]);
  for (const item of others) expect(derived(await detail(f, item.id))).toEqual(derived(item));
  expectItems(await page(f, { ...WINDOW, target_type: 'user', target_id: userId }), [userId]);
  expectItems(await page(f, { ...WINDOW, target_type: 'order' }), [orderId]);
  expectItems(await page(f, { ...WINDOW, target_type: 'order', target_id: orderId }), [orderId]);
  expectItems(await page(f, { ...WINDOW, permission: 'risk.ban' }), [userId]);
  expectItems(await page(f, { ...WINDOW, permission: 'order.claim' }), [orderId]);
  expectItems(await page(f, { ...WINDOW, permission: 'pii.reveal_phone' }), [taskId]);
  expectItems(await page(f, { ...WINDOW, target_type: 'admin_user' }), [f.actor.id]);
});

it('[AC-B1-10s#2] 按 target_type + target_id 与按 agent.trace / agent.report 筛选只命中对应记录', async () => {
  const f = await setup(h);
  const [s1, s2, m1, m2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await append(h, f.actor, {
    action: TRACE_VIEW,
    target: `${SESSION_PREFIX}${s1}`,
    at: inWindow(10),
  });
  await append(h, f.actor, {
    action: TRACE_VIEW,
    target: `${SESSION_PREFIX}${s2}`,
    at: inWindow(20),
  });
  await append(h, f.actor, {
    action: REPORT_HANDLE,
    target: `${MESSAGE_PREFIX}${m1}`,
    at: inWindow(30),
  });
  await append(h, f.actor, {
    action: REPORT_HANDLE,
    target: `${MESSAGE_PREFIX}${m2}`,
    at: inWindow(40),
  });
  // Other registered actions whose derived target_id equals an agent row's id.
  await append(h, f.actor, {
    action: 'user_pii_reveal',
    target: s1,
    after: { user_id: s1, field: 'phone', reason: 'fixture' },
    at: inWindow(50),
  });
  await append(h, f.actor, {
    action: 'order_reason_sub_set',
    target: `orders:${m1}`,
    at: inWindow(60),
  });

  const bySession = await page(f, { ...WINDOW, target_type: SESSION_TYPE, target_id: s1 });
  expectItems(bySession, [s1]);
  expect(derived(bySession.items[0]!)).toEqual({
    action: TRACE_VIEW,
    target_type: SESSION_TYPE,
    target_id: s1,
    permission: TRACE,
  });
  const byMessage = await page(f, { ...WINDOW, target_type: MESSAGE_TYPE, target_id: m1 });
  expectItems(byMessage, [m1]);
  expect(derived(byMessage.items[0]!)).toEqual({
    action: REPORT_HANDLE,
    target_type: MESSAGE_TYPE,
    target_id: m1,
    permission: REPORT,
  });
  expectItems(await page(f, { ...WINDOW, target_type: SESSION_TYPE }), [s2, s1]);
  expectItems(await page(f, { ...WINDOW, target_type: MESSAGE_TYPE }), [m2, m1]);
  const sameSessionId = await page(f, { ...WINDOW, target_id: s1 });
  expectItems(sameSessionId, [s1, s1]);
  expect(sameSessionId.items.map((item) => item.action)).toEqual(['user_pii_reveal', TRACE_VIEW]);
  const sameMessageId = await page(f, { ...WINDOW, target_id: m1 });
  expectItems(sameMessageId, [m1, m1]);
  expect(sameMessageId.items.map((item) => item.action)).toEqual([
    'order_reason_sub_set',
    REPORT_HANDLE,
  ]);
  const traced = await page(f, { ...WINDOW, permission: TRACE });
  expectItems(traced, [s2, s1]);
  expect(traced.items.every((item) => item.action === TRACE_VIEW)).toBe(true);
  const reported = await page(f, { ...WINDOW, permission: REPORT });
  expectItems(reported, [m2, m1]);
  expect(reported.items.every((item) => item.action === REPORT_HANDLE)).toBe(true);
  // Crossed and near-miss filters match nothing.
  for (const query of [
    { target_type: SESSION_TYPE, target_id: m1 },
    { target_type: MESSAGE_TYPE, target_id: s1 },
    { target_type: MESSAGE_TYPE, permission: TRACE },
    { target_type: SESSION_TYPE, permission: REPORT },
    { target_id: s1, permission: REPORT },
    { target_id: m1, permission: TRACE },
    { target_type: 'agent_sessions' },
    { target_type: 'agent_messages' },
    { target_type: 'Agent_session' },
    { target_type: 'agent' },
    { target_id: `${SESSION_PREFIX}${s1}` },
    { target_id: `${MESSAGE_PREFIX}${m1}` },
    { target_id: s1.slice(0, -1) },
  ]) {
    expectItems(await page(f, { ...WINDOW, ...query }), []);
  }
});

it('[AC-B1-10s#3] 前缀不符或无对象时 target_type、target_id 为 null 且不被对象筛选命中', async () => {
  const f = await setup(h);
  const [good1, good2] = [randomUUID(), randomUUID()];
  await append(h, f.actor, {
    action: TRACE_VIEW,
    target: `${SESSION_PREFIX}${good1}`,
    at: inWindow(1),
  });
  await append(h, f.actor, {
    action: REPORT_HANDLE,
    target: `${MESSAGE_PREFIX}${good2}`,
    at: inWindow(2),
  });
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const mismatched: [string, string | null][] = [
    [TRACE_VIEW, `${MESSAGE_PREFIX}${ids[0]}`],
    [TRACE_VIEW, ids[1]!],
    [TRACE_VIEW, `Agent_sessions:${ids[2]}`],
    [TRACE_VIEW, SESSION_PREFIX],
    [TRACE_VIEW, `${SESSION_PREFIX}${'x'.repeat(129)}`],
    [TRACE_VIEW, null],
    [REPORT_HANDLE, `${SESSION_PREFIX}${ids[3]}`],
    [REPORT_HANDLE, ids[4]!],
    [REPORT_HANDLE, `agent_message:${ids[5]}`],
  ];
  for (const [index, [action, target]] of mismatched.entries()) {
    await append(h, f.actor, { action, target, at: inWindow(10 + index) });
  }
  // Positive control first: the well-formed rows are found by their object.
  expectItems(await page(f, { ...WINDOW, target_type: SESSION_TYPE }), [good1]);
  expectItems(await page(f, { ...WINDOW, target_type: MESSAGE_TYPE }), [good2]);
  const all = await page(f, { ...WINDOW, page_size: 200 });
  expect(all.total).toBe(mismatched.length + 2);
  const rest = all.items.filter((item) => item.target_id !== good1 && item.target_id !== good2);
  expect(rest).toHaveLength(mismatched.length);
  // permission of these rows is deliberately not asserted: see the B1-10s output (blocked_reason).
  for (const item of rest) {
    expect(item).toMatchObject({ target_type: null, target_id: null });
    expect(await detail(f, item.id)).toMatchObject({ target_type: null, target_id: null });
  }
  for (const id of ids) {
    for (const query of [
      { target_id: id },
      { target_type: SESSION_TYPE, target_id: id },
      { target_type: MESSAGE_TYPE, target_id: id },
    ]) {
      expectItems(await page(f, { ...WINDOW, ...query }), []);
    }
  }
  for (const target_id of ['x'.repeat(128), `${MESSAGE_PREFIX}${ids[0]}`]) {
    expectItems(await page(f, { ...WINDOW, target_id }), []);
  }
});

it('[AC-B1-10s#5] 后台真实查看会话明细写下的 agent_trace_view 在审计台推出会话与 agent.trace', async () => {
  const f = await setup(h);
  const viewer = await seed(h, f.appId);
  await grant(h, viewer, f.actor, [TRACE]);
  const signed = await signedIn(f, viewer);
  const sessionId = await seedAgentSession(h, f.appId);
  const read = await f.read(signed.admin_token, `${TRACE_SESSIONS}/${sessionId}`);
  expect(read.statusCode).toBe(200);
  expect(read.json()).toMatchObject({ code: 0, data: { session_id: sessionId } });
  const stored = await h.db
    .selectFrom('audit_logs')
    .select(['action', 'target', 'admin_id'])
    .where('app_id', '=', f.appId)
    .where('action', '=', TRACE_VIEW)
    .execute();
  expect(stored).toEqual([
    { action: TRACE_VIEW, target: `${SESSION_PREFIX}${sessionId}`, admin_id: viewer.id },
  ]);
  const expected = {
    action: TRACE_VIEW,
    target_type: SESSION_TYPE,
    target_id: sessionId,
    permission: TRACE,
  };
  const found = await page(f, { ...CLOCK_DAY, target_type: SESSION_TYPE, target_id: sessionId });
  expectItems(found, [sessionId]);
  const item = found.items[0]!;
  expect(derived(item)).toEqual(expected);
  expect(item.actor_id).toBe(viewer.id);
  expect(derived(await detail(f, item.id))).toEqual(expected);
  expectItems(await page(f, { ...CLOCK_DAY, permission: TRACE }), [sessionId]);
  expectItems(await page(f, { ...CLOCK_DAY, permission: REPORT }), []);
  const crossed = { ...CLOCK_DAY, target_type: MESSAGE_TYPE, target_id: sessionId };
  expectItems(await page(f, crossed), []);
});
