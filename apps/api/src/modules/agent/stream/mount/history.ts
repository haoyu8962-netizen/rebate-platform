// B3-08zc · the read side of the stream entry for listAgentSessionMessages (GET
// /v1/agent/sessions/{id}/messages; 04 §6.5; BR-AI-19 细则「助手回复落库」, BR-AI-20). Rule tests:
// test/spec/agent/session-history/** and test/spec/agent/reply-persist/** (their kit's header,
// test/spec/agent/reply-persist/kit.ts, is the contract).
//
// createAgentHistoryRuntime(deps) → AgentHistoryHttp (../../http/history.ts), built with nothing
//   running (no timer, no query) from the read part of createAgentStreamRuntime's deps only: db,
//   clock, logger, contentReader, consentReader. It shares nothing in memory with any stream
//   runtime (another process reads the same answer): access / identity / consent as the stream
//   runtime builds them (BR-AI-23 ①–③ over contentReader and consentReader), sessions over
//   createPgAgentSessionStore (④, agentSessionDefaults().idleMs), the history over committed rows
//   of app.agent_messages / app.agent_cards / app.agent_runs, texts.errorMsg =
//   agentDefaultTexts().errorMsg. Mounting the GET route on the stream entry follows once the
//   contract drops `x-implementation: planned` (content task A9).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no process.env, no import of identity.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import {
  createAgentHistoryHttp,
  type AgentHistoryCard,
  type AgentHistoryHttp,
  type AgentHistoryItem,
  type AgentHistoryReader,
} from '../../http/history.ts';
import { agentSessionDefaults, createPgAgentSessionStore } from '../../store/index.ts';
import {
  createAgentAccessPort,
  createAgentConsentPort,
  createAgentIdentityPort,
  createConsentVersionSource,
  type AgentConsentReader,
} from '../access/index.ts';
import { createAgentConfigReader, type AgentContentReader } from './config.ts';
import { agentDefaultTexts } from './texts.ts';

export interface AgentHistoryRuntimeDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** The same reader app.module hands createAgentStreamRuntime (B3-08k). */
  readonly contentReader: AgentContentReader;
  /** identity's consent reader bound by app.module (AgentConsentReaderFactory of ./index.ts). */
  readonly consentReader: (options: {
    readonly currentVersion: (appId: string) => Promise<number>;
  }) => AgentConsentReader;
}

interface MessageRow {
  readonly id: string;
  readonly role: string;
  readonly text: string | null;
  readonly card_ids: string[] | null;
  readonly created_at: Date;
  readonly finish_reason: string | null;
}

interface CardRow {
  readonly card_id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly data: unknown;
  readonly fallback_text: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The committed history of a session: agent_messages newest first by (created_at, run, user before
 * assistant, id) — a turn's two rows share created_at and run_id — `limit` of them below the
 * cursor row, given back oldest first; the cards of card_ids from agent_cards of the session, in
 * card_ids order; finish_reason of the run once it has its terminal state (final_event). A cursor
 * that is not a message of the session gives null (B3-08zh).
 */
export function createPgAgentHistoryReader(db: Kysely<DB>): AgentHistoryReader {
  return {
    async page(appId, sessionId, query) {
      if (query.cursor !== null) {
        // B3-08zh: the cursor must be a message of this very session (BR-AI-20: nothing of another
        // session is ever read through it); otherwise the caller answers 20001.
        const anchor = await sql<{ readonly id: string }>`SELECT c.id::text AS id
          FROM app.agent_messages c
          WHERE c.app_id = ${appId} AND c.session_id = ${sessionId}
            AND c.id = ${query.cursor}`.execute(db);
        if (anchor.rows.length === 0) return null;
      }
      const below =
        query.cursor === null
          ? sql``
          : sql`AND (m.created_at, COALESCE(m.run_id, m.id), m.role = 'assistant', m.id) <
              (SELECT c.created_at, COALESCE(c.run_id, c.id), c.role = 'assistant', c.id
                FROM app.agent_messages c
                WHERE c.app_id = ${appId} AND c.session_id = ${sessionId}
                  AND c.id = ${query.cursor})`;
      const { rows } = await sql<MessageRow>`SELECT m.id::text AS id, m.role, m.text, m.card_ids,
          m.created_at,
          CASE WHEN m.role = 'assistant' AND r.final_event IS NOT NULL THEN r.finish_reason END
            AS finish_reason
        FROM app.agent_messages m
        LEFT JOIN app.agent_runs r ON r.app_id = m.app_id AND r.id = m.run_id
        WHERE m.app_id = ${appId} AND m.session_id = ${sessionId} ${below}
        ORDER BY m.created_at DESC, COALESCE(m.run_id, m.id) DESC, m.role = 'assistant' DESC,
          m.id DESC
        LIMIT ${query.limit + 1}`.execute(db);
      const more = rows.length > query.limit;
      const kept = rows.slice(0, query.limit).reverse();
      const ids = [
        ...new Set(kept.flatMap((row) => (row.role === 'assistant' ? (row.card_ids ?? []) : []))),
      ];
      const cards = new Map<string, AgentHistoryCard>();
      if (ids.length > 0) {
        const found = await sql<CardRow>`SELECT card_id, type, schema_version, data, fallback_text
          FROM app.agent_cards
          WHERE app_id = ${appId} AND session_id = ${sessionId} AND card_id = ANY(${ids}::text[])`.execute(
          db,
        );
        for (const card of found.rows) {
          cards.set(card.card_id, {
            card_id: card.card_id,
            type: card.type,
            schema_version: card.schema_version,
            data: isRecord(card.data) ? card.data : {},
            fallback_text: card.fallback_text,
          });
        }
      }
      const items: AgentHistoryItem[] = kept.map((row) => {
        const role = row.role === 'assistant' ? 'assistant' : 'user';
        return {
          messageId: row.id,
          role,
          createdAt: row.created_at,
          text: row.text,
          cards:
            role === 'assistant'
              ? (row.card_ids ?? []).flatMap((id) => {
                  const card = cards.get(id);
                  return card === undefined ? [] : [card];
                })
              : [],
          finishReason: role === 'assistant' ? row.finish_reason : null,
        };
      });
      return { items, nextCursor: more ? (kept[0]?.id ?? null) : null };
    },
  };
}

export function createAgentHistoryRuntime(deps: AgentHistoryRuntimeDeps): AgentHistoryHttp {
  const { clock, logger, contentReader } = deps;
  const db = deps.db.withSchema('app');
  // As createAgentStreamRuntime builds ①–③ (BR-AI-23): the agent.* switches through
  // createAgentConfigReader, the consent over identity's reader with the same version source.
  const switches = createAgentConfigReader({ clock, content: contentReader });
  const version = createConsentVersionSource({ reader: contentReader, logger });
  const consent = deps.consentReader({ currentVersion: version });
  return createAgentHistoryHttp({
    access: createAgentAccessPort({ reader: switches }),
    identity: createAgentIdentityPort({ reader: switches }),
    consent: createAgentConsentPort({ consent, version }),
    sessions: createPgAgentSessionStore({ db, clock, ...agentSessionDefaults() }),
    messages: createPgAgentHistoryReader(deps.db),
    texts: agentDefaultTexts(),
    clock,
    logger,
  });
}
