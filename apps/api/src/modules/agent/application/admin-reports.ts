// B1-10t: the use cases behind adminListAgentReports (GET /admin/v1/agent-traces/reports) and
// adminHandleAgentReport (POST /admin/v1/agent-traces/reports/{message_id}/handle), CT-24zzi,
// 编排 D10-1287 ⑤ / D10-1310; 08 BR-ID-15 ④ 与细则「举报的处理」(举报列表在后台「AI 助手记录」页，
// 处理人查看对话、标记已处理并填写处理说明，写审计；48 小时时限从举报提交起算，超时告警),
// BR-AI-19 (后台查看 trace 需要权限点 agent.trace).
// The list reads the app's reported assistant replies (store/admin-reports) and writes nothing;
// deadline_at = reported_at + 48 hours, overdue = pending and now ≥ deadline_at (reportOverdue,
// the one place this rule is written; B1-10u moves it to a shared home). Handling runs in one
// transaction: the note check, agent's report port (application/agent-report.ts: the only write
// of the report columns, through transitionAgentReport), the row read back and the
// agent_report_handle audit record (admin's writer bound to the same transaction); a refusal
// writes nothing. No message text is ever selected, returned or audited.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock } from '../../platform/index.ts';
import { traceRangeEmpty } from '../store/admin-traces/index.ts';
import {
  listReports,
  readReport,
  type ReportFilter,
  type ReportRecord,
  type ReportStatus,
} from '../store/admin-reports/index.ts';
import { isUuid } from '../store/index.ts';
import type { AgentReportAdminPort } from './agent-report.ts';

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
/** BR-ID-15 ④: a report is handled within 48 hours of its submission. */
export const REPORT_DEADLINE_MS = 48 * 3_600_000;
/** contracts/openapi.yaml AdminAgentReportHandleRequest.note: 1–500 characters once trimmed. */
const NOTE_MAX = 500;
/** The audit action of a handled report (B1-10s: target agent_messages:<message_id>). */
export const AGENT_REPORT_HANDLE_ACTION = 'agent_report_handle';

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

/** One handling by an operator (the body as the route schema leaves it). */
export interface AdminReportHandle {
  readonly appId: string;
  readonly adminId: string;
  readonly messageId: string;
  readonly note: string;
  readonly expectedRowVersion: number;
  readonly ip: string | null;
}

/** admin's display names (app.module: admin's createAdminDisplayNameReader). */
export interface AdminDisplayNames {
  displayNames(appId: string, adminIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface AdminReportDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** agent's report port (createAgentReportAdminPort). */
  readonly reports: AgentReportAdminPort;
  /** Binds the audit port to the handling's transaction (admin's createAuditWriter). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** admin's display name reader over a handle (the pool or the transaction). */
  readonly adminNames: (db: Kysely<DB>) => AdminDisplayNames;
}

/** The two use cases the admin controller calls, with the database closed over here. */
export interface AdminReportService {
  list(appId: string, query: AdminReportQuery): Promise<AdminAgentReportPage>;
  handle(input: AdminReportHandle): Promise<AdminAgentReport>;
}

export function createAdminReportService(deps: AdminReportDeps): AdminReportService {
  return {
    list: (appId, query) => listAgentReports(deps, appId, query),
    handle: (input) => handleAgentReportAsAdmin(deps, input),
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

/** 20902 data.resource=agent_report: already handled, or row_version moved on. */
export class AdminReportConflictError extends Error {
  constructor() {
    super('agent: the report changed');
    this.name = 'AdminReportConflictError';
  }
}

/** `instant` moved by `ms` as a new Date (the input is never modified, no wall clock read). */
function shiftMs(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/** BR-ID-15: the instant by which the report must be handled. */
export function reportDeadline(reportedAt: Date): Date {
  return shiftMs(reportedAt, REPORT_DEADLINE_MS);
}

/** BR-ID-15: pending and now ≥ reported_at + 48 hours (exactly at the deadline counts). */
export function reportOverdue(status: ReportStatus, reportedAt: Date, now: Date): boolean {
  return status === 'pending' && now.getTime() >= reportDeadline(reportedAt).getTime();
}

/** The latest reported_at that is overdue at `now` (the list filter's form of reportOverdue). */
function overdueCutoff(now: Date): Date {
  return shiftMs(now, -REPORT_DEADLINE_MS);
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

function reportRow(
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
    overdue: reportOverdue(record.reportStatus, record.reportedAt, now),
    handled_at: iso(record.handledAt),
    handler_id: record.handlerId,
    handler_name: record.handlerId === null ? null : (names.get(record.handlerId) ?? null),
    report_note: record.reportNote,
    row_version: record.rowVersion,
  };
}

function handlerIds(records: readonly ReportRecord[]): string[] {
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
  const names = await deps.adminNames(deps.db).displayNames(appId, handlerIds(rows));
  return { items: rows.map((row) => reportRow(row, names, now)), page, page_size: pageSize, total };
}

/** The note as stored: trimmed, then 1–500 characters (else 20001 [note]). */
export function handlingNote(note: string): string {
  const trimmed = note.trim();
  const length = [...trimmed].length;
  if (length === 0 || length > NOTE_MAX) throw new AdminReportFieldsError(['note']);
  return trimmed;
}

/**
 * Pending → handled in one transaction, then the row as the list shows it. Unknown, another app's,
 * a user message or never reported → AdminReportFieldsError([message_id]) (one answer for all);
 * already handled or another row_version → AdminReportConflictError. Refusals write nothing.
 */
export async function handleAgentReportAsAdmin(
  deps: AdminReportDeps,
  input: AdminReportHandle,
): Promise<AdminAgentReport> {
  return deps.db.transaction().execute(async (trx) => {
    const note = handlingNote(input.note);
    // The values before, for the audit record (locked: the port's compare-and-set sees the same row).
    const before = isUuid(input.messageId)
      ? await readReport(trx, input.appId, input.messageId, { forUpdate: true })
      : null;
    const result = await deps.reports.handle(trx, {
      appId: input.appId,
      messageId: input.messageId,
      handlerId: input.adminId,
      note,
      expectedRowVersion: input.expectedRowVersion,
    });
    switch (result.kind) {
      case 'handled':
        break;
      case 'not_found':
      case 'not_reported':
        throw new AdminReportFieldsError(['message_id']);
      case 'already_handled':
      case 'cas_conflict':
        throw new AdminReportConflictError();
    }
    const after = await readReport(trx, input.appId, input.messageId);
    if (before === null || after === null) {
      throw new Error('agent: a handled report could not be read back');
    }
    // BR-ID-15 ④: the handling is audited — status and note, never the message text.
    await deps.auditOn(trx).append({
      appId: input.appId,
      actor: input.adminId,
      action: AGENT_REPORT_HANDLE_ACTION,
      target: `agent_messages:${after.messageId}`,
      before: {
        report_status: before.reportStatus,
        report_note: before.reportNote,
        row_version: before.rowVersion,
      },
      after: {
        report_status: after.reportStatus,
        report_note: after.reportNote,
        row_version: after.rowVersion,
      },
      ip: input.ip,
    });
    const names = await deps.adminNames(trx).displayNames(input.appId, handlerIds([after]));
    return reportRow(after, names, deps.clock.now());
  });
}
