// B3-03j: production composition contract. No model transport or review service is added here.
// The implementation composes registry + keyword search + results/match, shares one result store
// with references/clarification/refinement, and binds parsing.parseUrl AND parsing.parseToken.
// Token candidates reach the same quote runner as URLs (the deterministic path passes them, B3-04g).
// Card entry creation is per call: linking receives scene=agent and the authenticated session.
// B3-08m: with ports.rules, search_rules is registered as well (BR-AI-07 T6). The reply templates
// of a run that called search_rules or an order tool are decided by orchestrator/core
// (core/reply-templates.ts) from that run's own tool outcomes, so the intent port is never asked
// for them (its trace.calls stays empty by design).
// B3-16a: with ports.earnings, get_my_earnings is registered too (a template tool of the core,
// agent.earnings.summary / unavailable).
import { randomUUID } from 'node:crypto';
import type { StreamReviewOptions, StreamReviewPorts } from './review.ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Catalog, CatalogCardEntry, CatalogConfigReader } from '../../../catalog/index.ts';
import type { ContentReader } from '../../../content/index.ts';
import { parseToken, parseUrl, type ParsingOptions } from '../../../parsing/index.ts';
import type { Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import {
  orchestratorLimitsDefaults,
  type AgentRunTexts,
  type DeterministicPath,
  type IntentPort,
  type OrchestratorTools,
} from '../../orchestrator/index.ts';
import { cardReference } from '../../orchestrator/core/card-references.ts';
import { createDeterministicPath } from '../../orchestrator/deterministic/index.ts';
import { createIntentPort, type IntentDeps } from '../../orchestrator/intents/index.ts';
import {
  createClarification,
  createKeywordResults,
  createMemoryResultSetStore,
  createReferenceResolver,
  createRefinement,
  createResultsTools,
  type ResultSetStore,
  type ResultsDeps,
} from '../../orchestrator/results/index.ts';
import { createPgPreviousIntentReader } from '../../store/runs/index.ts';
import { createPrefillClaimHandler, type ClaimDraftDeps } from '../../tools/claim/index.ts';
import { createGetMyEarningsHandler, type EarningsReads } from '../../tools/earnings/index.ts';
import { createHandoffHandler, type HandoffDeps } from '../../tools/handoff/index.ts';
import type { MatchDeps } from '../../tools/match/index.ts';
import {
  createExplainOrderHandler,
  createListMyOrdersHandler,
  type OrderCardRefs,
  type OrderNoQuota,
  type OrderToolsDeps,
} from '../../tools/orders/index.ts';
import {
  createLinkQuoteRunner,
  createRebateQuoteHandler,
  type LinkQuoteRunner,
  type RebateQuoteDeps,
} from '../../tools/quote/index.ts';
import {
  createToolRegistry,
  registeredToolNames,
  type ToolCallContext,
  type ToolHandler,
  type ToolSwitches,
} from '../../tools/registry/index.ts';
import { createSearchRulesHandler, type RulesDeps } from '../../tools/rules/index.ts';
import {
  createKeywordSearch,
  createSearchProductsHandler,
  type SearchProductsDeps,
} from '../../tools/search/index.ts';
import type { AgentEarningsProvidedPorts } from './earnings.ts';
import type { DailyCounter } from './orders.ts';

/**
 * What the composition root (app.module, stream entry) provides from union / catalog / linking /
 * parsing; agent imports none of their providers. The prohibited-word and category filters are
 * agent's own (createProductionStreamAssembly).
 */
export interface AgentStreamProvidedPorts extends AgentEarningsProvidedPorts {
  readonly platforms: SearchProductsDeps['platforms'];
  readonly searchProducts: SearchProductsDeps['searchProducts'];
  readonly readProduct: RebateQuoteDeps['catalog']['readProduct'];
  readonly parsing: ParsingOptions;
  readonly cards: AgentStreamBusinessPorts['cards'];
  /** B3-08g: orders' read-only queries (createOrderQueries, the same deps as orders.module). */
  readonly orders?: OrderToolsDeps['orders'];
  /** B3-08g: linking's link_logs reader for prefill_claim / explain_order (createClaimEntryReader). */
  readonly claimEntries?: ClaimDraftDeps['clicks'];
  /** B3-08g: the explain_order-by-number daily counter (Redis; no Redis rejects). */
  readonly dailyCounter?: DailyCounter;
  /**
   * B1-04zzy (D10-860): catalog's category blocklist (app.module: the stream entry's Catalog).
   * createProductionStreamAssembly judges every search candidate through it, with no cache: a
   * candidate the port drops, or any failure of the port (fail closed, one warn line without the
   * product), is not allowed. Absent: every candidate is allowed (fixtures without it).
   */
  readonly categories?: Pick<Catalog, 'filterCategories'>;
}

export interface AgentStreamAssemblyContext {
  /** B3-03m: optional; old factories keep their fail-closed behavior. */
  readonly safety?: StreamReviewOptions;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** The run manager's scheduler (the system scheduler in production). */
  readonly scheduler?: Scheduler;
  /** agentStreamPortsToken()'s value on the stream entry; absent without it. */
  readonly ports?: AgentStreamProvidedPorts;
  /**
   * B3-08k (D10-294): content's configuration reader (the runtime's deps.contentReader, assembled
   * by app.module). createProductionStreamAssembly reads every configuration value through it and
   * builds no content reader from context.db.
   * Review r2 (D10-305): `db` stays in this context for agent's own stores
   * (createPgResultSetStore, createOrderCardRefs); app.module's assembly must resolve to agent's
   * own function with a body (rule test: foreign-db-handoff/handoff.test.ts).
   */
  readonly contentReader: Pick<ContentReader, 'configValue'>;
}

export interface AgentStreamBusinessPorts {
  readonly search: Pick<
    SearchProductsDeps,
    'platforms' | 'searchProducts' | 'prohibited' | 'categoryAllowed'
  >;
  readonly readProduct: RebateQuoteDeps['catalog']['readProduct'];
  readonly parsing: ParsingOptions;
  readonly cards: (
    context: ToolCallContext,
    registration: { readonly scene: 'agent'; readonly agentSessionId: string },
  ) => CatalogCardEntry;
  /**
   * B3-08g: the ports behind handoff_to_human, prefill_claim, list_my_orders and explain_order.
   * Absent: only the two product tools are registered (B3-03j / B3-03n assemblies).
   */
  readonly orders?: AgentOrderToolPorts;
  /**
   * B3-08m: search_rules' data (the app's active rule chunks, agent.rag.min_score). Absent:
   * search_rules is not registered.
   */
  readonly rules?: Pick<RulesDeps, 'activeChunks' | 'config'>;
  /**
   * B3-16a (D32): get_my_earnings' figures (production: ports.earningsReads, the composition
   * root's createEarningsReads, or ./earnings.ts createUnavailableEarningsReads). Absent:
   * get_my_earnings is not registered.
   */
  readonly earnings?: EarningsReads;
}

/** B3-08g: orders' read queries, linking's link_logs reader, card_id refs, by-number budget. */
export interface AgentOrderToolPorts {
  readonly orders: OrderToolsDeps['orders'];
  readonly claimEntries: ClaimDraftDeps['clicks'];
  readonly refs: OrderCardRefs;
  readonly quota: OrderNoQuota;
}

export interface AgentStreamAssemblyDeps extends Omit<
  AgentStreamAssemblyContext,
  'ports' | 'scheduler' | 'contentReader'
> {
  readonly ports: AgentStreamBusinessPorts;
  readonly config: CatalogConfigReader;
  readonly scheduler: Scheduler;
  readonly texts: AgentRunTexts;
  readonly routes: IntentDeps['routes'];
  /** B3-03n: the one result store shared by search, references, clarification, refinement and
   * the core's delivery receipts (production: agent/store/results createPgResultSetStore over
   * context.db). Absent: createMemoryResultSetStore(), as before (B3-03f / B3-03j / B3-03m). */
  readonly results?: ResultSetStore;
}

export interface AgentStreamAssembly {
  /** B3-03m: consumed by the runtime; absent on legacy assemblies. */
  readonly safety?: StreamReviewPorts;
  readonly tools: OrchestratorTools;
  readonly deterministic: DeterministicPath;
  readonly intents: IntentPort;
  readonly results: ResultSetStore;
  readonly texts: AgentRunTexts;
}

/** Optional on the module/runtime: absence preserves B3-03f's minimal mount. */
export type AgentStreamAssemblyFactory = (
  context: AgentStreamAssemblyContext,
) => AgentStreamAssembly;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function switchValue(
  config: CatalogConfigReader,
  appId: string,
  key: string,
): Promise<unknown> {
  return (await config.configValue(appId, key))?.value;
}

/**
 * The model sees the same product list key for search_products as for get_rebate_quote
 * ({products: [{card_id, title, platform, benefit_tags}]}, BR-AI-05). Only the outermost port
 * renames; the results decorator and the refinement read the handler's own view.
 */
function productView(tools: OrchestratorTools): OrchestratorTools {
  return {
    definitions: (appId, subject) => tools.definitions(appId, subject),
    enabledSearchPlatforms: (appId) => tools.enabledSearchPlatforms(appId),
    searchKeyword: (plan, ctx) => tools.searchKeyword(plan, ctx),
    async execute(call, ctx) {
      const outcome = await tools.execute(call, ctx);
      if (call.name !== 'search_products' || outcome.kind !== 'ok') return outcome;
      if (!isRecord(outcome.modelView) || !Array.isArray(outcome.modelView['items'])) {
        return outcome;
      }
      const { items, ...rest } = outcome.modelView;
      return { ...outcome, modelView: { ...rest, products: items } };
    },
  };
}

/**
 * URL and token candidates go, in order, through the same quote runner (parsing.parseUrl /
 * parsing.parseToken inside it); since B3-04g the deterministic path hands each candidate over
 * unchanged, so the runner is passed as is.
 */
function linkPath(runner: LinkQuoteRunner, texts: AgentRunTexts): DeterministicPath {
  return createDeterministicPath({
    quotes: runner,
    texts,
    // B3-08q: no onTrace. The run trace (./trace.ts) stores the cards this path wrote as their
    // frames (the registered link ids inside the card data, agent_cards.link_id) and the core's
    // get_rebate_quote calls; the fragment's link_registrations have no column of their own.
  });
}

export function createAgentStreamAssembly(deps: AgentStreamAssemblyDeps): AgentStreamAssembly {
  const { config, ports, texts } = deps;
  // Per call, from the server-built call context: never a value captured at build time.
  const cardsFor = (ctx: ToolCallContext): CatalogCardEntry =>
    ports.cards(ctx, { scene: 'agent', agentSessionId: ctx.sessionId });

  // B3-03n: the injected store (production: PG, shared by every instance); else one in-memory
  // store per assembly (single instance only), as before.
  const store = deps.results ?? createMemoryResultSetStore();
  // B3-03q: the degraded batch's chain becomes current on its first delivery receipt; B3-03r: so
  // does a model or follow-up search's batch (the same pending table, `chains` below).
  const keywordResults = createKeywordResults(store);
  const limits = orchestratorLimitsDefaults();
  const switches: ToolSwitches = {
    async get(appId, key) {
      const value = await switchValue(config, appId, key);
      return typeof value === 'boolean' ? value : undefined;
    },
  };

  const searchDeps: SearchProductsDeps = {
    clock: deps.clock,
    config,
    platforms: ports.search.platforms,
    searchProducts: ports.search.searchProducts,
    prohibited: ports.search.prohibited,
    categoryAllowed: ports.search.categoryAllowed,
    cardEntry: cardsFor,
    newResultSetId: () => randomUUID(),
    cardReference,
    texts: (appId, key) => texts.text(appId, key),
  };
  // The deterministic runner never numbers cards (no card call scope on that path): no
  // cardReference there; the model tool gets the core's.
  const runnerDeps: RebateQuoteDeps = {
    tokens: { parseToken: (raw, context) => parseToken(ports.parsing, raw, context) },
    parsing: { parseUrl: (url, context) => parseUrl(ports.parsing, url, context) },
    catalog: { readProduct: ports.readProduct, cards: cardsFor },
    references: createReferenceResolver({ store }),
  };
  const quoteDeps: RebateQuoteDeps = { ...runnerDeps, cardReference };
  const handlers: ToolHandler[] = [
    createSearchProductsHandler(searchDeps),
    createRebateQuoteHandler(quoteDeps),
  ];
  // Identity reaches every port only from the server-built call context (BR-AI-03).
  const dictionary = (appId: string, key: string) => texts.text(appId, key);
  if (ports.orders !== undefined) {
    // B3-08g: the order tools and handoff; with ports.rules (B3-08m) registered =
    // specs/agent-tools.allowlist.
    const readConfig = (appId: string, key: string) => switchValue(config, appId, key);
    const handoff: HandoffDeps = { texts: dictionary, cardReference };
    const claim: ClaimDraftDeps = {
      clicks: ports.orders.claimEntries,
      clock: deps.clock,
      config: readConfig,
      platforms: ports.search.platforms,
      cardReference,
      texts: dictionary,
    };
    const orderDeps: OrderToolsDeps = {
      orders: ports.orders.orders,
      refs: ports.orders.refs,
      quota: ports.orders.quota,
      clock: deps.clock,
      config: readConfig,
      claim,
      handoff,
      cardReference,
      texts: dictionary,
    };
    handlers.push(
      createHandoffHandler(handoff),
      createPrefillClaimHandler(claim),
      createListMyOrdersHandler(orderDeps),
      createExplainOrderHandler(orderDeps),
    );
  }
  if (ports.rules !== undefined) {
    // B3-08m · BR-AI-07 T6: the app's active chunks and agent.rag.min_score are read per call.
    handlers.push(
      createSearchRulesHandler({
        activeChunks: ports.rules.activeChunks,
        config: ports.rules.config,
        texts: dictionary,
        cardReference,
      }),
    );
  }
  if (ports.earnings !== undefined) {
    // B3-16a · BR-AI-01 细则「收益查询」: read per call for the server-side caller only.
    handlers.push(
      createGetMyEarningsHandler({
        reads: ports.earnings,
        clock: deps.clock,
        texts: dictionary,
        cardReference,
      }),
    );
  }
  const names = registeredToolNames(handlers);
  const registry = createToolRegistry({ handlers, switches, logger: deps.logger });
  const keyword = createKeywordSearch(searchDeps);
  const inner: OrchestratorTools = {
    definitions: (appId, subject) => registry.definitions(appId, subject),
    execute: (call, ctx) => registry.execute(call, ctx),
    enabledSearchPlatforms: (appId) => keyword.enabledSearchPlatforms(appId),
    async searchKeyword(plan, ctx) {
      const outcome = await keyword.searchKeyword(plan, ctx);
      // B3-03p · BR-AI-05: the degraded path's product_list result sets, saved before any card is
      // written (the PG store records receipts only under a saved set); their chain is switched to
      // only once a list was confirmed as written (B3-03q, `receipts` below). Failure: logged, the
      // run keeps its cards (they just stay unreferenceable).
      try {
        await keywordResults.save(plan, ctx, outcome.cards);
      } catch (error) {
        deps.logger.warn(
          {
            run_id: ctx.runId,
            error_name: error instanceof Error ? error.name : typeof error,
          },
          'agent_keyword_result_set_failed',
        );
      }
      return outcome;
    },
  };
  // Jev result check is not wired (B3-12): the code rules decide every tag.
  const match: MatchDeps = { provider: async () => 'rules', scheduler: deps.scheduler };
  const resultsDeps: ResultsDeps = { store, texts, limits, match, chains: keywordResults };
  const results = createResultsTools(inner, resultsDeps);
  const continuation = { ...resultsDeps, tools: results };
  const previousIntents = createPgPreviousIntentReader({ db: deps.db });

  const intents = createIntentPort({
    routes: deps.routes,
    flags: {
      async enabled(appId, key) {
        try {
          return (await switchValue(config, appId, key)) === true;
        } catch {
          return false;
        }
      },
    },
    tools: { registered: (name) => names.includes(name) },
    texts,
    trace: {
      // B3-08m: no template call reaches the intent port: the core writes those runs' templates
      // itself (core/reply-templates.ts) and does not consult this port for them.
      calls: async () => [],
      // B3-08q: the cards this port writes reach the run trace (./trace.ts) as written frames.
      // TODO(规划/11 §2.3): 意图 trace 的 intent / page_guide_reject_reason 写入 agent_runs — blocked on agent_runs 的 run 级 trace 字段写者（stream/pg，另单）
      record: () => undefined,
    },
    clarification: createClarification(continuation),
    continuation: {
      // B3-08w · BR-AI-01 判定顺序②: the intent of this session's run just before this one; a
      // failed read is one warn line and null (拿不准按查收益).
      async previousIntent(request) {
        const { caller, sessionId, runId } = request.input;
        try {
          return await previousIntents.previousIntent({ appId: caller.appId, sessionId, runId });
        } catch (error) {
          deps.logger.warn(
            {
              run_id: runId,
              error_name: error instanceof Error ? error.name : typeof error,
            },
            'agent_previous_intent_failed',
          );
          return null;
        }
      },
      run: createRefinement(continuation).run,
    },
  });

  // B3-03n: `results` is also the core's delivery receipt port (createAgentStreamRuntime); B3-03q /
  // B3-03r: the same store whose receipts also switch a confirmed batch's chain (degraded, model
  // and follow-up searches alike).
  const receipts = keywordResults.receipts((error, resultSetId) => {
    deps.logger.warn(
      {
        result_set_id: resultSetId,
        error_name: error instanceof Error ? error.name : typeof error,
      },
      'agent_result_chain_failed',
    );
  });
  return {
    tools: productView(results),
    deterministic: linkPath(createLinkQuoteRunner(runnerDeps), texts),
    intents,
    results: receipts,
    texts,
  };
}
