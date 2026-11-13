// The Agent conversations section of a personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」
// 「未过期的 Agent 对话」, BR-ID-30 ①; task B1-27f), for identity's PersonalDataCopySources (assembled
// by app.module).
// createPersonalDataCopyAgentReader({ clock })(handle, subject, { retentionDays }?) — the retention
// comes resolved from the caller (app.module reads agent.trace.retention_days and resolves it with
// agentTraceRetentionDays); this reader never takes a config port nor hands its handle out. The
// user's sessions in the app
// (agent_sessions.user_id = the user; a guest session of the same device, user_id NULL, is not the
// user's) that are not yet past the retention of BR-ID-30 ① (190 days, agent.trace.retention_days
// default) at clock.now(), each with its messages oldest first (role, text, created_at; B3-08zh:
// ordered as the history of listAgentSessionMessages — created_at, then the run, then the user
// message before the assistant reply of the same turn even when the reply's id is smaller, then
// id). A session
// that BR-AI-20 calls expired (24 hours idle, or expired_at passed) is still within the retention
// and is included. Nothing of the console's report handling (handler, note) or of another person.
// Plain SELECTs on the caller's handle (a READ ONLY transaction included): no locking clause, no
// writes, no logging; time only from options.clock.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PersonalDataCopyAgentSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface PersonalDataCopyAgentMessageRow {
  readonly role: 'user' | 'assistant';
  readonly text: string | null;
  readonly created_at: Date;
}

export interface PersonalDataCopyAgentConversationRow {
  readonly session_id: string;
  readonly started_at: Date;
  readonly last_active_at: Date;
  readonly messages: readonly PersonalDataCopyAgentMessageRow[];
}

export interface PersonalDataCopyAgentReadOptions {
  /**
   * The app's retention in days, already resolved by the caller from agent.trace.retention_days
   * with agentTraceRetentionDays (BR-ID-30 ①). Absent: the 08 default.
   */
  readonly retentionDays?: number;
}

export type PersonalDataCopyAgentRead = (
  handle: Kysely<DB>,
  subject: PersonalDataCopyAgentSubject,
  read?: PersonalDataCopyAgentReadOptions,
) => Promise<readonly PersonalDataCopyAgentConversationRow[]>;

export interface PersonalDataCopyAgentOptions {
  readonly clock: Clock;
}

/** BR-ID-30 ①: the configuration key of the Agent trace retention. */
export function agentTraceRetentionKey(): 'agent.trace.retention_days' {
  return 'agent.trace.retention_days';
}

/** BR-ID-30 ① 默认 agent.trace.retention_days. */
function defaultRetentionDays(): number {
  return 190;
}

/** BR-ID-30 ①「后台不得设为小于 184 天」: a smaller value is not a valid setting. */
function minRetentionDays(): number {
  return 184;
}

/**
 * The retention in days from the raw agent.trace.retention_days value (config_items JSON, or
 * null / undefined when unset): an integer of at least the console's floor, else the 08 default.
 * Pure; the composition root reads the value on the caller's handle and passes the result in.
 */
export function agentTraceRetentionDays(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minRetentionDays()
    ? value
    : defaultRetentionDays();
}

export function createPersonalDataCopyAgentReader(
  options: PersonalDataCopyAgentOptions,
): PersonalDataCopyAgentRead {
  const { clock } = options;
  return async (handle, subject, read) => {
    const days = agentTraceRetentionDays(read?.retentionDays);
    // Not yet past the retention: the session was last active within the last `days` days of
    // clock.now() (bound as a parameter; never the SQL clock).
    const cutoff = sql<Date>`${clock.now()}::timestamptz - make_interval(days => ${days})`;
    const app = handle.withSchema('app');
    const sessions = await app
      .selectFrom('agent_sessions')
      .select(['id', 'started_at', 'last_active_at'])
      .where('app_id', '=', subject.appId)
      .where('user_id', '=', subject.userId)
      .where('last_active_at', '>=', cutoff)
      .orderBy('started_at')
      .orderBy('id')
      .execute();
    if (sessions.length === 0) return [];
    // Only role, text and time: feedback and the console's report handling stay out.
    const messages = await app
      .selectFrom('agent_messages')
      .select(['session_id', 'role', 'text', 'created_at'])
      .where('app_id', '=', subject.appId)
      .where(
        'session_id',
        'in',
        sessions.map((session) => session.id),
      )
      .orderBy('created_at')
      .orderBy(sql`COALESCE(run_id, id)`)
      // B3-08zh ([AC-B3-08zd#7]): a turn's two rows share created_at; the user's comes first.
      .orderBy(sql`role = 'assistant'`)
      .orderBy('id')
      .execute();
    const bySession = new Map<string, PersonalDataCopyAgentMessageRow[]>();
    for (const message of messages) {
      // agent_messages_role_check; anything else is a broken database.
      if (message.role !== 'user' && message.role !== 'assistant') {
        throw new Error('agent: unknown message role');
      }
      const list = bySession.get(message.session_id) ?? [];
      list.push({ role: message.role, text: message.text, created_at: message.created_at });
      bySession.set(message.session_id, list);
    }
    return sessions.map((session) => ({
      session_id: session.id,
      started_at: session.started_at,
      last_active_at: session.last_active_at,
      messages: bySession.get(session.id) ?? [],
    }));
  };
}
