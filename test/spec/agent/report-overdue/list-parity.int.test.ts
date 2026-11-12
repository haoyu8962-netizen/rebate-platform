// B1-10u rule tests, count = list (claude-independent, SPEC_REF 62b5c993): 编排 D10-1382 ② /
// D10-1399 (a) and contracts/openapi.yaml adminListAgentReports (GET
// /admin/v1/agent-traces/reports, permission agent.trace; `overdue` = pending and now ≥
// deadline_at = reported_at + 48 h, "the same rule as the workbench card agent_report_overdue",
// whose count AdminDashboardTodo.count is the pending number of that card's list page). With one
// batch of reports and one injected clock, countOverdueAgentReports equals the list's total for
// status=pending&overdue=true (and the same messages are listed), and every listed row's
// `overdue` equals isAgentReportOverdue of that row — at T and again 1 ms later, when the report
// reported 1 ms short of 48 hours becomes due. The list itself is B1-10t's (dep): while that
// route is not implemented this test is red by assertion (no 200 / code 0).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  countOverdueAgentReports,
  isAgentReportOverdue,
} from '../../../../apps/api/src/modules/agent/index.ts';
import {
  fixture,
  newAppId,
  overdueAt,
  reportPage,
  seedBatch,
  suite,
  withReportsAdmin,
  type Fixture,
  type ReportsAdmin,
  type SeededReport,
} from './kit.ts';
import { exported } from './rule.ts';

const s = suite();

/** One instant: the count, the overdue-filtered list and the per-row flags agree. */
async function agreeAt(
  f: Fixture,
  h: ReportsAdmin,
  own: readonly SeededReport[],
  expectedCount: number,
): Promise<void> {
  const now = f.clock.now();
  const at = now.toISOString();
  const count = await countOverdueAgentReports(f.db, f.appId, now);
  expect(count, `count at ${at}`).toBe(expectedCount);

  const filtered = await reportPage(
    await h.reports({ status: 'pending', overdue: 'true', page_size: '200' }),
  );
  expect(filtered.total, `list total (status=pending&overdue=true) at ${at}`).toBe(count);
  expect(filtered.items.map((item) => item['message_id']).sort(), `overdue rows at ${at}`).toEqual(
    overdueAt(own, now)
      .map((row) => row.messageId)
      .sort(),
  );

  const byId = new Map(own.map((row) => [row.messageId, row]));
  const reported = own.filter((row) => row.status !== null);
  const all = await reportPage(await h.reports({ page_size: '200' }));
  expect(all.total, `all reports of the app at ${at}`).toBe(reported.length);
  expect(all.items).toHaveLength(reported.length);
  for (const item of all.items) {
    const id = String(item['message_id']);
    const seeded = byId.get(id);
    expect(seeded, `listed row ${id} is one of the app's reports`).toBeDefined();
    if (seeded === undefined) continue;
    const judged = isAgentReportOverdue(
      { reportStatus: seeded.status, reportedAt: seeded.reportedAt },
      now,
    );
    expect(item['report_status'], seeded.label).toBe(seeded.status);
    expect(item['overdue'], `${seeded.label}: list overdue = isAgentReportOverdue at ${at}`).toBe(
      judged,
    );
  }
  expect(
    all.items.filter((item) => item['overdue'] === true),
    `rows flagged overdue at ${at}`,
  ).toHaveLength(count);
}

it('[AC-B1-10u#8][BR-ID-15] 计数 = 列表页：同一批夹具、同一个注入时钟下，countOverdueAgentReports 等于后台举报列表（持 agent.trace）status=pending&overdue=true 的 total 且是同一批消息；列表每行 overdue 与 isAgentReportOverdue 一致；时钟前进 1 毫秒后差 1 毫秒的那条一起变为超时，两边仍相等', async () => {
  exported();
  const f = fixture(s);
  const batch = await seedBatch(f, newAppId());
  await withReportsAdmin(f, async (h) => {
    await agreeAt(f, h, batch.own, 3);
    f.clock.advanceMs(1);
    await agreeAt(f, h, batch.own, 4);
  });
});
