// B1-10q: the read-only queries behind the admin trace console (adminListAgentSessions,
// adminGetAgentSession; CT-24zzi, 编排 D10-1310). Reads app.agent_sessions, agent_runs,
// agent_messages, agent_tool_calls and agent_cards of one app and writes nothing. Every query is
// scoped by app_id (a session of another app is never seen). Only the columns the contract shows
// are selected: never device_id, user_hash, app_id or agent_runs.user_text.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';

/** A jsonb value as the driver returns it. */
type Json = DB['agent_cards']['data'];
import { sql, type Kysely } from 'kysely';

/** The list filters as the use case hands them over (ids already checked to be UUIDs). */
export interface TraceSessionFilter {
  readonly appId: string;
  readonly userId?: string;
  readonly sessionId?: string;
  /** started_at, inclusive (ISO 8601 with offset, checked by the route schema). */
  readonly from?: string;
  /** started_at, exclusive. */
  readonly to?: string;
  readonly badcase?: boolean;
  readonly reported?: boolean;
}

export interface TraceSessionRecord {
  readonly id: string;
  readonly userId: string | null;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly expiredAt: Date | null;
}

export interface TraceSessionCountsRecord extends TraceSessionRecord {
  readonly runCount: number;
  readonly badcaseCount: number;
  readonly reportCount: number;
}

export interface TraceMessageRecord {
  readonly id: string;
  readonly role: string;
  readonly text: string | null;
  readonly cardIds: readonly string[];
  readonly feedback: string | null;
  readonly badcase: boolean;
  readonly reportedAt: Date | null;
  readonly reportReason: string | null;
  readonly reportStatus: string | null;
  readonly reportNote: string | null;
}

export interface TraceRunRecord {
  readonly id: string;
  readonly intent: string | null;
  readonly model: string | null;
  readonly modelSnapshot: string | null;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMfen: bigint | null;
  readonly ttftMs: number | null;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly filterHits: readonly string[];
  readonly acceptedAt: Date;
  readonly endedAt: Date | null;
}

export interface TraceToolCallRecord {
  readonly runId: string;
  readonly seq: number;
  readonly name: string;
  readonly args: Json | null;
  readonly status: string;
  readonly latencyMs: number | null;
}

export interface TraceCardRecord {
  readonly cardId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: Json;
  readonly fallbackText: string;
}

export interface TraceSessionDetailRecord {
  readonly session: TraceSessionRecord;
  readonly messages: readonly TraceMessageRecord[];
  readonly runs: readonly TraceRunRecord[];
  readonly toolCalls: readonly TraceToolCallRecord[];
  readonly cards: readonly TraceCardRecord[];
}

function app(db: Kysely<DB>) {
  return db.withSchema('app');
}

/** The sessions of the app matching the filter (a base for the page and for the count). */
function filteredSessions(db: Kysely<DB>, filter: TraceSessionFilter) {
  let query = app(db).selectFrom('agent_sessions as s').where('s.app_id', '=', filter.appId);
  if (filter.userId !== undefined) query = query.where('s.user_id', '=', filter.userId);
  if (filter.sessionId !== undefined) query = query.where('s.id', '=', filter.sessionId);
  if (filter.from !== undefined) {
    query = query.where('s.started_at', '>=', sql<Date>`${filter.from}::timestamptz`);
  }
  if (filter.to !== undefined) {
    query = query.where('s.started_at', '<', sql<Date>`${filter.to}::timestamptz`);
  }
  if (filter.badcase !== undefined) {
    const wanted = filter.badcase;
    query = query.where(({ exists, not, selectFrom }) => {
      const marked = exists(
        selectFrom('agent_messages as m')
          .select(sql`1`.as('one'))
          .whereRef('m.app_id', '=', 's.app_id')
          .whereRef('m.session_id', '=', 's.id')
          .where('m.role', '=', 'assistant')
          .where('m.badcase', '=', true),
      );
      return wanted ? marked : not(marked);
    });
  }
  if (filter.reported !== undefined) {
    const wanted = filter.reported;
    query = query.where(({ exists, not, selectFrom }) => {
      const marked = exists(
        selectFrom('agent_messages as m')
          .select(sql`1`.as('one'))
          .whereRef('m.app_id', '=', 's.app_id')
          .whereRef('m.session_id', '=', 's.id')
          .where('m.role', '=', 'assistant')
          .where('m.reported', '=', true),
      );
      return wanted ? marked : not(marked);
    });
  }
  return query;
}

/**
 * `from` not earlier than `to` (equal included). Compared by PostgreSQL on the same casts the
 * filters use, so any date-time the route schema lets through is judged at full precision.
 */
export async function traceRangeEmpty(db: Kysely<DB>, from: string, to: string): Promise<boolean> {
  const { rows } = await sql<{
    empty: boolean;
  }>`SELECT (${from}::timestamptz >= ${to}::timestamptz) AS empty`.execute(db);
  return rows[0]?.empty === true;
}

/** started_at descending, id as the stable second key (pages never repeat or skip a row). */
export async function listTraceSessions(
  db: Kysely<DB>,
  filter: TraceSessionFilter,
  page: number,
  pageSize: number,
): Promise<{ rows: TraceSessionCountsRecord[]; total: number }> {
  const { total } = await filteredSessions(db, filter)
    .select(sql<string>`count(*)`.as('total'))
    .executeTakeFirstOrThrow();
  const rows = await filteredSessions(db, filter)
    .select((eb) => [
      's.id',
      's.user_id',
      's.started_at',
      's.last_active_at',
      's.expired_at',
      eb
        .selectFrom('agent_runs as r')
        .select(sql<string>`count(*)`.as('n'))
        .whereRef('r.app_id', '=', 's.app_id')
        .whereRef('r.session_id', '=', 's.id')
        .as('run_count'),
      eb
        .selectFrom('agent_messages as m')
        .select(sql<string>`count(*)`.as('n'))
        .whereRef('m.app_id', '=', 's.app_id')
        .whereRef('m.session_id', '=', 's.id')
        .where('m.role', '=', 'assistant')
        .where('m.badcase', '=', true)
        .as('badcase_count'),
      eb
        .selectFrom('agent_messages as m')
        .select(sql<string>`count(*)`.as('n'))
        .whereRef('m.app_id', '=', 's.app_id')
        .whereRef('m.session_id', '=', 's.id')
        .where('m.role', '=', 'assistant')
        .where('m.reported', '=', true)
        .as('report_count'),
    ])
    .orderBy('s.started_at', 'desc')
    .orderBy('s.id', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  return {
    total: Number(total),
    rows: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
      expiredAt: row.expired_at,
      runCount: Number(row.run_count ?? 0),
      badcaseCount: Number(row.badcase_count ?? 0),
      reportCount: Number(row.report_count ?? 0),
    })),
  };
}

/** One session of the app with its whole trace in the contract's orders; null when not in the app. */
export async function readTraceSession(
  db: Kysely<DB>,
  appId: string,
  sessionId: string,
): Promise<TraceSessionDetailRecord | null> {
  const session = await app(db)
    .selectFrom('agent_sessions')
    .select(['id', 'user_id', 'started_at', 'last_active_at', 'expired_at'])
    .where('app_id', '=', appId)
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (session === undefined) return null;

  const messages = await app(db)
    .selectFrom('agent_messages')
    .select([
      'id',
      'role',
      'text',
      'card_ids',
      'feedback',
      'badcase',
      'reported_at',
      'report_reason',
      'report_status',
      'report_note',
    ])
    .where('app_id', '=', appId)
    .where('session_id', '=', sessionId)
    // One turn's question and answer are written by one statement with one created_at and two
    // UUIDv7 ids of one millisecond (random rest), so the id alone would put either first: at one
    // instant the user message goes before the assistant message, then id (B1-10r, D10-1341 ②).
    .orderBy('created_at', 'asc')
    .orderBy(sql`(role = 'user')`, 'desc')
    .orderBy('id', 'asc')
    .execute();

  const runs = await app(db)
    .selectFrom('agent_runs')
    .select([
      'id',
      'intent',
      'model',
      'model_snapshot',
      'prompt_version',
      'input_tokens',
      'output_tokens',
      'cost_mfen',
      'ttft_ms',
      'latency_ms',
      'finish_reason',
      'filter_hits',
      'accepted_at',
      'ended_at',
    ])
    .where('app_id', '=', appId)
    .where('session_id', '=', sessionId)
    .orderBy('accepted_at', 'asc')
    .orderBy('id', 'asc')
    .execute();

  // agent_tool_calls has no session_id: by its run, in the run's accepted_at order, then seq.
  const toolCalls = await app(db)
    .selectFrom('agent_tool_calls as t')
    .innerJoin('agent_runs as r', (join) =>
      join.onRef('r.id', '=', 't.run_id').onRef('r.app_id', '=', 't.app_id'),
    )
    .select(['t.run_id', 't.seq', 't.name', 't.args', 't.status', 't.latency_ms'])
    .where('t.app_id', '=', appId)
    .where('r.session_id', '=', sessionId)
    .orderBy('r.accepted_at', 'asc')
    .orderBy('r.id', 'asc')
    .orderBy('t.seq', 'asc')
    .orderBy('t.id', 'asc')
    .execute();

  // Sent order: the card id is the session's card sequence (c1, c2, …) taken when it was sent.
  const cards = await app(db)
    .selectFrom('agent_cards')
    .select(['card_id', 'type', 'schema_version', 'data', 'fallback_text'])
    .where('app_id', '=', appId)
    .where('session_id', '=', sessionId)
    .orderBy(sql`(substring(card_id from 2))::bigint`, 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();

  return {
    session: {
      id: session.id,
      userId: session.user_id,
      startedAt: session.started_at,
      lastActiveAt: session.last_active_at,
      expiredAt: session.expired_at,
    },
    messages: messages.map((row) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      cardIds: row.card_ids,
      feedback: row.feedback,
      badcase: row.badcase,
      reportedAt: row.reported_at,
      reportReason: row.report_reason,
      reportStatus: row.report_status,
      reportNote: row.report_note,
    })),
    runs: runs.map((row) => ({
      id: row.id,
      intent: row.intent,
      model: row.model,
      modelSnapshot: row.model_snapshot,
      promptVersion: row.prompt_version,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costMfen: row.cost_mfen,
      ttftMs: row.ttft_ms,
      latencyMs: row.latency_ms,
      finishReason: row.finish_reason,
      filterHits: row.filter_hits,
      acceptedAt: row.accepted_at,
      endedAt: row.ended_at,
    })),
    toolCalls: toolCalls.map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      name: row.name,
      args: row.args,
      status: row.status,
      latencyMs: row.latency_ms,
    })),
    cards: cards.map((row) => ({
      cardId: row.card_id,
      type: row.type,
      schemaVersion: row.schema_version,
      data: row.data,
      fallbackText: row.fallback_text,
    })),
  };
}
