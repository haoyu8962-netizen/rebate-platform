// B3-05g / B3-05k · BR-AI-05: in-memory ResultSetStore (tests and local wiring). The PG store of
// agent_result_sets / agent_result_chains belongs to B3-09c; it must keep the same semantics:
// conditions and delivered cards are kept apart, every lookup is scoped by app and session,
// takeOnce is atomic, chains are append-only and the last append is the current chain.
import type { ClarificationScope, ClarifySlot } from '../intents/types.ts';
import type {
  DeliveredProduct,
  QuotedReceiptStore,
  RecentQuoteReader,
  ResultSetInput,
  ResultSetStore,
  SessionChain,
  StoredResultSet,
} from './types.ts';

interface Row {
  input: ResultSetInput;
  delivered: DeliveredProduct[];
}

function snapshot(row: Row): StoredResultSet {
  return { ...row.input, delivered: [...row.delivered] };
}

function sameDomain(row: Row, appId: string, sessionId: string): boolean {
  return row.input.appId === appId && row.input.sessionId === sessionId;
}

/** Same check as the agent_result_chains CHECK (0067): has_products needs conditions, and
 * conditions always belong to the chain they are stored on. */
export function chainProblem(chain: SessionChain): string | null {
  if (chain.status === 'has_products' && chain.conditions === null) {
    return 'has_products chain without conditions';
  }
  if (chain.conditions !== null && chain.conditions.chain_id !== chain.chainId) {
    return 'conditions.chain_id differs from chainId';
  }
  return null;
}

function chainKey(appId: string, sessionId: string): string {
  return JSON.stringify([appId, sessionId]);
}

/** Whether `store` keeps quoted products (the memory store does; see QuotedReceiptStore). */
export function keepsQuoted<T extends object>(store: T): store is T & QuotedReceiptStore {
  return typeof (store as Partial<QuotedReceiptStore>).recordQuoted === 'function';
}

/** Whether `store` can read the recent quotes of a session (the memory and PG stores can). */
export function readsRecentQuotes<T extends object>(store: T): store is T & RecentQuoteReader {
  return typeof (store as Partial<RecentQuoteReader>).quotedRecently === 'function';
}

export function createMemoryResultSetStore(): Required<ResultSetStore> &
  QuotedReceiptStore &
  RecentQuoteReader {
  // Save order is the recency order; a re-save of the same id keeps its place and receipts.
  const rows: Row[] = [];
  const byId = new Map<string, Row>();
  const asked = new Set<string>();
  // Appends per app/session: only the last one is ever read back, so only it is kept here.
  const chains = new Map<string, SessionChain>();
  // B3-03p: quoted products (rebate_quote cards) by app/session; outside every result set.
  const quoted = new Map<string, DeliveredProduct[]>();
  // B3-05p: the runs of each app/session in the order this store first saw them (a result set
  // saved or a quote recorded; the memory store has no run table, so a run that stored nothing is
  // not counted here, unlike the PG store's agent_runs), and the runs that recorded a quote.
  const sessionRuns = new Map<string, string[]>();
  const quotedRuns = new Set<string>();

  function seen(appId: string, sessionId: string, runId: string): void {
    const key = chainKey(appId, sessionId);
    const list = sessionRuns.get(key) ?? [];
    if (!list.includes(runId)) list.push(runId);
    sessionRuns.set(key, list);
  }

  return {
    async save(value) {
      seen(value.appId, value.sessionId, value.runId);
      const existing = byId.get(value.id);
      if (existing !== undefined) {
        existing.input = value;
        return;
      }
      const row: Row = { input: value, delivered: [] };
      rows.push(row);
      byId.set(value.id, row);
    },

    async recordDelivered(resultSetId, items) {
      const row = byId.get(resultSetId);
      // A receipt for a set never saved has no trusted app/session: it is ignored.
      if (row === undefined) return;
      for (const item of items) {
        if (!row.delivered.some((entry) => entry.card_id === item.card_id)) {
          row.delivered.push(item);
        }
      }
    },

    async recordQuoted(scope, items) {
      seen(scope.appId, scope.sessionId, scope.runId);
      if (items.length > 0) {
        quotedRuns.add(JSON.stringify([scope.appId, scope.sessionId, scope.runId]));
      }
      const key = chainKey(scope.appId, scope.sessionId);
      const list = quoted.get(key) ?? [];
      for (const item of items) {
        if (!list.some((entry) => entry.card_id === item.card_id)) list.push(item);
      }
      quoted.set(key, list);
    },

    async quotedRecently(scope, turns) {
      if (!Number.isSafeInteger(turns) || turns <= 0) return false;
      const runs = (sessionRuns.get(chainKey(scope.appId, scope.sessionId)) ?? []).filter(
        (runId) => runId !== scope.runId,
      );
      return runs
        .slice(-turns)
        .some((runId) => quotedRuns.has(JSON.stringify([scope.appId, scope.sessionId, runId])));
    },

    async latestWithProducts(appId, sessionId) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row !== undefined && sameDomain(row, appId, sessionId) && row.delivered.length > 0) {
          return snapshot(row);
        }
      }
      return null;
    },

    async findDelivered(appId, sessionId, cardId) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row === undefined || !sameDomain(row, appId, sessionId)) continue;
        const found = row.delivered.find((entry) => entry.card_id === cardId);
        if (found !== undefined) return found;
      }
      const quote = quoted
        .get(chainKey(appId, sessionId))
        ?.find((entry) => entry.card_id === cardId);
      return quote ?? null;
    },

    async takeOnce(scope: ClarificationScope, slot: ClarifySlot) {
      // Check and insert run without an await in between: concurrent callers see one winner.
      const key = JSON.stringify([scope.appId, scope.sessionId, scope.chainId, slot]);
      if (asked.has(key)) return false;
      asked.add(key);
      return true;
    },

    async currentChain(appId, sessionId) {
      const last = chains.get(chainKey(appId, sessionId));
      return last === undefined ? null : { ...last };
    },

    async appendChain(appId, sessionId, chain) {
      const problem = chainProblem(chain);
      if (problem !== null) throw new Error(`appendChain: ${problem}`);
      chains.set(chainKey(appId, sessionId), {
        chainId: chain.chainId,
        status: chain.status,
        conditions: chain.conditions,
      });
    },
  };
}
