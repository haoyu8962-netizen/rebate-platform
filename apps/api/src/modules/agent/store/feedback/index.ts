// B3-08zf · the user's writes of 👍/👎 and reports on app.agent_messages (setAgentMessageFeedback,
// reportAgentMessage of contracts/openapi.yaml; BR-AI-19, BR-AI-20, BR-ID-15 ④). agent is the only
// writer of these columns; the report state moves only through the generated transitionAgentReport
// (specs/state-machines/agent-report.yaml). The admin side of a report is
// ../../application/agent-report.ts.
//
// Both writes reach only an assistant message of a session the owner owns (../owner.ts, the Owner
// rule of ../index.ts): a missing message, one of somebody else's session, a user message or an id
// that is not a UUID all answer false and write nothing (never told apart, BR-AI-20). Neither write
// touches agent_sessions or agent_runs (a feedback is not activity of the session).
//
// feedback(owner, messageId, value, at): feedback = value, feedback_at = at; down sets badcase
//   (BR-AI-19); up leaves badcase as it is (08 does not say whether a later up clears it).
// report(owner, messageId, reason, at): a first report (report_status null → REPORT → pending)
//   writes reported, report_reason, reported_at = at and report_status; a repeated report (pending,
//   or handled by an admin) is not a transition and is answered true without a write: the first
//   reason, time and status stay (idempotent; a handled report is never reopened).
// Every write moves row_version and updated_at (the admin port's compare-and-set sees it).
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the caller (`at`).
import type { DB } from '@couli/db';
import { transitionAgentReport } from '@couli/domain';
import type { Kysely } from 'kysely';
import { isUuid, type AgentOwner } from '../index.ts';
import { ownerSessions } from '../owner.ts';

export type AgentFeedbackValue = 'up' | 'down';

export interface AgentMessageFeedbackStore {
  /** false: not an assistant message of one of the owner's sessions (nothing written). */
  feedback(
    owner: AgentOwner,
    messageId: string,
    value: AgentFeedbackValue,
    at: Date,
  ): Promise<boolean>;
  /** false: not an assistant message of one of the owner's sessions (nothing written). */
  report(owner: AgentOwner, messageId: string, reason: string, at: Date): Promise<boolean>;
}

export function createPgAgentMessageFeedbackStore(deps: {
  readonly db: Kysely<DB>;
}): AgentMessageFeedbackStore {
  const db = deps.db.withSchema('app');
  return {
    async feedback(owner, messageId, value, at) {
      if (!isUuid(messageId)) return false;
      const updated = await db
        .updateTable('agent_messages')
        .set((eb) => ({
          feedback: value,
          feedback_at: at,
          badcase: value === 'down' ? true : eb.ref('badcase'),
          row_version: eb('row_version', '+', 1),
          updated_at: at,
        }))
        .where('app_id', '=', owner.appId)
        .where('id', '=', messageId)
        .where('role', '=', 'assistant')
        .where('session_id', 'in', ownerSessions(db, owner).select('id'))
        .returning('id')
        .executeTakeFirst();
      return updated !== undefined;
    },
    async report(owner, messageId, reason, at) {
      if (!isUuid(messageId)) return false;
      return db.transaction().execute(async (tx) => {
        // The row lock serializes concurrent first reports: the second one sees pending.
        const row = await tx
          .selectFrom('agent_messages')
          .select('report_status')
          .where('app_id', '=', owner.appId)
          .where('id', '=', messageId)
          .where('role', '=', 'assistant')
          .where('session_id', 'in', ownerSessions(tx, owner).select('id'))
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return false;
        const step = transitionAgentReport(reportState(row.report_status), 'REPORT');
        // Not a transition (already pending or handled): idempotent success, nothing written.
        if (!step.ok) return true;
        await tx
          .updateTable('agent_messages')
          .set((eb) => ({
            reported: true,
            report_reason: reason,
            reported_at: at,
            report_status: step.to,
            row_version: eb('row_version', '+', 1),
            updated_at: at,
          }))
          .where('app_id', '=', owner.appId)
          .where('id', '=', messageId)
          .where('report_status', 'is', null)
          .execute();
        return true;
      });
    },
  };
}

/** report_status as the state machine's state (the column's check allows pending / handled). */
export function reportState(value: string | null): 'pending' | 'handled' | null {
  if (value === null) return null;
  if (value === 'pending' || value === 'handled') return value;
  throw new Error('Unknown agent report status');
}
