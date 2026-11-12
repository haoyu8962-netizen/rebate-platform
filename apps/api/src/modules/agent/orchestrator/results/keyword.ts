// B3-03p / B3-03q · BR-AI-05 / BR-AI-14: the no-model keyword search's result sets. The search
// decorator forwards searchKeyword unchanged (B3-05g); the production assembly calls save() after
// the keyword search returns, so each product_list it built has its result set (the plan's
// conditions, server side) before any card is written — the receipt store records deliveries only
// under a saved set. The batch's chain becomes the session's current chain only once one of its
// product_lists was confirmed as written (a delivery receipt, B3-03q): a batch cancelled, cut by
// the card limit or written without a receipt leaves the current chain as it was, so 「换一批」
// and 「第 N 个」 keep addressing what the user saw last. B3-03r: the same pending table serves the
// model and follow-up path (createResultsTools' `chains`, PendingChains.defer).
import type { KeywordSearchPlan } from '../../model-gateway/degraded/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolContext } from '../core/ports.ts';
import { chainPort, conditionsOf, newChainId, setChain } from './shared.ts';
import { keepsQuoted, readsRecentQuotes } from './store.ts';
import type {
  PendingBatch,
  PendingChains,
  QuotedReceiptStore,
  RecentQuoteReader,
  ResultSetStore,
  SessionChain,
} from './types.ts';

/** A saved batch waiting for its first delivery receipt. */
interface Waiting {
  readonly appId: string;
  readonly sessionId: string;
  readonly chain: SessionChain;
  readonly ids: readonly string[];
}

/**
 * Pending batches kept per process (the receipt comes from the run that saved them, in the same
 * process). A batch that never goes out is never confirmed; the oldest are dropped beyond this.
 */
const MAX_PENDING_SETS = 10_000;

export interface KeywordResults extends PendingChains {
  /**
   * Saves every product_list's result_set_id under the run's app, session and run with the plan's
   * conditions (q, platforms, relevance, page 1) on a new chain, kept pending until one of them is
   * confirmed. Nothing is saved without a product_list.
   */
  save(plan: KeywordSearchPlan, ctx: ToolContext, cards: readonly UnnumberedCard[]): Promise<void>;
  /**
   * The receipt store over `store`: same methods, and a delivery receipt of a pending batch's
   * product_list (at least one product) first records it, then makes the batch's chain the
   * session's current chain once (also after a failed record: the user saw the cards).
   * The chain port is the store's own (or the fallback setChain uses for a store without one).
   * `onChainError` gets a failed switch; it never fails the receipt.
   */
  receipts(
    onChainError: (error: unknown, resultSetId: string) => void,
  ): ResultSetStore & Partial<QuotedReceiptStore> & Partial<RecentQuoteReader>;
}

export function createKeywordResults(store: ResultSetStore): KeywordResults {
  const pending = new Map<string, Waiting>();

  function defer(input: PendingBatch): void {
    const ids = [...new Set(input.resultSetIds.filter((id) => id !== ''))];
    if (ids.length === 0) return;
    const batch: Waiting = {
      appId: input.appId,
      sessionId: input.sessionId,
      chain: input.chain,
      ids,
    };
    // A re-saved id belongs to its latest batch only.
    for (const id of ids) {
      pending.delete(id);
      pending.set(id, batch);
    }
    while (pending.size > MAX_PENDING_SETS) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  }

  async function confirm(resultSetId: string): Promise<void> {
    const batch = pending.get(resultSetId);
    if (batch === undefined) return;
    for (const id of batch.ids) if (pending.get(id) === batch) pending.delete(id);
    await setChain(store, batch.appId, batch.sessionId, batch.chain);
  }

  return {
    defer,

    async save(plan, ctx, cards) {
      const ids: string[] = [];
      for (const card of cards) {
        const id = card.data['result_set_id'];
        if (card.type === 'product_list' && typeof id === 'string' && id !== '') ids.push(id);
      }
      if (ids.length === 0) return;
      const chainId = newChainId();
      const conditions = conditionsOf(
        { q: plan.q, platforms: [...plan.platforms], sort: plan.sort, page: 1 },
        chainId,
      );
      if (conditions === null) return;
      const appId = ctx.subject.appId;
      for (const id of ids) {
        await store.save({ id, appId, sessionId: ctx.sessionId, runId: ctx.runId, conditions });
      }
      defer({
        appId,
        sessionId: ctx.sessionId,
        chain: { chainId, conditions, status: 'has_products' },
        resultSetIds: ids,
      });
    },

    receipts(onChainError) {
      const wrapped: ResultSetStore & Partial<QuotedReceiptStore> & Partial<RecentQuoteReader> = {
        save: (value) => store.save(value),
        async recordDelivered(resultSetId, items) {
          try {
            await store.recordDelivered(resultSetId, items);
          } finally {
            if (items.length > 0) {
              try {
                await confirm(resultSetId);
              } catch (error) {
                onChainError(error, resultSetId);
              }
            }
          }
        },
        latestWithProducts: (appId, sessionId) => store.latestWithProducts(appId, sessionId),
        findDelivered: (appId, sessionId, cardId) => store.findDelivered(appId, sessionId, cardId),
        takeOnce: (scope, slot) => store.takeOnce(scope, slot),
      };
      const chains = chainPort(store);
      wrapped.currentChain = (appId, sessionId) => chains.currentChain(appId, sessionId);
      wrapped.appendChain = (appId, sessionId, chain) =>
        chains.appendChain(appId, sessionId, chain);
      if (keepsQuoted(store)) {
        wrapped.recordQuoted = (scope, items) => store.recordQuoted(scope, items);
      }
      // B3-05p: the title_based notice's recent quotes (agent-body sessionProducts).
      if (readsRecentQuotes(store)) {
        wrapped.quotedRecently = (scope, turns) => store.quotedRecently(scope, turns);
      }
      return wrapped;
    },
  };
}
