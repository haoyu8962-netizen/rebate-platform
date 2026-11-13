// B1-10t: the use case behind adminHandleAgentReport (POST /admin/v1/agent-traces/reports/
// {message_id}/handle), CT-24zzi, 编排 D10-1287 ⑤ / D10-1310 / D10-1539; 08 BR-ID-15 ④ 与细则
// 「举报的处理」(处理人标记已处理并填写处理说明，写审计；超时后照样可处理).
// admin owns the transaction (BR-AI-02 ③: agent never hands its handle to another module; here
// agent is the side that receives admin's): in one transaction it checks the note (trimmed,
// 1–500 characters), reads the report row locked through agent's readAgentReport, calls agent's
// handleAgentReport (the only write of agent_messages' report columns, through
// transitionAgentReport), reads the row back, appends the agent_report_handle audit record with
// admin's own writer bound to the same transaction (target agent_messages:<message_id>; status,
// note and row_version before and after, never the message text) and answers the row in the
// list's shape (agent's agentReportView: the overdue rule stays in agent). A refusal throws before
// anything is written: the transaction rolls back and no audit record exists.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  agentReportView,
  handleAgentReport,
  handlerIds,
  readAgentReport,
  type AdminAgentReport,
} from '../../agent/index.ts';
import type { AuditPort, Clock } from '../../platform/index.ts';
import type { AdminDisplayNameReader } from '../infra/admin-display-names.ts';

/** contracts/openapi.yaml AdminAgentReportHandleRequest.note: 1–500 characters once trimmed. */
export const AGENT_REPORT_NOTE_MAX = 500;
/** The audit action of a handled report (B1-10s: target agent_messages:<message_id>). */
export const AGENT_REPORT_HANDLE_ACTION = 'agent_report_handle';

/** One handling by an operator (the body as the route schema leaves it). */
export interface AgentReportHandleInput {
  readonly appId: string;
  readonly adminId: string;
  readonly messageId: string;
  readonly note: string;
  readonly expectedRowVersion: number;
  readonly ip: string | null;
}

export interface AgentReportHandleDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** admin's audit writer bound to the handling's transaction (createAuditWriter). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** admin's display name reader over the handling's transaction. */
  readonly namesOn: (trx: Transaction<DB>) => AdminDisplayNameReader;
}

export interface AgentReportHandler {
  handle(input: AgentReportHandleInput): Promise<AdminAgentReport>;
}

/** A refusal (20001 data.fields). */
export class AgentReportFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('admin: agent report handling refused');
    this.name = 'AgentReportFieldsError';
    this.fields = fields;
  }
}

/** 20902 data.resource=agent_report: already handled, or row_version moved on. */
export class AgentReportConflictError extends Error {
  constructor() {
    super('admin: the agent report changed');
    this.name = 'AgentReportConflictError';
  }
}

/** The note as stored: trimmed, then 1–500 characters (else 20001 [note]). */
export function agentReportNote(note: string): string {
  const trimmed = note.trim();
  const length = [...trimmed].length;
  if (length === 0 || length > AGENT_REPORT_NOTE_MAX) throw new AgentReportFieldsError(['note']);
  return trimmed;
}

export function createAgentReportHandler(deps: AgentReportHandleDeps): AgentReportHandler {
  return { handle: (input) => handleAgentReportAsAdmin(deps, input) };
}

/**
 * Pending → handled in one transaction, then the row as the list shows it. Unknown, another app's,
 * a user message or never reported → AgentReportFieldsError([message_id]) (one answer for all);
 * already handled or another row_version → AgentReportConflictError. Refusals write nothing.
 */
export async function handleAgentReportAsAdmin(
  deps: AgentReportHandleDeps,
  input: AgentReportHandleInput,
): Promise<AdminAgentReport> {
  const note = agentReportNote(input.note);
  return deps.db.transaction().execute(async (trx) => {
    // The values before, for the audit record (locked: agent's compare-and-set sees the same row).
    const before = await readAgentReport(trx, input.appId, input.messageId, { forUpdate: true });
    const result = await handleAgentReport(trx, deps.clock, {
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
        throw new AgentReportFieldsError(['message_id']);
      case 'already_handled':
      case 'cas_conflict':
        throw new AgentReportConflictError();
    }
    const after = await readAgentReport(trx, input.appId, input.messageId);
    if (before === null || after === null) {
      throw new Error('admin: a handled agent report could not be read back');
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
    const names = await deps.namesOn(trx).displayNames(input.appId, handlerIds([after]));
    return agentReportView(after, names, deps.clock.now());
  });
}
