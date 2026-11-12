// B1-10u (D10-1382 ②, D10-1399 (a); 08 BR-ID-15 ④): the one "is this AI reply report overdue"
// rule and the per-app count of overdue reports, shared by the report list's `overdue`
// (adminListAgentReports, B1-10t) and the workbench card agent_report_overdue. Overdue = still
// pending (report_status = pending) and now ≥ reported_at + 48 hours; handled or never reported is
// never overdue. Time comes only from the caller's `now` (the injected Clock).
//
// Skeleton (test phase): every function throws NotImplemented.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The two agent_messages report columns the rule reads. */
export interface AgentReportOverdueInput {
  readonly reportStatus: string | null;
  readonly reportedAt: Date | null;
}

/** Pending and now ≥ reportedAt + 48 hours; handled or not reported → false. */
export function isAgentReportOverdue(report: AgentReportOverdueInput, now: Date): boolean {
  void report;
  void now;
  throw new Error('NotImplemented: isAgentReportOverdue');
}

/** The number of `appId`'s reports still pending and overdue at `now` (read only). */
export function countOverdueAgentReports(
  db: Kysely<DB>,
  appId: string,
  now: Date,
): Promise<number> {
  void db;
  void appId;
  void now;
  throw new Error('NotImplemented: countOverdueAgentReports');
}
