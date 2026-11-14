// B1-10t: the use case behind adminListAgentReports (GET /admin/v1/agent-traces/reports), CT-24zzi,
// 编排 D10-1287 ⑤ / D10-1310; 08 BR-ID-15 ④ 与细则「举报的处理」(举报列表在后台「AI 助手记录」页，
// 处理人查看对话、标记已处理并填写处理说明，写审计；48 小时时限从举报提交起算，超时告警),
// BR-AI-19 (后台查看 trace 需要权限点 agent.trace).
// The list reads the app's reported assistant replies (store/admin-reports) and writes nothing;
// deadline_at = reported_at + 48 hours, overdue = pending and now ≥ deadline_at, and the overdue
// filter's cutoff all come from report-overdue.ts (B1-10u: the one place this rule is written,
// shared with the workbench card's count). The handlers' display
// names come from a reader app.module has already bound to the pool (admin's): agent never hands
// it a database handle (BR-AI-02 ③).
// The handling (adminHandleAgentReport) is admin's (编排 D10-1539): admin opens the transaction
// and calls, through agent/index.ts, handleAgentReport (application/agent-report.ts: the only write
// of the report columns), readAgentReport and agentReportView below, then writes its own audit
// record in the same transaction. No message text is ever selected or returned.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { traceRangeEmpty } from '../store/admin-traces/index.ts';
import {
  listReports,
  readReport,
  type ReportFilter,
  type ReportRecord,
  type ReportStatus,
} from '../store/admin-reports/index.ts';
import { isUuid } from '../store/index.ts';
import { isAgentReportOverdue, overdueCutoff, reportDeadline } from './report-overdue.ts';

export type { ReportRecord, ReportStatus } from '../store/admin-reports/index.ts';

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

export type AdminAgentReport = Schema<'AdminAgentReport'>;
export type AdminAgentReportPage = Schema<'AdminAgentReportPage'>;

/** The list query as the route schema leaves it (all optional, types coerced). */
export interface AdminReportQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly status?: ReportStatus;
  readonly overdue?: boolean;
  /** reported_at, inclusive. */
  readonly from?: string;
  /** reported_at, exclusive. */
  readonly to?: string;
}

/** admin's display names, bound to the pool by app.module (admin's createAdminDisplayNameReader). */
export interface AdminDisplayNames {
  displayNames(appId: string, adminIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface AdminReportDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** The handlers' display names (already bound to the pool; called with ids only). */
  readonly names: AdminDisplayNames;
}

/** The list the admin controller calls, with the database closed over here. */
export interface AdminReportService {
  list(appId: string, query: AdminReportQuery): Promise<AdminAgentReportPage>;
}

export function createAdminReportService(deps: AdminReportDeps): AdminReportService {
  return {
    list: (appId, query) => listAgentReports(deps, appId, query),
  };
}

/** A refusal (20001 data.fields), thrown for the controller. */
export class AdminReportFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('agent: admin report request refused');
    this.name = 'AdminReportFieldsError';
    this.fields = fields;
  }
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

/**
 * A report row in the contract's AdminAgentReport shape (the list's items and the handling's
 * answer): `names` maps handler ids to display names, `now` decides overdue.
 */
export function agentReportView(
  record: ReportRecord,
  names: ReadonlyMap<string, string>,
  now: Date,
): AdminAgentReport {
  return {
    message_id: record.messageId,
    session_id: record.sessionId,
    user_id: record.userId,
    reported_at: record.reportedAt.toISOString(),
    report_reason: record.reportReason,
    report_status: record.reportStatus,
    deadline_at: reportDeadline(record.reportedAt).toISOString(),
    overdue: isAgentReportOverdue(record, now),
    handled_at: iso(record.handledAt),
    handler_id: record.handlerId,
    handler_name: record.handlerId === null ? null : (names.get(record.handlerId) ?? null),
    report_note: record.reportNote,
    row_version: record.rowVersion,
  };
}

/** The handler ids of `records` (for the display name read). */
export function handlerIds(records: readonly ReportRecord[]): string[] {
  const ids: string[] = [];
  for (const record of records) if (record.handlerId !== null) ids.push(record.handlerId);
  return ids;
}

/** One page of the app's reports: pending by reported_at ascending, then handled by handled_at descending. */
export async function listAgentReports(
  deps: AdminReportDeps,
  appId: string,
  query: AdminReportQuery,
): Promise<AdminAgentReportPage> {
  const { from, to } = query;
  if (from !== undefined && to !== undefined && (await traceRangeEmpty(deps.db, from, to))) {
    throw new AdminReportFieldsError(['from', 'to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const now = deps.clock.now();
  const filter: ReportFilter = {
    appId,
    overdueCutoff: overdueCutoff(now),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.overdue === undefined ? {} : { overdue: query.overdue }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
  const { rows, total } = await listReports(deps.db, filter, page, pageSize);
  const names = await deps.names.displayNames(appId, handlerIds(rows));
  return {
    items: rows.map((row) => agentReportView(row, names, now)),
    page,
    page_size: pageSize,
    total,
  };
}

/**
 * One reported assistant reply of the app, read in `db` (admin's handling transaction; forUpdate
 * locks the row): null for an unknown id, another app's message, a user message or a message never
 * reported (a malformed id included: nothing is queried then).
 */
export async function readAgentReport(
  db: Kysely<DB>,
  appId: string,
  messageId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ReportRecord | null> {
  if (!isUuid(messageId)) return null;
  return readReport(db, appId, messageId, options);
}
