// B1-10t: the queries behind the admin report list and the report handling (adminListAgentReports,
// adminHandleAgentReport; CT-24zzi, BR-ID-15 细则「举报的处理」). Reads app.agent_messages (the
// reported assistant replies) joined to app.agent_sessions (the session's user) of one app and
// writes nothing: the only write of the report columns is agent's port
// (application/agent-report.ts). Every query is scoped by app_id. Only the columns the contract
// shows are selected: never the message text, device_id, user_hash or app_id.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export type ReportStatus = 'pending' | 'handled';

/** The list filters as the use case hands them over. */
export interface ReportFilter {
  readonly appId: string;
  readonly status?: ReportStatus;
  /** true: pending reports with reported_at ≤ overdueCutoff; false: every other report. */
  readonly overdue?: boolean;
  /** now − 48 hours: a pending report reported at or before this instant is overdue. */
  readonly overdueCutoff: Date;
  /** reported_at, inclusive (ISO 8601 with offset, checked by the route schema). */
  readonly from?: string;
  /** reported_at, exclusive. */
  readonly to?: string;
}

/** One reported assistant reply, as stored. */
export interface ReportRecord {
  readonly messageId: string;
  readonly sessionId: string;
  readonly userId: string | null;
  readonly reportedAt: Date;
  readonly reportReason: string | null;
  readonly reportStatus: ReportStatus;
  readonly handledAt: Date | null;
  readonly handlerId: string | null;
  readonly reportNote: string | null;
  readonly rowVersion: number;
}

function reports(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('agent_messages as m')
    .innerJoin('agent_sessions as s', (join) =>
      join.onRef('s.app_id', '=', 'm.app_id').onRef('s.id', '=', 'm.session_id'),
    )
    .where('m.app_id', '=', appId)
    .where('m.role', '=', 'assistant')
    .where('m.reported', '=', true);
}

function filtered(db: Kysely<DB>, filter: ReportFilter) {
  let query = reports(db, filter.appId);
  if (filter.status !== undefined) query = query.where('m.report_status', '=', filter.status);
  if (filter.overdue !== undefined) {
    const cutoff = filter.overdueCutoff;
    query = filter.overdue
      ? query.where('m.report_status', '=', 'pending').where('m.reported_at', '<=', cutoff)
      : query.where((eb) =>
          eb.or([eb('m.report_status', '<>', 'pending'), eb('m.reported_at', '>', cutoff)]),
        );
  }
  if (filter.from !== undefined) {
    query = query.where('m.reported_at', '>=', sql<Date>`${filter.from}::timestamptz`);
  }
  if (filter.to !== undefined) {
    query = query.where('m.reported_at', '<', sql<Date>`${filter.to}::timestamptz`);
  }
  return query;
}

const COLUMNS = [
  'm.id',
  'm.session_id',
  's.user_id',
  'm.reported_at',
  'm.report_reason',
  'm.report_status',
  'm.report_handled_at',
  'm.report_handler_id',
  'm.report_note',
  'm.row_version',
] as const;

interface ReportRow {
  readonly id: string;
  readonly session_id: string;
  readonly user_id: string | null;
  readonly reported_at: Date | null;
  readonly report_reason: string | null;
  readonly report_status: string | null;
  readonly report_handled_at: Date | null;
  readonly report_handler_id: string | null;
  readonly report_note: string | null;
  readonly row_version: number;
}

function record(row: ReportRow): ReportRecord {
  // reported = true implies reported_at and report_status (agent_messages CHECKs).
  if (row.reported_at === null || row.report_status === null) {
    throw new Error('agent: a reported message without its report columns');
  }
  return {
    messageId: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    reportedAt: row.reported_at,
    reportReason: row.report_reason,
    reportStatus: row.report_status === 'handled' ? 'handled' : 'pending',
    handledAt: row.report_handled_at,
    handlerId: row.report_handler_id,
    reportNote: row.report_note,
    rowVersion: row.row_version,
  };
}

/**
 * Pending first by reported_at ascending, then handled by handled_at descending; the message id
 * as the stable last key (pages never repeat or skip a row).
 */
export async function listReports(
  db: Kysely<DB>,
  filter: ReportFilter,
  page: number,
  pageSize: number,
): Promise<{ rows: ReportRecord[]; total: number }> {
  const { total } = await filtered(db, filter)
    .select(sql<string>`count(*)`.as('total'))
    .executeTakeFirstOrThrow();
  const rows = await filtered(db, filter)
    .select([...COLUMNS])
    .orderBy(sql`(m.report_status = 'pending')`, 'desc')
    .orderBy(sql`CASE WHEN m.report_status = 'pending' THEN m.reported_at END`, 'asc')
    .orderBy(sql`CASE WHEN m.report_status = 'handled' THEN m.report_handled_at END`, 'desc')
    .orderBy('m.id', 'asc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  return { rows: rows.map(record), total: Number(total) };
}

/** One reported reply of the app (null: unknown, another app's, a user message, never reported). */
export async function readReport(
  db: Kysely<DB>,
  appId: string,
  messageId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ReportRecord | null> {
  let query = reports(db, appId)
    .where('m.id', '=', messageId)
    .select([...COLUMNS]);
  // `FOR UPDATE OF m` as raw SQL: kysely 0.29's forUpdate(of) does not compile a table alias.
  if (options.forUpdate === true) query = query.modifyEnd(sql`for update of m`);
  const row = await query.executeTakeFirst();
  return row === undefined ? null : record(row);
}
