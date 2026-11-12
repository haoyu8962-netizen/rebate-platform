// B1-10q detail rule tests, round 2 (claude-independent, SPEC_REF a36eb936): adminGetAgentSession
// (GET /admin/v1/agent-traces/sessions/{session_id}, CT-24zzi). The header's expired follows
// BR-AI-20 (last_active_at + 24 h ≤ now, or expired_at set and passed) and equals the list's expired
// of the same session; tool_calls go by run in accepted_at order, then by seq — not by run_id, row
// id or created_at. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ago,
  detailOf,
  doneRun,
  fixture,
  insertRun,
  insertToolCall,
  page,
  plus,
  runView,
  seedSession,
  sessionHeader,
  suite,
  toolCallView,
  withTraceAdmin,
  type Session,
  type ToolCallRow,
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

it('[AC-B1-10q#14] 明细会话头的 expired 按 BR-AI-20：last_active_at 恰好在 now 前 24 小时 → true；expired_at 已设且已过 → true；last_active_at 在 now 前 23 小时 59 分、expired_at 为空 → false；每种情况明细的 expired 与列表里同一会话的 expired 相等', async () => {
  const f = fixture(s);
  // Idle exactly 24 hours, expired_at not set → expired.
  const idle24h = await seedSession(f, {
    startedAt: ago(f, 25 * 60),
    lastActiveAt: ago(f, 24 * 60),
  });
  // Active 4 hours ago, but expired_at set 3 hours ago → expired.
  const closed = await seedSession(f, {
    startedAt: ago(f, 5 * 60),
    lastActiveAt: ago(f, 4 * 60),
    expiredAt: ago(f, 3 * 60),
  });
  // Idle 23 h 59 min, expired_at not set → not expired.
  const idle2359 = await seedSession(f, {
    startedAt: ago(f, 24 * 60),
    lastActiveAt: ago(f, 24 * 60 - 1),
  });
  const cases: [Session, boolean][] = [
    [idle24h, true],
    [closed, true],
    [idle2359, false],
  ];
  await withTraceAdmin(f, async (h) => {
    for (const [session, expired] of cases) {
      const label = `${session.id} expired=${String(expired)}`;
      const data = await detailOf(await h.detail(session.id));
      expect(data['expired'], label).toBe(expired);
      expect(header(data), label).toEqual(sessionHeader(session, expired));
      const listed = await page(await h.list({ session_id: session.id }));
      expect(listed.items, label).toHaveLength(1);
      expect(listed.items[0]?.['expired'], label).toBe(expired);
      expect(data['expired'], label).toBe(listed.items[0]?.['expired']);
    }
  });
});

it('[AC-B1-10q#15] 明细 tool_calls 的顺序：run_id 大小与 accepted_at 顺序相反、工具调用乱序写入且 created_at 与目标顺序相反时，tool_calls 仍先按 run 的 accepted_at、再按 seq 排，不按 run_id、行写入顺序或 created_at', async () => {
  const f = fixture(s);
  const session = await seedSession(f, { startedAt: ago(f, 600), lastActiveAt: ago(f, 500) });
  // Run ids descend while accepted_at ascends.
  const runIds = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
  const runs = runIds.map((id, index) =>
    doneRun(plus(session.startedAt, (index + 1) * 60_000), { id }),
  );
  for (const index of [1, 2, 0]) await insertRun(f, session, runs[index]!);
  const [first, second, third] = [runs[0]!, runs[1]!, runs[2]!];
  // The expected order; created_at descends along it, so ordering by created_at reverses it.
  const late = plus(session.startedAt, 59 * 60_000);
  const at = (index: number): Date => plus(late, -index * 1000);
  const calls: ToolCallRow[] = [
    {
      runId: first.id,
      seq: 1,
      name: 'search_products',
      args: { q: 'synthetic-query-1' },
      status: 'ok',
      latencyMs: 210,
      createdAt: at(0),
    },
    {
      runId: first.id,
      seq: 2,
      name: 'get_rebate_quote',
      args: { item: 'synthetic-item-2' },
      status: 'ok',
      latencyMs: 90,
      createdAt: at(1),
    },
    {
      runId: second.id,
      seq: 1,
      name: 'search_rules',
      args: null,
      status: 'rejected',
      latencyMs: null,
      createdAt: at(2),
    },
    {
      runId: third.id,
      seq: 1,
      name: 'get_my_earnings',
      args: {},
      status: 'ok',
      latencyMs: 60,
      createdAt: at(3),
    },
    {
      runId: third.id,
      seq: 2,
      name: 'search_rules',
      args: { q: 'synthetic-query-5' },
      status: 'ok',
      latencyMs: 75,
      createdAt: at(4),
    },
    {
      runId: third.id,
      seq: 3,
      name: 'search_products',
      args: { q: 'synthetic-query-6' },
      status: 'error',
      latencyMs: 1500,
      createdAt: at(5),
    },
  ];
  for (const index of [5, 1, 3, 2, 4, 0]) await insertToolCall(f, session, calls[index]!);
  await withTraceAdmin(f, async (h) => {
    const data = await detailOf(await h.detail(session.id));
    expect(data['runs']).toEqual(runs.map(runView));
    const listed = data['tool_calls'] as Record<string, unknown>[];
    expect(listed.map((call) => [call['run_id'], call['seq']])).toEqual([
      [first.id, 1],
      [first.id, 2],
      [second.id, 1],
      [third.id, 1],
      [third.id, 2],
      [third.id, 3],
    ]);
    expect(listed).toEqual(calls.map(toolCallView));
    // Not by run_id: the run ids of the list descend.
    expect(listed.map((call) => call['run_id'])).toEqual([
      runIds[0],
      runIds[0],
      runIds[1],
      runIds[2],
      runIds[2],
      runIds[2],
    ]);
    expect(data['messages']).toEqual([]);
    expect(data['cards']).toEqual([]);
  });
});
