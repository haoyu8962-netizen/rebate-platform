// B3-05g · BR-AI-05 / BR-AI-08 / BR-PRICE-15: clarification chain, refinement (再便宜点 / 换一批 /
// 换平台 / 价格) and reference resolution. Refined searches go through the decorated tools port
// (deps.tools.execute, looked up on every call) so price checks, relaxation, tagging and result-set
// saving stay in one place; the chain and the 再便宜点 mode travel as a server-only call marker.
import type { RebateQuoteDeps } from '../../tools/quote/index.ts';
import { maxSearchPage } from '../../tools/search/schema.ts';
import type { RunBodyResult, RunContext } from '../../stream/run/index.ts';
import type { PathInput, ToolContext, ToolOutcome } from '../core/ports.ts';
import type { ClarifySlot, IntentDeps, IntentOutput, IntentRequest } from '../intents/types.ts';
import { isFallbackIntent, serveIntentFallback, serverCallsOf } from '../core/intent-fallback.ts';
import { openServerCall } from './references.ts';
import {
  argsOf,
  asksTaolijin,
  clarifyOptions,
  currentChain,
  isRecord,
  newChainId,
  noticeCard,
  priceInvalid,
  resultKeys,
  setChain,
  noResultSuggestions,
  without,
  SERVER_CALL,
  type InternalToolCall,
  type ServerCall,
} from './shared.ts';
import type { ResultsContinuationDeps, ResultsDeps, SearchConditions } from './types.ts';

type Done = Extract<RunBodyResult, { kind: 'done' }>;
type Refine = Extract<IntentOutput, { agent_intent: 'refine' }>;

function done(): Done {
  return { kind: 'done', finishReason: 'stop' };
}

function toolContext(
  request: PathInput,
  ctx: RunContext,
  placeholders: Readonly<Record<string, string>>,
): ToolContext {
  const input = request.input;
  return {
    subject: input.caller,
    ...(input.context === undefined ? {} : { context: input.context }),
    runId: input.runId,
    sessionId: input.sessionId,
    signal: ctx.signal,
    placeholders,
  };
}

/** A server-built tool call; the marker is a symbol, never a model argument. */
function serverCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  marker?: ServerCall,
): InternalToolCall {
  const call = { id: `server-${newChainId()}`, name, args };
  return marker === undefined ? call : { ...call, [SERVER_CALL]: marker };
}

function isClarify(outcome: ToolOutcome): boolean {
  return (
    outcome.kind === 'ok' &&
    outcome.cards.length === 0 &&
    isRecord(outcome.modelView) &&
    outcome.modelView['error'] === 'clarify'
  );
}

/** Warn notice when a server-built call fails: there is no model turn left to explain it. */
const FAILURE_KEYS: Readonly<Record<string, string>> = {
  search_products: resultKeys.searchFailed,
  get_rebate_quote: resultKeys.quoteFailed,
};

/**
 * One tool call outside the model loop (refinement, 第 N 个, a clarification answer), run like the
 * core runs a model call: tool.status start → execute inside its own card-reference scope (B3-05i;
 * the search and quote handlers issue references and throw without one) → end / failed. The scope
 * is closed once execute returns. Cards and suggestions of an ok outcome are delivered in order; a
 * failed or rejected outcome is never swallowed: tool.status failed (when the status texts are
 * wired) and a warn notice. The modelView reaches no model here, so it is not resolved.
 */
async function execute(
  deps: ResultsContinuationDeps,
  request: PathInput,
  ctx: RunContext,
  call: InternalToolCall,
): Promise<ToolOutcome> {
  const appId = request.input.caller.appId;
  await status(deps, appId, call.name, 'start', ctx);
  const scope = openServerCall(call.id, request.proceed.placeholders);
  let outcome: ToolOutcome;
  try {
    // deps.tools is read on every call (tests and wiring may replace execute after creation).
    outcome = await deps.tools.execute(call, toolContext(request, ctx, scope.placeholders));
  } catch {
    outcome = { kind: 'failed', modelView: { error: 'tool_failed' } };
  } finally {
    scope.refs.close();
  }
  await status(deps, appId, call.name, outcome.kind === 'ok' ? 'end' : 'failed', ctx);
  return outcome;
}

async function status(
  deps: ResultsContinuationDeps,
  appId: string,
  tool: string,
  phase: 'start' | 'end' | 'failed',
  ctx: RunContext,
): Promise<void> {
  const display = deps.texts.toolDisplay;
  if (display === undefined) return;
  ctx.toolStatus(tool, phase, await display(appId, tool, phase));
}

/** Deliver a server-built call's outcome: cards then suggestions, or the failure notice. */
async function emit(
  deps: ResultsContinuationDeps,
  appId: string,
  ctx: RunContext,
  name: string,
  outcome: ToolOutcome,
): Promise<void> {
  if (outcome.kind !== 'ok') {
    const key = FAILURE_KEYS[name] ?? resultKeys.searchFailed;
    await ctx.card(await noticeCard(deps.texts, appId, key, 'warn'));
    return;
  }
  for (const card of outcome.cards) await ctx.card(card);
  if (outcome.suggestions !== undefined && outcome.suggestions.length > 0) {
    ctx.suggestions(outcome.suggestions);
  }
}

/** Run a server-built search on a chain and deliver it. */
async function runSearch(
  deps: ResultsContinuationDeps,
  request: PathInput,
  ctx: RunContext,
  args: Readonly<Record<string, unknown>>,
  marker: ServerCall,
): Promise<Done> {
  const call = serverCall('search_products', args, marker);
  const outcome = await execute(deps, request, ctx, call);
  await emit(deps, request.input.caller.appId, ctx, call.name, outcome);
  return done();
}

export function createClarification(deps: ResultsContinuationDeps): IntentDeps['clarification'] {
  const store = deps.store;

  return {
    async scope(request) {
      const appId = request.input.caller.appId;
      const sessionId = request.input.sessionId;
      let chain = await currentChain(store, appId, sessionId);
      if (chain === null) {
        chain = { chainId: newChainId(), conditions: null, status: 'searching' };
        await setChain(store, appId, sessionId, chain);
      }
      return { appId, sessionId, chainId: chain.chainId };
    },

    takeOnce: (scope, slot) => store.takeOnce(scope, slot),

    options: (slot, appId) => clarifyOptions(deps.texts, slot, appId),

    async latestProducts(scope) {
      const latest = await store.latestWithProducts(scope.appId, scope.sessionId);
      return latest === null ? [] : latest.delivered.map((item) => item.card);
    },

    fallbackNotice(appId, slot) {
      return noticeCard(deps.texts, appId, fallbackKey(slot));
    },

    async withoutCondition(slot, request, ctx) {
      const appId = request.input.caller.appId;
      const sessionId = request.input.sessionId;
      const chain = await currentChain(store, appId, sessionId);
      const latest = await store.latestWithProducts(appId, sessionId);
      const base = chain?.conditions ?? latest?.conditions ?? null;
      // Nothing was searched in this session: the port already delivered the notice.
      if (base === null) return done();
      const drop = slot === 'price' ? ['price_min_fen', 'price_max_fen'] : ['platforms'];
      return runSearch(deps, request, ctx, without(argsOf(base), ...drop), {
        kind: 'refine',
        chainId: base.chain_id,
      });
    },
  };
}

function fallbackKey(slot: ClarifySlot): string {
  switch (slot) {
    case 'reference':
      return resultKeys.ordinalDefault;
    case 'price':
      return resultKeys.priceUnrecognized;
    case 'platform':
      return resultKeys.platformUnrecognized;
  }
}

/** BR-PRICE-15: min(previous ceiling, lowest delivered final price − 1); null when < 1 fen or
 * below the kept lower bound (nothing cheaper can exist). */
function cheaperCeiling(conditions: SearchConditions, prices: readonly number[]): number | null {
  if (prices.length === 0) return null;
  const lowest = prices.reduce((a, b) => (b < a ? b : a));
  const below = lowest - 1;
  const ceiling =
    conditions.price_max_fen === undefined ? below : Math.min(conditions.price_max_fen, below);
  if (ceiling < 1) return null;
  if (conditions.price_min_fen !== undefined && ceiling < conditions.price_min_fen) return null;
  return ceiling;
}

export function createRefinement(
  deps: ResultsContinuationDeps,
): Pick<IntentDeps['continuation'], 'run'> {
  const store = deps.store;
  const clarification = createClarification(deps);

  async function notice(request: IntentRequest, ctx: RunContext, key: string, suggest: boolean) {
    const appId = request.input.caller.appId;
    await ctx.card(await noticeCard(deps.texts, appId, key));
    // Nothing was searched on these paths: no search term, so no 「只搜{q_short}」 (BR-TEXT-22).
    if (suggest) ctx.suggestions(await noResultSuggestions(deps.texts, appId, null));
    return done();
  }

  /**
   * The latest search conditions of the session for 换一批 / 换平台 / a price answer: the current
   * chain's last attempt (recorded by the decorator even when it only asked a clarify question and
   * nothing was shown, BR-AI-08), else the latest result set that delivered products. Delivered
   * products are not required: a clarify answer continues the chain it answers.
   */
  async function latestSearch(request: IntentRequest): Promise<SearchConditions | null> {
    const appId = request.input.caller.appId;
    const sessionId = request.input.sessionId;
    const chain = await currentChain(store, appId, sessionId);
    if (chain !== null && chain.conditions !== null) return chain.conditions;
    const latest = await store.latestWithProducts(appId, sessionId);
    return latest?.conditions ?? null;
  }

  async function refine(intent: Refine, request: IntentRequest, ctx: RunContext): Promise<Done> {
    const conditions = intent.conditions;

    if ('cheaper' in conditions) {
      // B3-04k · BR-AI-17: on a taolijin chain 再便宜点 stays on the taolijin branch (the closed
      // notice), never the products of an earlier chain.
      const current = await latestSearch(request);
      if (current !== null && asksTaolijin(current)) {
        return runSearch(deps, request, ctx, argsOf(current), {
          kind: 'cheaper',
          chainId: current.chain_id,
        });
      }
      // 再便宜点 depends on the cards actually shown (BR-AI-05 细则 / BR-PRICE-15).
      const latest = await store.latestWithProducts(
        request.input.caller.appId,
        request.input.sessionId,
      );
      if (latest === null) return notice(request, ctx, resultKeys.noResult, true);
      const base = latest.conditions;
      // Only cards actually delivered count; prices never come from the model.
      const ceiling = cheaperCeiling(
        base,
        latest.delivered.map((item) => item.final_price_fen),
      );
      if (ceiling === null) return notice(request, ctx, resultKeys.noCheaper, false);
      // A new price condition and ordering restart at page 1 (编排裁定).
      const next = { ...argsOf(base), price_max_fen: ceiling, sort: 'final_price_asc', page: 1 };
      return runSearch(deps, request, ctx, next, { kind: 'cheaper', chainId: base.chain_id });
    }

    const base = await latestSearch(request);
    // Nothing searched in this session (no chain attempt, no result set): nothing to refine.
    if (base === null) return notice(request, ctx, resultKeys.noResult, true);
    const chain = { kind: 'refine' as const, chainId: base.chain_id };
    const args = argsOf(base);

    if ('next_batch' in conditions) {
      const page = (base.page ?? 1) + 1;
      if (page > maxSearchPage()) return notice(request, ctx, resultKeys.noResult, false);
      return runSearch(deps, request, ctx, { ...args, page }, chain);
    }
    const next: Record<string, unknown> = { ...args };
    if (conditions.platform !== undefined) next['platforms'] = [conditions.platform];
    let priceChanged = false;
    for (const key of ['price_min_fen', 'price_max_fen'] as const) {
      const value = conditions[key];
      if (value === undefined) continue;
      next[key] = value;
      if (value !== base[key]) priceChanged = true;
    }
    // A valid new price condition restarts at page 1 (编排裁定 AC-B3-05k#9); an answer that is
    // still invalid keeps the page, and the decorator drops the price after the one ask
    // (BR-AI-08). 换平台 alone keeps the page.
    if (priceChanged && !priceInvalid(next)) next['page'] = 1;
    return runSearch(deps, request, ctx, next, chain);
  }

  /** 第 N 个: a fresh quote through get_rebate_quote (the resolver maps the ordinal). An ordinal
   * beyond the list asks once per chain (BR-AI-01), then falls back to the first delivered card. */
  async function ordinal(ordinalValue: number, request: IntentRequest, ctx: RunContext) {
    const appId = request.input.caller.appId;
    const call = serverCall('get_rebate_quote', { ref_ordinal: ordinalValue });
    const outcome = await execute(deps, request, ctx, call);
    if (!isClarify(outcome)) {
      await emit(deps, appId, ctx, call.name, outcome);
      return done();
    }
    const scope = await clarification.scope(request);
    if (await store.takeOnce(scope, 'reference')) {
      ctx.suggestions([...(await clarifyOptions(deps.texts, 'reference', appId))]);
      return done();
    }
    const [first] = await clarification.latestProducts(scope);
    if (first === undefined) return notice(request, ctx, resultKeys.noResult, false);
    await ctx.card(first);
    await ctx.card(await clarification.fallbackNotice(appId, 'reference'));
    return done();
  }

  return {
    async run(intent, request, ctx) {
      switch (intent.agent_intent) {
        case 'refine':
          return refine(intent, request, ctx);
        case 'ref_ordinal':
          return ordinal(intent.ordinal, request, ctx);
        default:
          // B3-05o · BR-AI-01 细则「意图兜底与不空回复」: an intent whose tool the model did not
          // call is served by the server, through the core's server calls of this run.
          const server = serverCallsOf(ctx);
          if (deps.fallback !== undefined && server !== null) {
            if (isFallbackIntent(intent.agent_intent)) {
              return serveIntentFallback(intent.agent_intent, request, server, ctx, {
                ...deps.fallback,
                texts: deps.texts,
                enabledSearchPlatforms: (appId) => deps.tools.enabledSearchPlatforms(appId),
                keywordCall: (call) =>
                  serverCall(call.name, isRecord(call.args) ? call.args : {}, {
                    kind: 'keyword',
                    chainId: newChainId(),
                  }),
              });
            }
          }
          // Other continuations produce nothing here.
          return done();
      }
    },
  };
}

export function createReferenceResolver(
  deps: Pick<ResultsDeps, 'store'>,
): RebateQuoteDeps['references'] {
  return {
    async resolve(reference, context) {
      const { appId, sessionId } = context;
      if ('card_id' in reference) {
        if (typeof reference.card_id !== 'string') return { kind: 'invalid_args' };
        const found = await deps.store.findDelivered(appId, sessionId, reference.card_id);
        return found === null
          ? { kind: 'invalid_args' }
          : { kind: 'product', productKey: found.product_key };
      }
      const n = reference.ref_ordinal;
      if (!Number.isSafeInteger(n) || n < 1) return { kind: 'invalid_args' };
      const latest = await deps.store.latestWithProducts(appId, sessionId);
      const item = latest?.delivered[n - 1];
      return item === undefined
        ? { kind: 'clarify' }
        : { kind: 'product', productKey: item.product_key };
    },
  };
}
