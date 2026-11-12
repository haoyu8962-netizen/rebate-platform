// B1-10q: the use cases behind adminListAgentSessions (GET /admin/v1/agent-traces/sessions) and
// adminGetAgentSession (GET /admin/v1/agent-traces/sessions/{session_id}), CT-24zzi, 编排
// D10-1310; 08 BR-AI-19 (后台查看 trace 需要 agent-traces 权限，查看操作记审计), BR-AI-20 (guest
// sessions have no user_id; expired once last_active_at + 24 h ≤ now or expired_at reached),
// BR-AI-22 (after the owner's deletion the free texts are null and the rows kept).
// Read only on the agent tables (store/admin-traces). The list writes nothing; each successful
// detail read appends exactly one agent_trace_view audit record (operator, session) after the
// read, carrying no message text or tool argument; an unknown session, a session of another app
// or a malformed id is the same refusal (20001 [session_id]) and writes none. What is returned is
// always the masked form stored at write time: no pii.* point changes anything, and no device id,
// user_hash, app_id or user_text is ever selected. B1-10r (D10-1341 ②): the one field stored
// whole, a claim_draft card's data.order_no, is masked here on the way out (BR-AI-14).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely } from 'kysely';
import type { AuditPort, Clock } from '../../platform/index.ts';
import { maskForTrace } from '../preprocess/redact/index.ts';
import {
  listTraceSessions,
  readTraceSession,
  traceRangeEmpty,
  type TraceSessionFilter,
  type TraceSessionRecord,
} from '../store/admin-traces/index.ts';

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
/** BR-AI-20: a session expires 24 hours after its last accepted message. */
const SESSION_IDLE_MS = 24 * 3_600_000;
/** The audit action of a detail read (contract adminGetAgentSession, BR-AI-19). */
export const AGENT_TRACE_VIEW_ACTION = 'agent_trace_view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AdminAgentSessionPage = Schema<'AdminAgentSessionPage'>;
export type AdminAgentSessionDetail = Schema<'AdminAgentSessionDetail'>;
type Item = Schema<'AdminAgentSessionListItem'>;
type Message = Schema<'AdminAgentTraceMessage'>;
type Run = Schema<'AdminAgentTraceRun'>;
type ToolCall = Schema<'AdminAgentTraceToolCall'>;
type Card = Schema<'AgentHistoryCard'>;

/** The list query as the route schema leaves it (all optional, types coerced). */
export interface AdminTraceSessionQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly user_id?: string;
  readonly session_id?: string;
  /** started_at, inclusive. */
  readonly from?: string;
  /** started_at, exclusive. */
  readonly to?: string;
  readonly badcase?: boolean;
  readonly reported?: boolean;
}

/** One session read by an operator (the read writes the agent_trace_view audit record). */
export interface AdminTraceSessionRead {
  readonly appId: string;
  readonly sessionId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminTraceDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

export interface AdminTraceReadDeps extends AdminTraceDeps {
  readonly audit: AuditPort;
}

/**
 * The two reads the admin controller calls, with the database closed over here in agent's own
 * code (B3-08k, BR-AI-02 ③): the controller holds only these functions, never the handle.
 */
export interface AdminTraceReaders {
  list(appId: string, query: AdminTraceSessionQuery): Promise<AdminAgentSessionPage>;
  detail(read: AdminTraceSessionRead): Promise<AdminAgentSessionDetail>;
}

export function createAdminTraceReaders(deps: AdminTraceReadDeps): AdminTraceReaders {
  return {
    list: (appId, query) => listAgentTraceSessions(deps, appId, query),
    detail: (read) => getAgentTraceSession(deps, read),
  };
}

/** A refusal (20001 data.fields), thrown for the controller. */
export class AdminTraceFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('agent: admin trace request refused');
    this.name = 'AdminTraceFieldsError';
    this.fields = fields;
  }
}

/** BR-AI-20: expired_at reached, or last_active_at + 24 hours ≤ now. */
export function traceSessionExpired(session: TraceSessionRecord, now: Date): boolean {
  const at = now.getTime();
  if (session.expiredAt !== null && session.expiredAt.getTime() <= at) return true;
  return session.lastActiveAt.getTime() + SESSION_IDLE_MS <= at;
}

function header(session: TraceSessionRecord, now: Date) {
  return {
    session_id: session.id,
    user_id: session.userId,
    started_at: session.startedAt.toISOString(),
    last_active_at: session.lastActiveAt.toISOString(),
    expired: traceSessionExpired(session, now),
  };
}

/** The card type whose data.order_no is stored restored (whole) and shown masked here. */
const CLAIM_DRAFT = 'claim_draft';

/**
 * BR-AI-14 (其他 ≥11 位连续数字……trace 存脱敏值（保留后 4 位）): a claim_draft card is stored with
 * the whole order number restored into data.order_no; the admin detail shows that one field in the
 * form the trace stores tool arguments in (maskForTrace). Every other card, every other field of
 * the claim card (fallback_text included) and an order_no that is not a non-empty string are
 * returned as stored. The stored row is not touched.
 */
export function adminCardData(type: string, data: unknown): unknown {
  if (type !== CLAIM_DRAFT || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const orderNo = (data as Record<string, unknown>)['order_no'];
  if (typeof orderNo !== 'string' || orderNo === '') return data;
  return { ...(data as Record<string, unknown>), order_no: maskForTrace(orderNo) };
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

/** One page of the app's sessions, started_at descending (then a stable server order). */
export async function listAgentTraceSessions(
  deps: AdminTraceDeps,
  appId: string,
  query: AdminTraceSessionQuery,
): Promise<AdminAgentSessionPage> {
  const { from, to } = query;
  if (from !== undefined && to !== undefined && (await traceRangeEmpty(deps.db, from, to))) {
    throw new AdminTraceFieldsError(['from', 'to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  // A user_id / session_id that is not a UUID names no row (the columns are uuid).
  for (const id of [query.user_id, query.session_id]) {
    if (id !== undefined && !UUID.test(id))
      return { items: [], page, page_size: pageSize, total: 0 };
  }
  const filter: TraceSessionFilter = {
    appId,
    ...(query.user_id === undefined ? {} : { userId: query.user_id }),
    ...(query.session_id === undefined ? {} : { sessionId: query.session_id }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(query.badcase === undefined ? {} : { badcase: query.badcase }),
    ...(query.reported === undefined ? {} : { reported: query.reported }),
  };
  const { rows, total } = await listTraceSessions(deps.db, filter, page, pageSize);
  const now = deps.clock.now();
  const items: Item[] = rows.map((row) => ({
    ...header(row, now),
    run_count: row.runCount,
    badcase_count: row.badcaseCount,
    report_count: row.reportCount,
  }));
  return { items, page, page_size: pageSize, total };
}

/**
 * One session of the app with its trace, then its agent_trace_view audit record. Unknown, of
 * another app or not a UUID → AdminTraceFieldsError([session_id]) and no audit record.
 */
export async function getAgentTraceSession(
  deps: AdminTraceReadDeps,
  read: AdminTraceSessionRead,
): Promise<AdminAgentSessionDetail> {
  const found = UUID.test(read.sessionId)
    ? await readTraceSession(deps.db, read.appId, read.sessionId)
    : null;
  if (found === null) throw new AdminTraceFieldsError(['session_id']);
  const now = deps.clock.now();
  const messages: Message[] = found.messages.map((m) => ({
    message_id: m.id,
    role: m.role as Message['role'],
    text: m.text,
    card_ids: [...m.cardIds],
    feedback: m.feedback as Message['feedback'],
    badcase: m.badcase,
    reported_at: iso(m.reportedAt),
    report_reason: m.reportReason,
    report_status: m.reportStatus as Message['report_status'],
    report_note: m.reportNote,
  }));
  const runs: Run[] = found.runs.map((r) => ({
    run_id: r.id,
    intent: r.intent,
    model: r.model,
    model_snapshot: r.modelSnapshot,
    prompt_version: r.promptVersion,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    // BR-CALC-01: never lose precision silently; past 2^53 - 1 this throws (50001) instead of rounding.
    cost_mfen: r.costMfen === null ? null : fenToJsonNumber(r.costMfen),
    ttft_ms: r.ttftMs,
    latency_ms: r.latencyMs,
    finish_reason: r.finishReason as Run['finish_reason'],
    filter_hits: [...r.filterHits] as Run['filter_hits'],
    accepted_at: r.acceptedAt.toISOString(),
    ended_at: iso(r.endedAt),
  }));
  const toolCalls: ToolCall[] = found.toolCalls.map((t) => ({
    run_id: t.runId,
    seq: t.seq,
    name: t.name,
    args: t.args as ToolCall['args'],
    status: t.status,
    latency_ms: t.latencyMs,
  }));
  const cards: Card[] = found.cards.map((c) => ({
    card_id: c.cardId,
    type: c.type,
    schema_version: c.schemaVersion,
    data: adminCardData(c.type, c.data) as Card['data'],
    fallback_text: c.fallbackText,
  }));
  const detail: AdminAgentSessionDetail = {
    ...header(found.session, now),
    messages,
    runs,
    tool_calls: toolCalls,
    cards,
  };
  // BR-AI-19: viewing a trace is audited — the operator and the session only, no content.
  await deps.audit.append({
    appId: read.appId,
    actor: read.adminId,
    action: AGENT_TRACE_VIEW_ACTION,
    target: `agent_sessions:${found.session.id}`,
    before: null,
    after: null,
    ip: read.ip,
  });
  return detail;
}
