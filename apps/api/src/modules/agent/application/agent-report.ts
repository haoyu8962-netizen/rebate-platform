// B3-08zf · the admin side of a report on an assistant reply (BR-ID-15 ④ 细则: the handler marks the
// report handled and writes a note; BR-AI-19). The admin module (B1-10t) calls it inside its own
// transaction, after its own checks (permission, the note's length, the audit row it writes in
// the same transaction). agent stays the only writer of agent_messages' report columns.
//
// handleAgentReport(trx, clock, input) — one conditional UPDATE in `trx` (never another connection):
//   the row of input.appId / input.messageId with role 'assistant', report_status 'pending' and
//   row_version = input.expectedRowVersion becomes report_status = transitionAgentReport('pending',
//   'HANDLE').to, report_handler_id = input.handlerId, report_handled_at = clock.now() (read once),
//   report_note = input.note, row_version + 1, updated_at → {kind: 'handled', rowVersion, handledAt}.
//   Nothing is compared in JS before an unconditional write: a concurrent handler or a stale
//   version loses at the UPDATE's WHERE. When no row was written, one read of the same row tells
//   why (nothing written either way): missing, another app's, a user message or not a UUID →
//   not_found; never reported → not_reported; handled → already_handled; pending with another
//   row_version → cas_conflict. The business outcomes are answers, never throws; a database
//   failure propagates (the caller's transaction is then unusable anyway).
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock.
import type { DB } from '@couli/db';
import { transitionAgentReport } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { isUuid } from '../store/index.ts';

export interface HandleAgentReportInput {
  readonly appId: string;
  readonly messageId: string;
  readonly handlerId: string;
  readonly note: string;
  readonly expectedRowVersion: number;
}

export type HandleAgentReportResult =
  | { kind: 'handled'; rowVersion: number; handledAt: string }
  | { kind: 'not_found' | 'not_reported' | 'already_handled' | 'cas_conflict' };

export interface AgentReportAdminPort {
  handle(trx: Transaction<DB>, input: HandleAgentReportInput): Promise<HandleAgentReportResult>;
}

export async function handleAgentReport(
  trx: Transaction<DB>,
  clock: Clock,
  input: HandleAgentReportInput,
): Promise<HandleAgentReportResult> {
  if (!isUuid(input.messageId)) return { kind: 'not_found' };
  if (!Number.isSafeInteger(input.expectedRowVersion)) return { kind: 'cas_conflict' };
  const db = trx.withSchema('app');
  const step = transitionAgentReport('pending', 'HANDLE');
  if (step.ok) {
    const now = clock.now();
    const written = await db
      .updateTable('agent_messages')
      .set((eb) => ({
        report_status: step.to,
        report_handler_id: input.handlerId,
        report_handled_at: now,
        report_note: input.note,
        row_version: eb('row_version', '+', 1),
        updated_at: now,
      }))
      .where('app_id', '=', input.appId)
      .where('id', '=', input.messageId)
      .where('role', '=', 'assistant')
      .where('report_status', '=', 'pending')
      .where('row_version', '=', input.expectedRowVersion)
      .returning('row_version')
      .executeTakeFirst();
    if (written !== undefined) {
      return { kind: 'handled', rowVersion: written.row_version, handledAt: now.toISOString() };
    }
  }
  const row = await db
    .selectFrom('agent_messages')
    .select('report_status')
    .where('app_id', '=', input.appId)
    .where('id', '=', input.messageId)
    .where('role', '=', 'assistant')
    .executeTakeFirst();
  return { kind: refusal(row === undefined ? undefined : row.report_status) };
}

/** Why no row was handled, from the row's report_status (undefined: no such assistant message). */
export function refusal(
  status: string | null | undefined,
): Exclude<HandleAgentReportResult['kind'], 'handled'> {
  if (status === undefined) return 'not_found';
  if (status === null) return 'not_reported';
  if (status === 'pending') return 'cas_conflict';
  return 'already_handled';
}

export function createAgentReportAdminPort(deps: { readonly clock: Clock }): AgentReportAdminPort {
  return {
    handle: (trx, input) => handleAgentReport(trx, deps.clock, input),
  };
}
