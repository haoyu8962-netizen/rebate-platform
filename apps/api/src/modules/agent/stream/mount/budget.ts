// B3-09m · BR-AI-16 (全局日预算与成本记账, 负责人 2026-11-25 取「甲」): the stream runtime's budgeted
// model path. Built by createAgentStreamRuntime only with a model gateway (today the test seam
// AgentStreamSeams.modelRouting; the production route is still fixed to no_model, B3-03k wires
// the real one); without it nothing here runs and no budget row is touched.
// - admit(): before the admission transaction (pg/admit.ts F0, nothing held) the run's plan is
//   read: agent.daily_budget_fen / agent.budget.reserve_mfen_per_run across every app (content's
//   configValuesByKey; the smallest budget, the largest reservation), the run's app's own
//   agent.models (fresh read) and its route. The run's price entry is fixed here: the first
//   route candidate with a usable price; the run then only uses candidates priced at that same
//   version (one version per run). A failed read, or no usable price, is a blocked plan: no
//   reservation, the run ends by budget (never 50xxx), with a warn alert. The transaction that
//   inserts the run reserves R against the budget (createDailyBudgetOn, logger + countBudgetAlert).
// - bind(): the run body runs inside the run's AsyncLocalStorage store, so the prompt source and
//   the model below know their run.
// - prompt(inner): the budget verdict comes before the prompt (D10-2858 9.2-6, money r3 S1): a run
//   ending by budget gets a placeholder prompt (version 'none', never sent) without reading the
//   inner one, so the core goes on to its model call, which degrades with reason budget; a failed
//   prompt read also ends the run by budget. Outside a run (the display labels read before
//   admission) a failed read answers null instead of failing the request.
// - model.complete(): one ModelRouter for the runtime (persistent breakers), the run's fixed route
//   and its RunCallBudget (R, the fixed prices, U and calls in process memory).
// - settleFields(): U and calls of the run plus the budget in force now (for the alert check),
//   handed to the terminal transaction (pg/finalize.ts).
import { AsyncLocalStorage } from 'node:async_hooks';

import type { RootLogger, Scheduler, Clock } from '../../../platform/index.ts';
import type { AdmissionRequest, AdmissionResult } from '../admission/index.ts';
import {
  BUDGET_KEYS,
  budgetConfigAcrossApps,
  countBudgetAlert,
  createDailyBudgetOn,
  parseModelPrices,
  raiseBudgetAlert,
  type BudgetConfig,
  type DailyBudgetOn,
  type ModelPrice,
  type ModelPrices,
} from '../../budget/index.ts';
import {
  createModelRouter,
  type ResolvedRoute,
  type RunCallBudget,
} from '../../model-gateway/routing/index.ts';
import type { VendorGateway } from '../../model-gateway/vendors/index.ts';
import type { AgentRunBodyDeps, PromptSource } from '../../orchestrator/core/ports.ts';
import type { RunBodyInput } from '../../http/index.ts';
import type { RunBody } from '../run/index.ts';
import { budgetVerdictOf } from '../pg/admit.ts';
import type { BudgetedAdmissionRequest, RunBudgetPlan } from '../pg/admit.ts';
import type { LiveRunBudget } from '../pg/finalize.ts';
import type { AgentContentReader } from './config.ts';

export interface BudgetedModelPathDeps {
  readonly gateway: VendorGateway;
  readonly route: (appId: string) => Promise<ResolvedRoute>;
  readonly content: Pick<AgentContentReader, 'configValuesByKey' | 'freshConfigValue'>;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: Pick<RootLogger, 'warn'>;
  /** The router's per-attempt limit (the run's model time budget). */
  readonly attemptTimeoutMs: number;
}

export interface BudgetedModelPath {
  admit(
    request: AdmissionRequest,
    next: (request: BudgetedAdmissionRequest) => Promise<AdmissionResult>,
  ): Promise<AdmissionResult>;
  bind(input: RunBodyInput, body: RunBody): RunBody;
  prompt(inner: PromptSource): PromptSource;
  readonly model: AgentRunBodyDeps['model'];
  /** The live detail of the run (undefined: not a run of this path); forgets the run. */
  settleFields(runId: string): Promise<LiveRunBudget | undefined>;
  /** The platform-wide budget now (mfen), for settlements without live detail. */
  budgetLimit(): Promise<bigint>;
}

interface PlannedRun {
  readonly plan: RunBudgetPlan;
  readonly route: ResolvedRoute;
  readonly prices: ModelPrices;
}

interface BudgetedRun {
  readonly runId: string;
  /** No model for this run: ends by budget. */
  exhausted: boolean;
  readonly route: ResolvedRoute;
  readonly spend: RunCallBudget;
}

const NO_MODEL: ResolvedRoute = { mode: 'no_model', attempts: [], dropped: [] };
const BUDGET_PROMPT = Object.freeze({ version: 'none', system: '' });

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Prices restricted to the run's one version (the entry fixed at admission). */
function pricesAt(prices: ModelPrices, version: string): ModelPrices {
  return {
    priceOf(modelId) {
      const price = prices.priceOf(modelId);
      return price?.version === version ? price : undefined;
    },
  };
}

export function createBudgetedModelPath(deps: BudgetedModelPathDeps): BudgetedModelPath {
  const { logger } = deps;
  const daily: DailyBudgetOn = createDailyBudgetOn({
    clock: deps.clock,
    logger,
    onAlert: countBudgetAlert,
  });
  const planned = new Map<string, PlannedRun>();
  const runs = new Map<string, BudgetedRun>();
  const current = new AsyncLocalStorage<BudgetedRun>();
  const silent = { record: () => undefined };
  const router = createModelRouter({
    gateway: deps.gateway,
    route: () => current.getStore()?.route ?? NO_MODEL,
    budgetExhausted: () => current.getStore()?.exhausted ?? true,
    config: {
      attemptTimeoutMs: deps.attemptTimeoutMs,
      breaker: { windowMs: 60_000, minRequests: 1_000_000, failureRatePercent: 99, openMs: 1 },
    },
    scheduler: deps.scheduler,
    meter: silent,
    clock: deps.clock,
    budgetLogger: logger,
  });

  async function configValues(key: string) {
    const read = deps.content.configValuesByKey;
    if (read === undefined) throw new Error('agent: the content reader has no configValuesByKey');
    return read(key);
  }

  async function budgetConfig() {
    const [budgets, reserves] = await Promise.all([
      configValues(BUDGET_KEYS.dailyBudgetFen),
      configValues(BUDGET_KEYS.reserveMfenPerRun),
    ]);
    const config = budgetConfigAcrossApps(budgets, reserves);
    if (config.invalid.length > 0) {
      logger.warn({ config_keys: [...config.invalid] }, 'agent.budget_config_invalid');
    }
    return config;
  }

  /** The plan of one run (never rejects: any failure is a blocked plan with a warn alert). */
  async function planOf(appId: string, runId: string): Promise<PlannedRun> {
    const blocked = (route: ResolvedRoute = NO_MODEL): PlannedRun => ({
      plan: { blocked: true, budgetMfen: 0n, reserveMfen: 0n, priceVersion: null },
      route,
      prices: parseModelPrices(undefined),
    });
    let config: BudgetConfig;
    try {
      config = await budgetConfig();
    } catch (error) {
      logger.warn({ run_id: runId, error_name: errorName(error) }, 'agent.budget_unavailable');
      return blocked();
    }
    let prices: ModelPrices;
    try {
      const stored = await deps.content.freshConfigValue(appId, BUDGET_KEYS.models);
      prices = parseModelPrices(stored?.value);
    } catch (error) {
      raiseBudgetAlert({ logger, onAlert: countBudgetAlert }, 'budget_price_missing', {
        run_id: runId,
        app_id: appId,
        error_name: errorName(error),
      });
      return blocked();
    }
    let route: ResolvedRoute;
    try {
      route = structuredClone(await deps.route(appId));
    } catch (error) {
      // Not a budget verdict: the run's model call reports an unavailable route as before.
      logger.warn({ run_id: runId, error_name: errorName(error) }, 'agent.budget_route_unread');
      route = { mode: 'models', attempts: [], dropped: [] };
    }
    let fixed: ModelPrice | undefined;
    if (route.mode === 'models') {
      for (const entry of route.attempts) {
        fixed = prices.priceOf(entry.model);
        if (fixed !== undefined) break;
      }
      if (route.attempts.length > 0 && fixed === undefined) {
        // Fail-close: no candidate of the run has a usable price.
        raiseBudgetAlert({ logger, onAlert: countBudgetAlert }, 'budget_price_missing', {
          run_id: runId,
          app_id: appId,
        });
        return blocked(route);
      }
    }
    return {
      plan: {
        blocked: false,
        budgetMfen: config.budgetMfen,
        reserveMfen: config.reserveMfen,
        priceVersion: fixed?.version ?? null,
      },
      route,
      prices: fixed === undefined ? parseModelPrices(undefined) : pricesAt(prices, fixed.version),
    };
  }

  async function budgetLimit(): Promise<bigint> {
    return (await budgetConfig()).budgetMfen;
  }

  return {
    async admit(request, next) {
      const runId = request.runId;
      const result = await next({
        ...request,
        budget: {
          daily,
          plan: async (appId) => {
            const one = await planOf(appId, runId);
            planned.set(runId, one);
            return one.plan;
          },
        },
      });
      const one = planned.get(runId);
      planned.delete(runId);
      if (result.kind !== 'accepted') return result;
      const verdict = budgetVerdictOf(result);
      // An accepted run without a verdict is never sent to a model (fail-close).
      runs.set(runId, {
        runId,
        exhausted: verdict === undefined || one === undefined || verdict.exhausted,
        route: one?.route ?? NO_MODEL,
        spend: {
          reserveMfen: verdict?.reserved === true ? verdict.plan.reserveMfen : 0n,
          prices: one?.prices ?? parseModelPrices(undefined),
          spentMfen: 0n,
          calls: 0,
        },
      });
      return result;
    },

    bind(input, body) {
      return (ctx) => {
        const run = runs.get(input.runId);
        if (run === undefined) return body(ctx);
        return current.run(run, () => body(ctx));
      };
    },

    prompt(inner) {
      return {
        async current(appId) {
          const run = current.getStore();
          if (run === undefined) {
            // Display labels before admission: a prompt outage must not fail the request.
            try {
              return await inner.current(appId);
            } catch (error) {
              logger.warn({ app_id: appId, error_name: errorName(error) }, 'agent.prompt_unread');
              return null;
            }
          }
          if (run.exhausted) return { ...BUDGET_PROMPT };
          try {
            return await inner.current(appId);
          } catch (error) {
            logger.warn({ run_id: run.runId, error_name: errorName(error) }, 'agent.prompt_unread');
            run.exhausted = true;
            return { ...BUDGET_PROMPT };
          }
        },
      };
    },

    model: {
      async complete(input, ctx) {
        const run = current.getStore();
        if (ctx.signal.aborted) return { kind: 'aborted', attempts: [] };
        if (run === undefined || run.exhausted) {
          return { kind: 'degraded', reason: 'budget', attempts: [] };
        }
        return router.complete(input, { ...ctx, budget: run.spend });
      },
    },

    async settleFields(runId) {
      const run = runs.get(runId);
      if (run === undefined) return undefined;
      runs.delete(runId);
      let limit: bigint | undefined;
      try {
        limit = await budgetLimit();
      } catch (error) {
        logger.warn({ run_id: runId, error_name: errorName(error) }, 'agent.budget_limit_unread');
      }
      const detail = { spentMfen: run.spend.spentMfen, calls: run.spend.calls };
      return limit === undefined ? detail : { ...detail, budgetMfen: limit };
    },

    budgetLimit,
  };
}
