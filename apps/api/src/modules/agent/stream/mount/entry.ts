// B3-05q · BR-AI-01 细则「情境入口」: the data side of the entry path (orchestrator/entry), over the
// same handlers the model's tools use, so the entry never builds a card of its own:
//   · quote: get_rebate_quote's own flow for the entry product_key (a fresh catalog lookup, the
//     link path's card entry and register_links, BR-AI-04 / BR-AI-05), without a card reference (no
//     model call scope). What the lookup threw tells the upstream's answer about the product
//     (ParsingError: delisted, unrecognised) from a server-side failure (anything else, and
//     ParsingError 50301 dependency unavailable), as BR-AI-15 细则 separates them.
//   · order: explain_order's own lookup by card reference, the reference bound to the entry
//     order_id: orders.get in the caller's scope (名下订单, BR-AI-07 判定规则 1), the order_status
//     card cut from the detail. Not in scope reads as 0 orders: the handoff card, as list_my_orders
//     gives without orders, never telling whether the order exists.
//   · resolve: get_rebate_quote's own reference resolution, so the core can tell a later quote of
//     the entry product in the same run (by another card_id or ref_ordinal) and answer it with the
//     entry card's id instead of a second card (BR-AI-05).
import { ParsingError } from '../../../parsing/index.ts';
import type { EntryQuoteOutcome, ScenarioEntryReaders } from '../../orchestrator/entry/index.ts';
import type { ToolOutcome } from '../../orchestrator/index.ts';
import { handoffCard, type HandoffDeps } from '../../tools/handoff/index.ts';
import { createExplainOrderHandler, type OrderToolsDeps } from '../../tools/orders/index.ts';
import { createRebateQuoteHandler, type RebateQuoteDeps } from '../../tools/quote/index.ts';

/** parsing's dependency-unavailable code: a server-side failure, not an answer about the item. */
const DEPENDENCY_DOWN = 50301;
/** The reference explain_order resolves to the entry order (never a session card id). */
const ENTRY_ORDER_REF = 'scenario-entry-order';

export interface ScenarioEntryReaderDeps {
  /** The deterministic runner's quote deps (no cardReference). */
  readonly quote: RebateQuoteDeps;
  /** The order tools' deps; absent: no order tool is registered (the entry never gets here). */
  readonly orders?: OrderToolsDeps;
  readonly handoff: HandoffDeps;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failedView(outcome: ToolOutcome): unknown {
  return isRecord(outcome.modelView) ? outcome.modelView['error'] : undefined;
}

/** The order tools' deps without a card reference (no model call scope on the entry path). */
function entryOrderDeps(deps: OrderToolsDeps, orderId: string): OrderToolsDeps {
  return {
    orders: deps.orders,
    quota: deps.quota,
    clock: deps.clock,
    config: deps.config,
    claim: deps.claim,
    handoff: deps.handoff,
    ...(deps.texts === undefined ? {} : { texts: deps.texts }),
    refs: {
      resolve: async (cardId) =>
        cardId === ENTRY_ORDER_REF ? { kind: 'order', orderId } : { kind: 'invalid' },
    },
  };
}

export function createScenarioEntryReaders(deps: ScenarioEntryReaderDeps): ScenarioEntryReaders {
  return {
    async quote(productKey, ctx): Promise<EntryQuoteOutcome> {
      // Per call: what this call's lookup threw (the handler maps every failure to tool_failed).
      let thrown: unknown = undefined;
      const quote = deps.quote;
      const handler = createRebateQuoteHandler({
        ...(quote.tokens === undefined ? {} : { tokens: quote.tokens }),
        parsing: quote.parsing,
        references: quote.references,
        catalog: {
          cards: quote.catalog.cards,
          async readProduct(key, context) {
            try {
              return await quote.catalog.readProduct(key, context);
            } catch (error) {
              thrown = error;
              throw error;
            }
          },
        },
      });
      const outcome = await handler.run(
        { product_key: productKey },
        { ...ctx, context: { product_key: productKey } },
      );
      if (outcome.kind === 'ok') return outcome;
      if (outcome.kind === 'rejected') {
        // Not a usable key for the catalog (the core checked the format): unrecognised.
        return { kind: 'parse_error', error_code: 30132, cards: [] };
      }
      const error = failedView(outcome);
      if (error === 'price_unavailable') return { kind: 'price_unavailable', cards: [] };
      if (error === 'no_card') return { kind: 'no_card', cards: [] };
      if (thrown instanceof ParsingError && thrown.code !== DEPENDENCY_DOWN) {
        return { kind: 'parse_error', error_code: thrown.code, cards: [] };
      }
      return { kind: 'server_failed' };
    },

    // The same resolver get_rebate_quote uses (the session's result store), read only.
    resolve: (reference, ctx) => deps.quote.references.resolve(reference, ctx),

    async order(orderId, ctx): Promise<ToolOutcome> {
      const orders = deps.orders;
      if (orders === undefined) return { kind: 'failed', modelView: { error: 'tool_failed' } };
      const handler = createExplainOrderHandler(entryOrderDeps(orders, orderId));
      const outcome = await handler.run({ card_id: ENTRY_ORDER_REF }, ctx);
      if (outcome.kind !== 'ok' || outcome.cards.length > 0) return outcome;
      // Not in 名下: the same as 0 orders (BR-AI-07), never a claim draft.
      return { ...outcome, cards: [await handoffCard(deps.handoff, ctx.appId)] };
    },
  };
}
