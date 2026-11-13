// B3-08zc · BR-AI-19 细则「助手回复落库」: the reply of a run, written by finalizeRun in the SAME
// transaction as its terminal state (the F5 UPDATE of agent_runs), only by the process that ran it
// (settle's live mode with the RunManager's RunReply). A run finalized by another request (crash
// recovery) has no reply in memory: its assistant row is left as acceptance wrote it.
//
// writeReply(q, run, session, reply):
//   the run's assistant row of app.agent_messages: text = reply.text ('' when the run wrote none),
//   card_ids = the card_id of every stored card in delivery order; one app.agent_cards row per card
//   (storedCard: earnings_summary keeps as_of and actions only, D32), idempotent on the unique key
//   (app_id, session_id, card_id). agent_sessions is not touched (BR-AI-20: last_active_at moves
//   at acceptance only). A session the account deletion already detached from its user (user_id
//   NULL, user_hash set; BR-AI-22) gets nothing written back.
//   Then, for the stored cards listed in reply.unframed (kept while the client was gone: no
//   receipt this round), the delivery records their receipt would have written (./deliveries.ts),
//   so the next round can reference them like framed cards; cards that got a receipt are not
//   written again.
//   Card JSON comes from outside (union titles, model arguments): before any of it is written,
//   every string in a card (keys included) loses its NUL characters and lone surrogates become
//   U+FFFD (cleanCard), which jsonb would refuse and so roll the whole terminal transaction back.
//   A card the agent_cards constraints would refuse (storable) is left out with a warn carrying
//   the run id, type and card id only (no card content, no user text).
import { sql } from 'kysely';
import { newUuidV7 } from '../../../platform/index.ts';
import { isUuid } from '../../store/index.ts';
import type { RootLogger } from '../../../platform/index.ts';
import type { RunReply } from '../admission/index.ts';
import type { CardInput } from '../writer/index.ts';
import { writeDeliveries } from './deliveries.ts';
import type { RunRow, SessionRow } from './store.ts';
import type { Queries } from './transaction.ts';

/** contracts/enums/ops.yaml agent_card_type (agent_cards_type_check). */
const CARD_TYPES: ReadonlySet<string> = new Set([
  'product_list',
  'rebate_quote',
  'order_status',
  'claim_draft',
  'handoff',
  'auth_required',
  'notice',
  'rule_ref',
  'page_guide',
  'earnings_summary',
]);

/**
 * The card as stored: the frame unchanged, except an earnings_summary card, whose stored data keeps
 * only as_of and actions (BR-AI-19 细则 D32: no amount copy; the amounts appear only in the SSE frame
 * that delivered the card; agent_cards_earnings_no_amount_check).
 */
export function storedCard(card: CardInput): CardInput {
  if (card.type !== 'earnings_summary') return card;
  const data: Record<string, unknown> = {};
  for (const key of ['as_of', 'actions']) {
    if (Object.hasOwn(card.data, key)) data[key] = card.data[key];
  }
  return { ...card, data };
}

/** 04 §8.3 card_id (agent_cards_card_id_check; as store/results isCardId, not imported: a cycle). */
function isCardId(cardId: string): boolean {
  return /^c[1-9][0-9]*$/u.test(cardId);
}

/** agent_cards.link_id: a top-level UUID string data.link_id, otherwise null. */
function linkIdOf(data: Readonly<Record<string, unknown>>): string | null {
  const value = data['link_id'];
  return typeof value === 'string' && isUuid(value) ? value : null;
}

/** What the agent_cards constraints accept (a frame the writer validated always is). */
function storable(card: CardInput): boolean {
  return (
    isCardId(card.card_id) &&
    CARD_TYPES.has(card.type) &&
    Number.isSafeInteger(card.schema_version) &&
    card.schema_version >= 1 &&
    typeof card.fallback_text === 'string' &&
    card.fallback_text !== '' &&
    card.data !== null &&
    typeof card.data === 'object' &&
    !Array.isArray(card.data)
  );
}

/** A JSON value with every string (object keys too) free of NUL and well formed (jsonb-safe). */
export function cleanJson(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '').toWellFormed();
  if (Array.isArray(value)) return value.map(cleanJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [cleanJson(key) as string, cleanJson(item)]),
    );
  }
  return value;
}

/** The card with every string cleaned (cleanJson); anything not an object is kept for storable. */
export function cleanCard(card: CardInput): CardInput {
  const cleaned = cleanJson(card);
  return cleaned !== null && typeof cleaned === 'object' ? (cleaned as CardInput) : card;
}

/** Detached by the account deletion's purge: no user any more, the user hash kept (BR-AI-22). */
export function detached(session: Pick<SessionRow, 'user_id' | 'user_hash'>): boolean {
  return session.user_id === null && session.user_hash !== null;
}

export async function writeReply(
  q: Queries,
  run: RunRow,
  session: SessionRow,
  reply: RunReply,
  now: Date,
  logger?: Pick<RootLogger, 'warn'>,
): Promise<void> {
  if (detached(session)) return;
  const kept: CardInput[] = [];
  for (const card of reply.cards.map(cleanCard)) {
    if (storable(card)) {
      kept.push(card);
      continue;
    }
    logger?.warn(
      {
        run_id: run.id,
        card_type: typeof card.type === 'string' ? card.type.slice(0, 32) : null,
        card_id: typeof card.card_id === 'string' ? card.card_id.slice(0, 16) : null,
      },
      'agent.reply_card_unstorable',
    );
  }
  const cards = kept.map(storedCard);
  const ids = cards.map((card) => card.card_id);
  const unframed = new Set(reply.unframed ?? []);
  // The frames as they went out (an earnings card's stored copy differs, but it has no receipt).
  const offline = kept.filter((card) => unframed.has(card.card_id));
  // PG text cannot hold NUL; anything else is stored exactly as the deltas were joined.
  const text = reply.text.replaceAll('\u0000', '');
  await q.query(sql`UPDATE app.agent_messages SET text = ${text},
    card_ids = ${ids}::text[], row_version = row_version + 1, updated_at = ${now}
    WHERE app_id = ${run.app_id} AND session_id = ${run.session_id} AND run_id = ${run.id}
      AND role = 'assistant'`);
  if (cards.length === 0) return;
  const rows = cards.map((card) => {
    return sql`(${newUuidV7(now)}, ${run.app_id}, ${run.session_id}, ${run.id}, ${card.card_id},
      ${card.type}, ${JSON.stringify(card.data)}::jsonb,
      ${linkIdOf(card.data)}::uuid, ${card.schema_version},
      ${card.fallback_text})`;
  });
  // One statement: every card of the reply or none; a card_id already stored stays as it is.
  await q.query(sql`INSERT INTO app.agent_cards
    (id, app_id, session_id, run_id, card_id, type, data, link_id, schema_version, fallback_text)
    VALUES ${sql.join(rows)}
    ON CONFLICT (app_id, session_id, card_id) DO NOTHING`);
  if (offline.length > 0) await writeDeliveries(q, run, offline);
}
