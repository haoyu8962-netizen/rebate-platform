// B3-05g · BR-AI-08 / BR-AI-05 / BR-AI-24: the search decorator around OrchestratorTools.
// Price conditions are checked before the inner port (one clarify per chain and slot), empty
// results are relaxed within the run's tool budget (spec first, then the price ceiling), every
// product_list is tagged against the user's original conditions and its conditions are saved
// under its result_set_id. ctx is always forwarded unchanged (B3-05i binds references to it).
// B3-03r · BR-AI-05: with `deps.chains` wired, a search's conditions become the session's current
// chain only once one of its product_lists was confirmed as written (a delivery receipt); until
// then 「换一批」 and 「第 N 个」 both keep addressing the batch the user saw last. A price question
// (awaiting_price) is still recorded at once: it is what the user was shown. So is a search that
// ends without a product_list (no result, failed, refused, notices only): its attempt is recorded
// as it was before the search (new conditions, the chain's own status), so 换平台 and price
// follow-ups continue the query the user just asked, but its page never runs ahead of the batch
// shown (D10-333); 再便宜点 without result still records nothing.
import type { AgentProductCard } from '../../tools/search/index.ts';
import { isTaolijinClosed, priceRangeInvalidView } from '../../tools/search/index.ts';
import { assignMatchTags } from '../../tools/match/index.ts';
import type { MatchConditions } from '../../tools/match/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type {
  OrchestratorToolCall,
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../core/ports.ts';
import {
  clarifyOptions,
  conditionsOf,
  currentChain,
  hasProducts,
  isRecord,
  listItems,
  newChainId,
  noticeCard,
  priceInvalid,
  readSearchParams,
  resultKeys,
  setChain,
  suggestionItems,
  validPrice,
  withServerNotices,
  without,
  SERVER_CALL,
  type InternalToolCall,
  type SessionChain,
} from './shared.ts';
import { shiftCardReferences } from './references.ts';
import type { ResultsDeps, SearchConditions } from './types.ts';

type Ok = Extract<ToolOutcome, { kind: 'ok' }>;
type Args = Readonly<Record<string, unknown>>;

function failedOutcome(): ToolOutcome {
  return { kind: 'failed', modelView: { error: 'tool_failed' } };
}

function isPriceRangeInvalid(outcome: ToolOutcome): boolean {
  return (
    outcome.kind === 'ok' &&
    isRecord(outcome.modelView) &&
    outcome.modelView['error'] === priceRangeInvalidView().error
  );
}

/** A final handler answer, returned exactly as the handler built it: no relaxation, retry,
 * no_result / relaxed_* notice or suggestion. BR-AI-18: a prohibited query or result set;
 * B3-04k · BR-AI-17: the closed taolijin notices (tlj_none, tlj_taobao_only). */
function isRefused(outcome: Ok): boolean {
  return (
    (isRecord(outcome.modelView) && outcome.modelView['refused'] === 'prohibited') ||
    isTaolijinClosed(outcome.trace)
  );
}

/** The model-visible name of a notice key, e.g. agent.notice.relaxed_spec → relaxed_spec. */
function noticeName(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

/** A forwarded call: the server marker never reaches the inner port. */
function forward(call: OrchestratorToolCall, args: Args, step?: string): OrchestratorToolCall {
  return { id: step === undefined ? call.id : `${call.id}:${step}`, name: call.name, args };
}

/** Tool calls per run (model calls and appended relaxation calls together). A run executes in
 * one process and all its calls share one ctx.signal, so counts are grouped by that signal and go
 * away with it once the run is over (garbage collection, not the abort event). */
type RunCalls = WeakMap<AbortSignal, Map<string, number>>;

function budget(calls: RunCalls, ctx: ToolContext, limit: number): () => boolean {
  let perRun = calls.get(ctx.signal);
  if (perRun === undefined) {
    perRun = new Map();
    calls.set(ctx.signal, perRun);
  }
  const counts = perRun;
  const key = JSON.stringify([ctx.subject.appId, ctx.sessionId, ctx.runId]);
  return () => {
    const used = counts.get(key) ?? 0;
    if (used >= limit) return false;
    counts.set(key, used + 1);
    return true;
  };
}

/** The user's original conditions for BR-AI-24 tagging (after an unrecognized price was
 * dropped, before relaxation). */
function matchConditions(requested: Args, relaxed: boolean): MatchConditions {
  const spec = requested['spec'];
  const min = requested['price_min_fen'];
  const max = requested['price_max_fen'];
  return {
    ...(typeof spec === 'string' ? { spec } : {}),
    ...(validPrice(min) ? { priceMinFen: min } : {}),
    ...(validPrice(max) ? { priceMaxFen: max } : {}),
    relaxed,
  };
}

/** The result_set_ids of the product_lists among `cards` (the ones finish saves). */
function resultSetIds(cards: readonly UnnumberedCard[]): string[] {
  const ids: string[] = [];
  for (const card of cards) {
    const id = card.data['result_set_id'];
    if (card.type === 'product_list' && typeof id === 'string' && id !== '') ids.push(id);
  }
  return ids;
}

function isProductCard(value: unknown): value is AgentProductCard {
  return (
    isRecord(value) &&
    (typeof value['title'] === 'string' || value['title'] === null) &&
    Number.isSafeInteger(value['final_price_fen']) &&
    typeof value['match_tag'] === 'string' &&
    Array.isArray(value['benefit_tags']) &&
    Number.isSafeInteger(value['coupon_fen']) &&
    typeof value['is_presale'] === 'boolean'
  );
}

export function createResultsTools(inner: OrchestratorTools, deps: ResultsDeps): OrchestratorTools {
  // Methods are looked up on inner at call time, never bound at creation.
  const tools: OrchestratorTools = {
    definitions: (appId, subject) => inner.definitions(appId, subject),
    enabledSearchPlatforms: (appId) => inner.enabledSearchPlatforms(appId),
    searchKeyword: (plan, ctx) => inner.searchKeyword(plan, ctx),
    execute: (call, ctx) => execute(call, ctx),
  };
  const calls: RunCalls = new WeakMap();

  async function execute(call: InternalToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const take = budget(calls, ctx, deps.limits.toolCalls);
    if (!take()) return failedOutcome();
    const args = call.args;
    if (call.name !== 'search_products' || !isRecord(args) || typeof args['q'] !== 'string') {
      return inner.execute(call, ctx);
    }
    return search(call, args, ctx, take);
  }

  /** Only a pending question on the same query keeps a direct model call on its old chain.
   * Explicit server continuations retain their chain even after it has produced products. */
  async function searchChain(
    appId: string,
    sessionId: string,
    q: unknown,
    serverChainId?: string,
  ): Promise<SessionChain> {
    const current = await currentChain(deps.store, appId, sessionId);
    if (
      current !== null &&
      (serverChainId === current.chainId ||
        (serverChainId === undefined &&
          current.status === 'awaiting_price' &&
          current.conditions?.q === q))
    ) {
      return current;
    }
    return { chainId: serverChainId ?? newChainId(), conditions: null, status: 'searching' };
  }

  async function search(
    call: InternalToolCall,
    args: Args,
    ctx: ToolContext,
    take: () => boolean,
  ): Promise<ToolOutcome> {
    const appId = ctx.subject.appId;
    const server = call[SERVER_CALL];
    const previous = await searchChain(appId, ctx.sessionId, args['q'], server?.chainId);
    const chainId = previous.chainId;
    const chain: SessionChain = { ...previous, conditions: conditionsOf(args, chainId) };
    // 再便宜点 is only an attempt: its conditions become the chain's only once it shows products,
    // so a cheaper search without result leaves 换一批 / 换平台 on the conditions shown before.
    const attempt = server?.kind !== 'cheaper';
    // B3-03r: with deferred chains nothing is recorded before the search; the batch's chain waits
    // for its written list (finish), a price question is recorded when it is asked (askPrice) and
    // a round without a product_list records its attempt when it ends (unshown).
    if (attempt && deps.chains === undefined) {
      await setChain(deps.store, appId, ctx.sessionId, chain);
    }
    const tried: SessionChain | null = attempt ? chain : null;
    /** The round ends without a product_list: record the attempt now (deferred chains only). */
    const unshown = async <T>(result: T): Promise<T> => {
      if (deps.chains !== undefined) await recordAttempt(ctx, tried);
      return result;
    };
    const scope = { appId, sessionId: ctx.sessionId, chainId };
    const notices: string[] = [];
    let requested: Args = args;
    let outcome: ToolOutcome;

    const askPrice = async () => {
      if (attempt) {
        await setChain(deps.store, appId, ctx.sessionId, {
          ...chain,
          status: chain.status === 'has_products' ? 'has_products' : 'awaiting_price',
        });
      }
      return clarifyPrice(appId);
    };

    if (priceInvalid(args)) {
      // BR-AI-08: never search with an invalid price; ask once per chain, then drop it.
      if (await deps.store.takeOnce(scope, 'price')) return askPrice();
      requested = without(args, 'price_min_fen', 'price_max_fen');
      notices.push(resultKeys.priceUnrecognized);
      outcome = await inner.execute(forward(call, requested), ctx);
    } else {
      outcome = await inner.execute(forward(call, args), ctx);
      if (isPriceRangeInvalid(outcome)) {
        if (await deps.store.takeOnce(scope, 'price')) return askPrice();
        requested = without(args, 'price_min_fen', 'price_max_fen');
        notices.push(resultKeys.priceUnrecognized);
        if (!take()) return unshown(await noResult(ctx, outcome, notices));
        outcome = await inner.execute(forward(call, requested, 'without-price'), ctx);
      }
    }

    if (outcome.kind !== 'ok' || isRefused(outcome)) return unshown(outcome);
    if (hasProducts(outcome))
      return finish(ctx, chainId, tried, outcome, requested, requested, notices, false);
    // BR-AI-08 ①: 再便宜点 never relaxes.
    if (server?.kind === 'cheaper') {
      return withNotices(ctx, outcome, [...notices, resultKeys.noCheaper], false);
    }

    // BR-AI-08 relaxation: the handler's effective spec decides whether step 1 applies.
    let working: Args = requested;
    const params = readSearchParams(outcome.trace);
    const steps: { readonly applies: boolean; readonly drop: string; readonly key: string }[] = [
      {
        applies: params !== null && params.spec !== null,
        drop: 'spec',
        key: resultKeys.relaxedSpec,
      },
      {
        applies: requested['price_max_fen'] !== undefined,
        drop: 'price_max_fen',
        key: resultKeys.relaxedPrice,
      },
    ];
    for (const step of steps) {
      if (!step.applies) continue;
      if (!take()) break;
      working = without(working, step.drop);
      notices.push(step.key);
      outcome = await inner.execute(forward(call, working, `relax-${step.drop}`), ctx);
      if (outcome.kind !== 'ok' || isRefused(outcome)) return unshown(outcome);
      if (hasProducts(outcome))
        return finish(ctx, chainId, tried, outcome, requested, working, notices, true);
    }
    return unshown(await noResult(ctx, outcome, notices));
  }

  async function clarifyPrice(appId: string): Promise<ToolOutcome> {
    return {
      kind: 'ok',
      modelView: withServerNotices({ items: [] }, ['clarify_price']),
      cards: [],
      suggestions: [...(await clarifyOptions(deps.texts, 'price', appId))],
    };
  }

  async function noResult(
    ctx: ToolContext,
    last: ToolOutcome,
    notices: readonly string[],
  ): Promise<ToolOutcome> {
    const base: Ok =
      last.kind === 'ok' ? last : { kind: 'ok', modelView: { items: [] }, cards: [] };
    return withNotices(ctx, base, [...notices, resultKeys.noResult], true);
  }

  /** Server notices first, then the handler's own cards; the trailing no-result notice last. */
  async function withNotices(
    ctx: ToolContext,
    outcome: Ok,
    keys: readonly string[],
    suggest: boolean,
  ): Promise<ToolOutcome> {
    const appId = ctx.subject.appId;
    const tail = keys.at(-1);
    const head = keys.slice(0, -1);
    const cards: UnnumberedCard[] = [];
    for (const key of head) cards.push(await noticeCard(deps.texts, appId, key));
    cards.push(...outcome.cards);
    if (tail !== undefined) cards.push(await noticeCard(deps.texts, appId, tail));
    const suggestions = suggest
      ? await suggestionItems(
          deps.texts,
          appId,
          [1, 2, 3].map((n) => resultKeys.noResultSuggestion(n)),
        )
      : undefined;
    const { suggestions: own, ...rest } = outcome;
    void own;
    const moved = shifted(ctx, outcome, head.length);
    return {
      ...rest,
      ...moved,
      modelView: withServerNotices(moved.modelView, keys.map(noticeName)),
      cards,
      ...(suggestions === undefined ? {} : { suggestions }),
    };
  }

  async function finish(
    ctx: ToolContext,
    chainId: string,
    tried: SessionChain | null,
    outcome: Ok,
    requested: Args,
    effective: Args,
    notices: readonly string[],
    relaxed: boolean,
  ): Promise<ToolOutcome> {
    const appId = ctx.subject.appId;
    const cards: UnnumberedCard[] = [];
    for (const key of notices) cards.push(await noticeCard(deps.texts, appId, key));
    for (const card of outcome.cards) cards.push(await tagged(card, requested, relaxed, appId));
    // BR-AI-05: the result set keeps this round's conditions; prices stay with the receipts.
    const conditions = conditionsOf(effective, chainId);
    if (conditions !== null) {
      for (const card of outcome.cards) {
        const id = card.data['result_set_id'];
        if (card.type !== 'product_list' || typeof id !== 'string') continue;
        await deps.store.save({
          id,
          appId,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          conditions,
        });
      }
    }
    // Continuations must start from the same effective conditions that produced these cards.
    await switchChain(ctx, chainId, tried, conditions, outcome.cards);
    if (notices.length === 0 && deps.match === undefined) return outcome;
    const moved = shifted(ctx, outcome, notices.length);
    return {
      ...outcome,
      ...moved,
      modelView: withServerNotices(moved.modelView, notices.map(noticeName)),
      cards,
    };
  }

  /**
   * The batch's has_products chain: set at once without `deps.chains` (B3-05g); otherwise kept
   * pending under the batch's product_list result sets until one of them is confirmed as written
   * (B3-03r). The switch never depends on the run's signal: a list confirmed as written switches
   * the chain also when the user stops the run afterwards.
   */
  async function switchChain(
    ctx: ToolContext,
    chainId: string,
    tried: SessionChain | null,
    conditions: SearchConditions | null,
    cards: readonly UnnumberedCard[],
  ): Promise<void> {
    const appId = ctx.subject.appId;
    const chains = deps.chains;
    if (conditions === null) {
      if (chains !== undefined) await recordAttempt(ctx, tried);
      return;
    }
    const chain: SessionChain = { chainId, conditions, status: 'has_products' };
    if (chains === undefined) {
      await setChain(deps.store, appId, ctx.sessionId, chain);
      return;
    }
    const ids = resultSetIds(cards);
    // No product_list to confirm (no saved result set): nothing can be written, so this round
    // counts as one without a list and records its attempt like a search without result.
    if (ids.length === 0) {
      await recordAttempt(ctx, tried);
      return;
    }
    chains.defer({ appId, sessionId: ctx.sessionId, chain, resultSetIds: ids });
  }

  /**
   * B3-03r: a round that shows no product_list records its attempt at once — the chain the search
   * started on with this round's requested conditions and that chain's own status, exactly what
   * was recorded before the search without `deps.chains`. Null (再便宜点) records nothing.
   * It records the query, never a page the user did not see (D10-333): on the current chain the
   * page stays the one already shown (a failed or stopped 换一批 does not move it; a condition
   * change that restarted at page 1 keeps page 1), and a new chain starts from page 1.
   * Never conditional on the run's signal.
   */
  async function recordAttempt(ctx: ToolContext, tried: SessionChain | null): Promise<void> {
    if (tried === null) return;
    const appId = ctx.subject.appId;
    const current = await currentChain(deps.store, appId, ctx.sessionId);
    const same = current !== null && current.chainId === tried.chainId ? current : null;
    await setChain(deps.store, appId, ctx.sessionId, unadvanced(tried, same));
  }

  /**
   * B3-05i: `offset` server notices now precede the handler's cards, so each card reference the
   * handler issued (modelView and trace) moves with its card; otherwise the core would resolve a
   * product's reference to the notice in its old position.
   */
  function shifted(ctx: ToolContext, outcome: Ok, offset: number): Pick<Ok, 'modelView' | 'trace'> {
    const modelView = shiftCardReferences(outcome.modelView, ctx, offset);
    if (outcome.trace === undefined) return { modelView };
    return {
      modelView,
      trace: shiftCardReferences(outcome.trace, ctx, offset) as NonNullable<Ok['trace']>,
    };
  }

  /** BR-AI-24: rewrite product_list items through assignMatchTags; count and order unchanged. */
  async function tagged(
    card: UnnumberedCard,
    requested: Args,
    relaxed: boolean,
    appId: string,
  ): Promise<UnnumberedCard> {
    const match = deps.match;
    if (match === undefined || card.type !== 'product_list') return card;
    const items = listItems(card);
    if (!items.every(isProductCard)) return card;
    const tags = await assignMatchTags(items, matchConditions(requested, relaxed), appId, match);
    return { ...card, data: { ...card.data, items: [...tags] } };
  }

  return tools;
}

/** The page the user has seen on a chain (absent means page 1). */
function pageOf(conditions: SearchConditions | null): number {
  return conditions?.page ?? 1;
}

/**
 * D10-333: `tried` with a page that never runs ahead of what was shown — on the current chain
 * the lower of the requested and the shown page (with the shown chain's own spelling when that
 * is the lower one), on a new chain page 1 (no page key).
 */
function unadvanced(tried: SessionChain, current: SessionChain | null): SessionChain {
  const conditions = tried.conditions;
  if (conditions === null) return tried;
  const { page, ...rest } = conditions;
  void page;
  if (current === null) return { ...tried, conditions: rest };
  const kept = pageOf(conditions) <= pageOf(current.conditions) ? conditions : current.conditions;
  const shown = kept?.page;
  return { ...tried, conditions: shown === undefined ? rest : { ...rest, page: shown } };
}
