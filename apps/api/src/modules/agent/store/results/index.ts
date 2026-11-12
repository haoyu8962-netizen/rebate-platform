// B3-09c: PG result persistence and independent trace writer. Wiring is a later task.
//
// createPgResultSetStore — the B3-05g / B3-05k ResultSetStore port on PostgreSQL, same semantics
// as the in-memory store (../../orchestrator/results/store.ts) except that everything persists:
//   save — inserts agent_result_sets (conditions only; prices and cards never go there, BR-AI-05)
//     after checking that the run belongs to the app and session; an unknown or foreign run
//     rejects and writes nothing. The same id again is ignored (ON CONFLICT DO NOTHING: the table
//     is append-only, so the first conditions win).
//   recordDelivered — app, session and run come only from the saved result set and its run, never
//     from the items. Unknown or non-UUID ids are ignored. Rows go to agent_result_deliveries in
//     delivery order (position = this set's max + 1, under an advisory lock per result set); a
//     card_id already delivered in the session (primary key) is skipped, also under concurrency.
//   recordQuoted (B3-03q) — the product of a written rebate_quote card, outside every product_list
//     result set: the scope's run (checked against app and session; else rejects, nothing written)
//     gets one quoted result set whose id is derived from the run id in SQL (quotedSetId: md5 of a
//     fixed prefix and the run id), conditions only a marker; the products go to
//     agent_result_deliveries like recordDelivered's (same lock, positions and card_id skip), so
//     findDelivered finds them and a card_id stays session-wide unique (first one wins).
//   latestWithProducts — the newest result set (created_at DESC, id DESC) of the session that has
//     at least one delivery and is not a quoted set (the id test survives a purge clearing
//     conditions), with its deliveries in delivery order (position, then created_at, card_id).
//     Never ordered by price.
//   findDelivered — the session's delivery of a card_id (session-wide unique), any round.
//   takeOnce — INSERT agent_clarify_asks … ON CONFLICT DO NOTHING RETURNING: one winner per key.
//   currentChain / appendChain — agent_result_chains, the largest seq is current; appends take
//     max(seq) + 1 under an advisory lock per session so concurrent appends get 1..N. Invalid
//     chains are rejected by chainProblem first (the table CHECKs are the backstop).
// createPgAgentTraceWriter — agent_cards / agent_tool_calls records (idempotent by their unique
// keys; a run outside the given app / session rejects with AgentTraceRejected and writes nothing).
// B3-08y (BR-AI-22, 04 §3.2「防止异步 trace 回填」): each write is ONE transaction that first locks
// the run's session row FOR SHARE (exclusive with the deletion purge's FOR NO KEY UPDATE), then
// checks the run and inserts, holding the lock until the insert commits. A session detached from
// its user (user_id NULL with user_hash set) makes the write resolve 'skipped' and write nothing
// (AgentTraceWriter keeps its B3-08q Promise<void> type; read the value with isTraceSkipped). A
// guest session (no user_hash) and a member session are written as before.
//
// couli_app only has SELECT and INSERT on these tables; no UPDATE, no FOR UPDATE. The trace writer's
// FOR SHARE is on agent_sessions only (couli_app holds column UPDATE grants there).
import type { DB } from '@couli/db';
import { fenToJsonNumber, parseFen } from '@couli/money';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { chainProblem } from '../../orchestrator/results/store.ts';
import type {
  ChainStatus,
  DeliveredProduct,
  QuotedReceiptStore,
  ResultSetStore,
  SearchConditions,
  SessionChain,
  StoredResultSet,
} from '../../orchestrator/results/types.ts';
import type { CardInput } from '../../stream/writer/index.ts';
import { isUuid } from '../index.ts';
import { advisoryLockSql, deliveriesLockKey, QUOTED_CONDITIONS, quotedSetId } from './keys.ts';

export interface ToolCallRecord {
  readonly seq: number;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>> | null;
  readonly result_digest: string | null;
  readonly status: 'ok' | 'failed' | 'rejected';
  readonly latency_ms: number | null;
}

/**
 * Both methods resolve undefined once written and the string TRACE_SKIPPED when the session is
 * detached from its user (B3-08y, BR-AI-22): typed void so the B3-08q callers stay unchanged.
 */
export interface AgentTraceWriter {
  recordCards(
    appId: string,
    sessionId: string,
    runId: string,
    cards: readonly CardInput[],
  ): Promise<void>;
  recordToolCalls(appId: string, runId: string, calls: readonly ToolCallRecord[]): Promise<void>;
}

/** What a trace write resolves when its session is detached from its user (BR-AI-22). */
export const TRACE_SKIPPED = 'skipped';

/** True for the value a trace write resolves when it skipped a detached session. */
export function isTraceSkipped(outcome: unknown): boolean {
  return outcome === TRACE_SKIPPED;
}

/**
 * A trace write the writer refuses on its own checks (run not in this app / session, invalid
 * card_id): writing it again cannot succeed.
 */
export class AgentTraceRejected extends Error {
  override readonly name = 'AgentTraceRejected';
}

interface DeliveryRow {
  card_id: string;
  product_key: string;
  platform: string;
  final_price_fen: bigint;
  card: unknown;
}

function deliveredOf(row: DeliveryRow): DeliveredProduct {
  return {
    card_id: row.card_id,
    product_key: row.product_key,
    platform: row.platform as DeliveredProduct['platform'],
    final_price_fen: fenToJsonNumber(row.final_price_fen),
    card: row.card as DeliveredProduct['card'],
  };
}

async function advisoryLock(connection: Kysely<DB>, key: readonly string[]): Promise<void> {
  await advisoryLockSql(key).execute(connection);
}

interface DeliveryOwner {
  readonly app_id: string;
  readonly session_id: string;
  readonly run_id: string;
}

/**
 * Appends `items` to the deliveries of `resultSetId` in order (position = max + 1 under an
 * advisory lock per result set); a card_id already delivered in the session is skipped.
 */
async function appendDeliveries(
  tx: Kysely<DB>,
  owner: DeliveryOwner,
  resultSetId: string,
  items: readonly DeliveredProduct[],
): Promise<void> {
  await advisoryLock(tx, deliveriesLockKey(owner.app_id, resultSetId));
  const last = await tx
    .selectFrom('agent_result_deliveries')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('app_id', '=', owner.app_id)
    .where('result_set_id', '=', resultSetId)
    .executeTakeFirst();
  let position = (last?.max ?? 0) + 1;
  for (const item of items) {
    // Only the DeliveredProduct fields are read; extra runtime fields are never stored.
    const inserted = await tx
      .insertInto('agent_result_deliveries')
      .values({
        app_id: owner.app_id,
        session_id: owner.session_id,
        run_id: owner.run_id,
        result_set_id: resultSetId,
        position,
        card_id: item.card_id,
        product_key: item.product_key,
        platform: item.platform,
        final_price_fen: parseFen(item.final_price_fen),
        card: JSON.stringify(item.card),
      })
      .onConflict((oc) => oc.columns(['app_id', 'session_id', 'card_id']).doNothing())
      .returning('card_id')
      .executeTakeFirst();
    if (inserted !== undefined) position += 1;
  }
}

export function createPgResultSetStore(deps: {
  db: Kysely<DB>;
}): Required<ResultSetStore> & QuotedReceiptStore {
  const db = deps.db.withSchema('app');

  async function deliveries(
    connection: Kysely<DB>,
    appId: string,
    resultSetId: string,
  ): Promise<DeliveredProduct[]> {
    const rows = await connection
      .selectFrom('agent_result_deliveries')
      .select(['card_id', 'product_key', 'platform', 'final_price_fen', 'card'])
      .where('app_id', '=', appId)
      .where('result_set_id', '=', resultSetId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('card_id', 'asc')
      .execute();
    return rows.map(deliveredOf);
  }

  return {
    async save(value) {
      const run =
        isUuid(value.runId) && isUuid(value.sessionId) && isUuid(value.id)
          ? await db
              .selectFrom('agent_runs')
              .select('id')
              .where('app_id', '=', value.appId)
              .where('session_id', '=', value.sessionId)
              .where('id', '=', value.runId)
              .executeTakeFirst()
          : undefined;
      if (run === undefined) {
        throw new Error('save: run not found in this app and session');
      }
      await db
        .insertInto('agent_result_sets')
        .values({
          id: value.id,
          app_id: value.appId,
          run_id: value.runId,
          conditions: JSON.stringify(value.conditions),
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    },

    async recordDelivered(resultSetId, items) {
      if (!isUuid(resultSetId) || items.length === 0) return;
      await db.transaction().execute(async (tx) => {
        const owner = await tx
          .selectFrom('agent_result_sets as s')
          .innerJoin('agent_runs as r', (join) =>
            join.onRef('r.app_id', '=', 's.app_id').onRef('r.id', '=', 's.run_id'),
          )
          .select(['s.app_id', 's.run_id', 'r.session_id'])
          .where('s.id', '=', resultSetId)
          .executeTakeFirst();
        // A receipt for a set never saved has no trusted app/session: it is ignored.
        if (owner === undefined) return;
        await appendDeliveries(tx, owner, resultSetId, items);
      });
    },

    async recordQuoted(scope, items) {
      if (items.length === 0) return;
      const run =
        isUuid(scope.runId) && isUuid(scope.sessionId)
          ? await db
              .selectFrom('agent_runs')
              .select('id')
              .where('app_id', '=', scope.appId)
              .where('session_id', '=', scope.sessionId)
              .where('id', '=', scope.runId)
              .executeTakeFirst()
          : undefined;
      if (run === undefined) {
        throw new Error('recordQuoted: run not found in this app and session');
      }
      await db.transaction().execute(async (tx) => {
        // One quoted set per run: concurrent first calls insert the same id, one row stays.
        const set = await tx
          .insertInto('agent_result_sets')
          .values({
            id: quotedSetId(sql`${scope.runId}`),
            app_id: scope.appId,
            run_id: scope.runId,
            conditions: QUOTED_CONDITIONS,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        const resultSetId =
          set?.id ??
          (
            await tx
              .selectFrom('agent_result_sets')
              .select('id')
              .where('app_id', '=', scope.appId)
              .where('run_id', '=', scope.runId)
              .where(sql<boolean>`id = ${quotedSetId(sql`${scope.runId}`)}`)
              .executeTakeFirstOrThrow()
          ).id;
        const owner = { app_id: scope.appId, session_id: scope.sessionId, run_id: scope.runId };
        await appendDeliveries(tx, owner, resultSetId, items);
      });
    },

    async latestWithProducts(appId, sessionId) {
      if (!isUuid(sessionId)) return null;
      const row = await db
        .selectFrom('agent_result_sets as s')
        .innerJoin('agent_runs as r', (join) =>
          join.onRef('r.app_id', '=', 's.app_id').onRef('r.id', '=', 's.run_id'),
        )
        .select(['s.id', 's.app_id', 's.run_id', 's.conditions', 'r.session_id'])
        .where('s.app_id', '=', appId)
        .where('r.session_id', '=', sessionId)
        // B3-03q: quoted products are addressable by card_id only, never by 「第 N 个」.
        .where(sql<boolean>`s.id <> ${quotedSetId(sql.ref('s.run_id'))}`)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('agent_result_deliveries as d')
              .select('d.card_id')
              .whereRef('d.app_id', '=', 's.app_id')
              .whereRef('d.run_id', '=', 's.run_id')
              .whereRef('d.result_set_id', '=', 's.id'),
          ),
        )
        .orderBy('s.created_at', 'desc')
        .orderBy('s.id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return null;
      const result: StoredResultSet = {
        id: row.id,
        appId: row.app_id,
        sessionId: row.session_id,
        runId: row.run_id,
        conditions: row.conditions as unknown as SearchConditions,
        delivered: await deliveries(db, row.app_id, row.id),
      };
      return result;
    },

    async findDelivered(appId, sessionId, cardId) {
      if (!isUuid(sessionId)) return null;
      const row = await db
        .selectFrom('agent_result_deliveries')
        .select(['card_id', 'product_key', 'platform', 'final_price_fen', 'card'])
        .where('app_id', '=', appId)
        .where('session_id', '=', sessionId)
        .where('card_id', '=', cardId)
        .executeTakeFirst();
      return row === undefined ? null : deliveredOf(row);
    },

    async takeOnce(scope, slot) {
      const inserted = await db
        .insertInto('agent_clarify_asks')
        .values({
          app_id: scope.appId,
          session_id: scope.sessionId,
          chain_id: scope.chainId,
          slot,
        })
        .onConflict((oc) => oc.columns(['app_id', 'session_id', 'chain_id', 'slot']).doNothing())
        .returning('slot')
        .executeTakeFirst();
      return inserted !== undefined;
    },

    async currentChain(appId, sessionId) {
      if (!isUuid(sessionId)) return null;
      const row = await db
        .selectFrom('agent_result_chains')
        .select(['chain_id', 'status', 'conditions'])
        .where('app_id', '=', appId)
        .where('session_id', '=', sessionId)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return null;
      const chain: SessionChain = {
        chainId: row.chain_id,
        status: row.status as ChainStatus,
        conditions: row.conditions as unknown as SearchConditions | null,
      };
      return chain;
    },

    async appendChain(appId, sessionId, chain) {
      const problem = chainProblem(chain);
      if (problem !== null) throw new Error(`appendChain: ${problem}`);
      await db.transaction().execute(async (tx) => {
        await advisoryLock(tx, ['agent.result.chains', appId, sessionId]);
        const last = await tx
          .selectFrom('agent_result_chains')
          .select((eb) => eb.fn.max('seq').as('max'))
          .where('app_id', '=', appId)
          .where('session_id', '=', sessionId)
          .executeTakeFirst();
        await tx
          .insertInto('agent_result_chains')
          .values({
            app_id: appId,
            session_id: sessionId,
            seq: (last?.max ?? 0) + 1,
            chain_id: chain.chainId,
            status: chain.status,
            conditions: chain.conditions === null ? null : JSON.stringify(chain.conditions),
          })
          .execute();
      });
    },
  };
}

/** 04 §8.3 card_id: c1, c2, … (same pattern as agent_cards_card_id_check). */
export function isCardId(cardId: string): boolean {
  return /^c[1-9][0-9]*$/.test(cardId);
}

/** agent_cards.link_id: only a top-level string data.link_id, otherwise null. */
export function cardLinkId(data: Readonly<Record<string, unknown>>): string | null {
  const value = data['link_id'];
  return typeof value === 'string' ? value : null;
}

/** The trace writer's session lock (B3-08y): who the session belongs to now. */
interface SessionOwner {
  readonly user_id: string | null;
  readonly user_hash: string | null;
}

/** Detached by the account deletion's purge: no user any more, the user hash kept (BR-AI-22). */
function detached(owner: SessionOwner): boolean {
  return owner.user_id === null && owner.user_hash !== null;
}

/** TRACE_SKIPPED as AgentTraceWriter resolves it (typed void, see the interface). */
const SKIPPED_WRITE = TRACE_SKIPPED as unknown as undefined;

export function createPgAgentTraceWriter(deps: {
  db: Kysely<DB>;
  newId: () => string;
}): AgentTraceWriter {
  const db = deps.db.withSchema('app');
  return {
    async recordCards(appId, sessionId, runId, cards) {
      for (const card of cards) {
        if (!isCardId(card.card_id)) throw new AgentTraceRejected('recordCards: invalid card_id');
      }
      if (!isUuid(sessionId) || !isUuid(runId)) {
        throw new AgentTraceRejected('recordCards: run not found in this app and session');
      }
      return db.transaction().execute(async (tx) => {
        // Held until this transaction commits: the purge cannot clear the session in between.
        const owner = await sql<SessionOwner>`SELECT user_id::text AS user_id, user_hash
          FROM app.agent_sessions WHERE app_id = ${appId} AND id = ${sessionId}
          FOR SHARE`.execute(tx);
        const session = owner.rows[0];
        const run =
          session === undefined
            ? undefined
            : await tx
                .selectFrom('agent_runs')
                .select('id')
                .where('app_id', '=', appId)
                .where('session_id', '=', sessionId)
                .where('id', '=', runId)
                .executeTakeFirst();
        if (session === undefined || run === undefined) {
          throw new AgentTraceRejected('recordCards: run not found in this app and session');
        }
        if (detached(session)) return SKIPPED_WRITE;
        if (cards.length === 0) return undefined;
        // One statement: either every new card is written or none (the run FK is the backstop).
        await tx
          .insertInto('agent_cards')
          .values(
            cards.map((card) => ({
              id: deps.newId(),
              app_id: appId,
              session_id: sessionId,
              run_id: runId,
              card_id: card.card_id,
              type: card.type,
              data: JSON.stringify(card.data),
              link_id: cardLinkId(card.data),
              schema_version: card.schema_version,
              fallback_text: card.fallback_text,
            })),
          )
          .onConflict((oc) => oc.columns(['app_id', 'session_id', 'card_id']).doNothing())
          .execute();
        return undefined;
      });
    },

    async recordToolCalls(appId, runId, calls) {
      if (!isUuid(runId))
        throw new AgentTraceRejected('recordToolCalls: run not found in this app');
      return db.transaction().execute(async (tx) => {
        // The run's session row, locked in this transaction until the insert commits.
        const owner = await sql<SessionOwner>`SELECT s.user_id::text AS user_id, s.user_hash
          FROM app.agent_runs r
          JOIN app.agent_sessions s ON s.app_id = r.app_id AND s.id = r.session_id
          WHERE r.app_id = ${appId} AND r.id = ${runId}
          FOR SHARE OF s`.execute(tx);
        const session = owner.rows[0];
        if (session === undefined) {
          throw new AgentTraceRejected('recordToolCalls: run not found in this app');
        }
        if (detached(session)) return SKIPPED_WRITE;
        if (calls.length === 0) return undefined;
        await tx
          .insertInto('agent_tool_calls')
          .values(
            calls.map((call) => ({
              id: deps.newId(),
              app_id: appId,
              run_id: runId,
              seq: call.seq,
              name: call.name,
              args: call.args === null ? null : JSON.stringify(call.args),
              result_digest: call.result_digest,
              status: call.status,
              latency_ms: call.latency_ms,
            })),
          )
          .onConflict((oc) => oc.columns(['app_id', 'run_id', 'seq']).doNothing())
          .execute();
        return undefined;
      });
    },
  };
}
