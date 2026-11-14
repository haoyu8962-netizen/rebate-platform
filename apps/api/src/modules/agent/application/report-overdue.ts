// B1-10u (D10-1382 ②, D10-1399 (a); 08 BR-ID-15 ④): the one "is this AI reply report overdue"
// rule and the per-app count of overdue reports, shared by the report list's `overdue`
// (adminListAgentReports, B1-10t) and the workbench card agent_report_overdue. Overdue = still
// pending (report_status = pending) and now ≥ reported_at + 48 hours; handled or never reported is
// never overdue. Time comes only from the caller's `now` (the injected Clock).
// The count runs the list's own query (store/admin-reports, status=pending&overdue=true), so it
// equals that list's total; it reads only, in agent's own function (no handle is handed on).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { countReports } from '../store/admin-reports/index.ts';

/** BR-ID-15 ④: a report is handled within 48 hours of its submission. */
export const REPORT_DEADLINE_MS = 48 * 3_600_000;

/** The two agent_messages report columns the rule reads. */
export interface AgentReportOverdueInput {
  readonly reportStatus: string | null;
  readonly reportedAt: Date | null;
}

/** `instant` moved by `ms` as a new Date (the input is never modified, no wall clock read). */
function shiftMs(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/** BR-ID-15: the instant by which the report must be handled (reported_at + 48 hours). */
export function reportDeadline(reportedAt: Date): Date {
  return shiftMs(reportedAt, REPORT_DEADLINE_MS);
}

/** The latest reported_at that is overdue at `now` (now − 48 hours; the query form of the rule). */
export function overdueCutoff(now: Date): Date {
  return shiftMs(now, -REPORT_DEADLINE_MS);
}

/** Pending and now ≥ reportedAt + 48 hours (exactly at the deadline counts); else false. */
export function isAgentReportOverdue(report: AgentReportOverdueInput, now: Date): boolean {
  const { reportStatus, reportedAt } = report;
  if (reportStatus !== 'pending' || reportedAt === null) return false;
  return now.getTime() >= reportDeadline(reportedAt).getTime();
}

/** The number of `appId`'s reports still pending and overdue at `now` (read only). */
export function countOverdueAgentReports(
  db: Kysely<DB>,
  appId: string,
  now: Date,
): Promise<number> {
  return countReports(db, {
    appId,
    status: 'pending',
    overdue: true,
    overdueCutoff: overdueCutoff(now),
  });
}
