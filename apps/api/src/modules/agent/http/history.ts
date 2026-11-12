// B3-08zc · listAgentSessionMessages (GET /v1/agent/sessions/{id}/messages of
// contracts/openapi.yaml; 04 §6.5; BR-AI-19 细则「助手回复落库」, BR-AI-20, BR-AI-23 GET ①–④),
// framework-neutral like ./index.ts. The rule tests in test/spec/agent/session-history/** reach it
// through agent/stream/mount createAgentHistoryRuntime (their kit's header is the contract); the
// split below (an HTTP layer over a reader of agent_messages / agent_cards) is a suggestion only.
//
// listMessages(caller, sessionId, query, reply):
//   ① access.check → 30501; ② identity.check → 10001 / 10005; ③ consent.check → 10004 with
//   data.consent_type 'ai_third_party'; ④ sessions.owned(owner, sessionId) null (missing, not the
//   caller's, or not a UUID) → 30504 without data. Owner as in ./index.ts (BR-AI-20: user_id with an
//   access token, else the device; a guest session is not its user's after login).
//   An expired session is NOT refused here: 200 with data.expired = true (read-only history).
//   query: the query string of the operation (cursor, limit ≤ 50, default 20); a malformed query is
//   20001 with data.fields (checked after ④, like POST's ⑤). The cursor is opaque: the base64url
//   form of the message id the reader's page starts below (AgentHistoryPage.nextCursor is that id).
//   200 AgentHistoryResponse {code 0, msg '', data {items, next_cursor, expired}, trace_id}: items
//   oldest first, one per agent_messages row of the session: user (text = the stored, redacted
//   text, cards [], finish_reason null) and assistant (text = the stored reply text, '' when none;
//   cards = the stored cards of card_ids in that order, as AgentHistoryCard; earnings_summary as
//   the earnings_summary_history shape; finish_reason = agent_runs.finish_reason, null while the
//   run has not ended). Reads committed data only; nothing in memory of any stream process.
//   JSON answers as in ./index.ts (status of contracts/error-codes.yaml, msg = texts.errorMsg).
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from an injected Clock.
import { errorCodes } from '@couli/contracts-ts';
import type { Schema } from '@couli/contracts-ts';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RunTexts } from '../stream/run/index.ts';
import { isUuid } from '../store/index.ts';
import type { AgentSessionStore } from '../store/index.ts';
import { ownerOf } from './index.ts';
import type {
  AgentAccessPort,
  AgentCaller,
  AgentConsentPort,
  AgentHttpReply,
  AgentIdentityPort,
} from './index.ts';

/** A card of a stored reply, as framed without seq (AgentHistoryCard). */
export interface AgentHistoryCard {
  readonly card_id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly data: Readonly<Record<string, unknown>>;
  readonly fallback_text: string;
}

/** One agent_messages row of a session with what the history shows of it. */
export interface AgentHistoryItem {
  readonly messageId: string;
  readonly role: 'user' | 'assistant';
  readonly createdAt: Date;
  /** The stored text; null when nothing was written (shown as ''). */
  readonly text: string | null;
  readonly cards: readonly AgentHistoryCard[];
  readonly finishReason: string | null;
}

export interface AgentHistoryPage {
  /** Oldest first. */
  readonly items: readonly AgentHistoryItem[];
  /** The message id the earlier page starts below; null when nothing is older. */
  readonly nextCursor: string | null;
}

/** Committed history of one session (agent_messages, agent_cards, agent_runs). */
export interface AgentHistoryReader {
  /** cursor: a message id of the session (rows strictly older than it), or null for the newest. */
  page(
    appId: string,
    sessionId: string,
    query: { readonly cursor: string | null; readonly limit: number },
  ): Promise<AgentHistoryPage>;
}

export interface AgentHistoryDeps {
  readonly access: AgentAccessPort;
  readonly identity: AgentIdentityPort;
  readonly consent: AgentConsentPort;
  readonly sessions: Pick<AgentSessionStore, 'owned'>;
  readonly messages: AgentHistoryReader;
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  readonly clock: Clock;
  readonly logger?: Pick<RootLogger, 'error' | 'warn'>;
}

export interface AgentHistoryHttp {
  listMessages(
    caller: AgentCaller,
    sessionId: string,
    query: unknown,
    reply: AgentHttpReply,
  ): Promise<void>;
}

/** contracts/openapi.yaml Limit: 1..50, default 20. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** contracts/openapi.yaml Cursor: maxLength 512. */
const MAX_CURSOR = 512;

/** AgentFinishReason of contracts/openapi.yaml. */
const FINISH_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'cancelled',
  'limit',
  'budget',
  'error',
  'auth_required',
  'safety',
  'fallback',
  'timeout',
]);

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

type HistoryQuery =
  | { readonly ok: true; readonly cursor: string | null; readonly limit: number }
  | { readonly ok: false; readonly fields: string[] };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One value of a query parameter (a repeated parameter is malformed). */
function single(value: unknown): unknown {
  return Array.isArray(value) ? undefined : value;
}

/** The message id a cursor stands for, or null when it is not one of ours. */
export function decodeHistoryCursor(cursor: string): string | null {
  if (cursor === '' || cursor.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/u.test(cursor)) return null;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  return isUuid(id) && encodeHistoryCursor(id) === cursor ? id : null;
}

export function encodeHistoryCursor(messageId: string): string {
  return Buffer.from(messageId, 'utf8').toString('base64url');
}

function parseQuery(query: unknown): HistoryQuery {
  if (query === undefined || query === null)
    return { ok: true, cursor: null, limit: DEFAULT_LIMIT };
  if (!isRecord(query)) return { ok: false, fields: ['query'] };
  const fields: string[] = [];
  let limit = DEFAULT_LIMIT;
  if (Object.hasOwn(query, 'limit') && query['limit'] !== undefined) {
    const raw = single(query['limit']);
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^\d{1,3}$/u.test(raw)
          ? Number(raw)
          : NaN;
    if (Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT) limit = value;
    else fields.push('limit');
  }
  let cursor: string | null = null;
  if (Object.hasOwn(query, 'cursor') && query['cursor'] !== undefined) {
    const raw = single(query['cursor']);
    const id = typeof raw === 'string' ? decodeHistoryCursor(raw) : null;
    if (id === null) fields.push('cursor');
    else cursor = id;
  }
  return fields.length > 0 ? { ok: false, fields } : { ok: true, cursor, limit };
}

function earningsHistory(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of ['as_of', 'actions']) {
    if (Object.hasOwn(data, key)) kept[key] = data[key];
  }
  return kept;
}

function historyCard(card: AgentHistoryCard): Schema<'AgentHistoryCard'> {
  return {
    card_id: card.card_id,
    type: card.type,
    schema_version: card.schema_version,
    // BR-AI-19 / D32: an earnings card comes back as earnings_summary_history (no amounts).
    data: card.type === 'earnings_summary' ? earningsHistory(card.data) : { ...card.data },
    fallback_text: card.fallback_text,
  };
}

function historyMessage(item: AgentHistoryItem): Schema<'AgentHistoryMessage'> {
  const assistant = item.role === 'assistant';
  const finish = assistant && item.finishReason !== null && FINISH_REASONS.has(item.finishReason);
  return {
    message_id: item.messageId,
    role: item.role,
    created_at: item.createdAt.toISOString(),
    text: item.text ?? '',
    cards: assistant ? item.cards.map(historyCard) : [],
    finish_reason: finish ? (item.finishReason as Schema<'AgentFinishReason'>) : null,
  };
}

export function createAgentHistoryHttp(deps: AgentHistoryDeps): AgentHistoryHttp {
  function refuse(
    caller: AgentCaller,
    reply: AgentHttpReply,
    code: keyof typeof errorCodes,
    data?: Schema<'ErrorEnvelope'>['data'],
  ): void {
    const body: Schema<'ErrorEnvelope'> = {
      code,
      msg: deps.texts.errorMsg(code),
      trace_id: caller.traceId,
      ...(data === undefined ? {} : { data }),
    };
    reply.json(errorCodes[code].http, JSON_HEADERS, body);
  }

  function failed(error: unknown): void {
    try {
      deps.logger?.error(
        {
          op: 'list_messages',
          stage: 'history',
          error_name: error instanceof Error ? error.name : 'unknown',
        },
        'agent_http_failed',
      );
    } catch {
      /* Logging must never turn into a different answer. */
    }
  }

  return {
    async listMessages(caller, sessionId, query, reply) {
      try {
        // BR-AI-23 ①–④ in that order, as the POST of the same path (the first failure answers).
        const access = await deps.access.check(caller);
        if (access) {
          refuse(caller, reply, access.code);
          return;
        }
        const identity = await deps.identity.check(caller);
        if (identity) {
          refuse(caller, reply, identity.code);
          return;
        }
        const consent = await deps.consent.check(caller);
        if (consent) {
          refuse(caller, reply, consent.code, { consent_type: 'ai_third_party' });
          return;
        }
        // ④ BR-AI-20: missing, not the caller's and not a UUID are never told apart. An expired
        // session stays readable for its owner (read-only history).
        const owned = isUuid(sessionId)
          ? await deps.sessions.owned(ownerOf(caller), sessionId)
          : null;
        if (!owned) {
          refuse(caller, reply, 30504);
          return;
        }
        const parsed = parseQuery(query);
        if (!parsed.ok) {
          refuse(caller, reply, 20001, { fields: parsed.fields });
          return;
        }
        const page = await deps.messages.page(caller.appId, owned.session.id, {
          cursor: parsed.cursor,
          limit: parsed.limit,
        });
        const body: Schema<'AgentHistoryResponse'> = {
          code: 0,
          msg: '',
          data: {
            items: page.items.map(historyMessage),
            next_cursor: page.nextCursor === null ? null : encodeHistoryCursor(page.nextCursor),
            expired: owned.expired,
          },
          trace_id: caller.traceId,
        };
        reply.json(200, JSON_HEADERS, body);
      } catch (error) {
        failed(error);
        refuse(caller, reply, 50001);
      }
    },
  };
}
