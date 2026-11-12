// B1-10u rule-test helpers without a database (claude-independent, SPEC_REF 62b5c993): 08 BR-ID-15 ④
// (举报在 48 小时内处理完毕……超时告警；细则：48 小时时限从举报提交起算) and 编排 D10-1382 ② /
// D10-1399 (a): overdue = report_status pending and now ≥ reported_at + 48 hours; handled or never
// reported is never overdue. The test-side oracle below is written from the rule, not from the code.
import { expect } from 'vitest';
import * as agent from '../../../../apps/api/src/modules/agent/index.ts';

export const HOUR_MS = 3_600_000;
/** BR-ID-15: 48 hours from the report's submission. */
export const DEADLINE_MS = 48 * HOUR_MS;

export type ReportStatus = 'pending' | 'handled' | null;

/** The rule, independently: pending and now ≥ reportedAt + 48 h. */
export function expectedOverdue(status: ReportStatus, reportedAt: Date | null, now: Date): boolean {
  return (
    status === 'pending' &&
    reportedAt !== null &&
    now.getTime() >= reportedAt.getTime() + DEADLINE_MS
  );
}

/** Both shared functions are exported from the agent module's index (red on main: missing). */
export function exported(): void {
  const names = ['isAgentReportOverdue', 'countOverdueAgentReports'] as const;
  const surface = agent as unknown as Record<string, unknown>;
  for (const name of names) {
    expect(typeof surface[name], `${name} from agent/index.ts`).toBe('function');
  }
}
