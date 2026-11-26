// B3-09m · BR-AI-16 (全局日预算与成本记账, 负责人 2026-11-25 取「甲」): the stream runtime's budgeted
// model path. Built by createAgentStreamRuntime only with a model gateway (today the test seam
// AgentStreamSeams.modelRouting; the production route is still fixed to no_model, B3-03k wires
// the real one); without it nothing here runs and no budget row is touched.
// - admit(): before the admission transaction (pg/admit.ts F0, nothing held) the run's plan is
//   read: agent.daily_budget_fen / agent.budget.reserve_mfen_per_run across every app (content's
//   configValuesByKey; the smallest budget, the largest reservation), the run's app's own
//   agent.models (fresh read) and its route. B3-09o: the two platform-wide keys are read and
//   fall back on their own (D10-3187 ④): a failed budget read is a blocked plan, a failed
//   reservation read takes the BR default (5,000 mfen) with a warn alert. The run's unit prices
//   are fixed here as one snapshot of every candidate's own entry (D10-3187 ⑤; each call is
//   priced by its model's entry, never filtered by version); the price version recorded for the
//   run is the first route candidate with a usable price (D10-3193). A failed price read, or no
//   usable price, is a blocked plan: no reservation, the run ends by budget (never 50xxx), with
//   a warn alert. The run's agent.model_timeout_ms is read with the plan (BR-AI-14; a failed,
//   missing or invalid value is 8,000 ms) and starts the run's model clock (modelClock()). The transaction that
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
  createRunModelClock,
  type ModelOutcome,
  type ResolvedRoute,
  type RunCallBudget,
  type RunModelClock,
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
  /**
   * The router's per-attempt limit (the run's whole limit; one router for the runtime). Each
   * attempt is cut to what is left of the run's model clock anyway (router.ts).
   */
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
  /**
   * B3-09o · BR-AI-14: the current run's model clock, started from its app's
   * agent.model_timeout_ms read with the plan; undefined outside a run of this path.
   */
  modelClock(): RunModelClock | undefined;
}

interface PlannedRun {
  readonly plan: RunBudgetPlan;
  readonly route: ResolvedRoute;
  readonly prices: ModelPrices;
  readonly modelTimeoutMs: number;
}

interface BudgetedRun {
  readonly runId: string;
  /** No model for this run: ends by budget. */
  exhausted: boolean;
  readonly route: ResolvedRoute;
  readonly spend: RunCallBudget;
  readonly modelTimeoutMs: number;
  /** The version fixed at admission (written on the reservation and agent_runs). */
  readonly priceVersion: string | null;
  /** The (admission, priced) version pairs already logged for this run. */
  readonly versionsWarned: Set<string>;
}

const NO_MODEL: ResolvedRoute = { mode: 'no_model', attempts: [], dropped: [] };
const BUDGET_PROMPT = Object.freeze({ version: 'none', system: '' });

/** BR-AI-14 细则「无模型降级」: agent.model_timeout_ms default (as platform/resilience model.qwen). */
const DEFAULT_MODEL_TIMEOUT_MS = 8_000;
const MODEL_TIMEOUT_KEY = 'agent.model_timeout_ms';
const INT4_MAX = 2_147_483_647;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A value the config registry accepts for agent.model_timeout_ms (integer, 1 … INT4_MAX). */
function modelTimeoutOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= INT4_MAX
    ? value
    : undefined;
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

  /**
   * B3-09o (D10-3187 ④): the two keys are read on their own. A failed budget read rejects (the
   * caller fails closed); a failed reservation read takes the BR default (every app's value
   * missing: 5,000 mfen) with a warn alert. Read anew every time (no cache, D10-3193).
   */
  async function budgetConfig(runId?: string) {
    const [budgets, reserves] = await Promise.allSettled([
      configValues(BUDGET_KEYS.dailyBudgetFen),
      configValues(BUDGET_KEYS.reserveMfenPerRun),
    ]);
    if (budgets.status === 'rejected') throw budgets.reason;
    if (reserves.status === 'rejected') {
      logger.warn(
        {
          ...(runId === undefined ? {} : { run_id: runId }),
          config_key: BUDGET_KEYS.reserveMfenPerRun,
          error_name: errorName(reserves.reason),
        },
        'agent.budget_reserve_unread',
      );
    }
    const config = budgetConfigAcrossApps(
      budgets.value,
      reserves.status === 'fulfilled' ? reserves.value : [],
    );
    if (config.invalid.length > 0) {
      logger.warn({ config_keys: [...config.invalid] }, 'agent.budget_config_invalid');
    }
    return config;
  }

  /** The run's app's agent.model_timeout_ms (never rejects; any failure is the default). */
  async function modelTimeoutFor(appId: string, runId: string): Promise<number> {
    let stored: Awaited<ReturnType<BudgetedModelPathDeps['content']['freshConfigValue']>>;
    try {
      stored = await deps.content.freshConfigValue(appId, MODEL_TIMEOUT_KEY);
    } catch (error) {
      logger.warn(
        { run_id: runId, app_id: appId, error_name: errorName(error) },
        'agent.model_timeout_unread',
      );
      return DEFAULT_MODEL_TIMEOUT_MS;
    }
    if (stored === null || stored.value === null) return DEFAULT_MODEL_TIMEOUT_MS;
    const valid = modelTimeoutOf(stored.value);
    if (valid === undefined) {
      logger.warn({ run_id: runId, app_id: appId }, 'agent.model_timeout_invalid');
      return DEFAULT_MODEL_TIMEOUT_MS;
    }
    return valid;
  }

  /** The plan of one run (never rejects: any failure is a blocked plan with a warn alert). */
  async function planOf(appId: string, runId: string): Promise<PlannedRun> {
    // Not a budget verdict: read on its own, never blocks the plan (BR-AI-14).
    const modelTimeoutMs = await modelTimeoutFor(appId, runId);
    const blocked = (route: ResolvedRoute = NO_MODEL): PlannedRun => ({
      plan: { blocked: true, budgetMfen: 0n, reserveMfen: 0n, priceVersion: null },
      route,
      prices: parseModelPrices(undefined),
      modelTimeoutMs,
    });
    let config: BudgetConfig;
    try {
      config = await budgetConfig(runId);
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
      // B3-09o (D10-3187 ⑤): every candidate's own entry, as read now (one snapshot per run).
      prices: fixed === undefined ? parseModelPrices(undefined) : prices,
      modelTimeoutMs,
    };
  }

  /**
   * B3-09o (D10-3193): a call priced by an entry whose version differs from the one fixed at
   * admission (e.g. the backup after the primary failed) is logged, once per run and pair; the
   * booked values do not change. A tried attempt is one priced by its model's entry.
   */
  function warnPricedVersions(run: BudgetedRun, outcome: ModelOutcome): void {
    for (const attempt of outcome.attempts) {
      if (attempt.result === 'circuit_open') continue;
      const entry = run.route.attempts.find((one) => one.id === attempt.entryId);
      if (entry === undefined) continue;
      const priced = run.spend.prices.priceOf(entry.model)?.version;
      if (priced === undefined || priced === run.priceVersion) continue;
      const pair = JSON.stringify([run.priceVersion, priced]);
      if (run.versionsWarned.has(pair)) continue;
      run.versionsWarned.add(pair);
      logger.warn(
        {
          run_id: run.runId,
          admitted_price_version: run.priceVersion,
          priced_price_version: priced,
        },
        'agent.budget_price_version_differs',
      );
    }
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
        modelTimeoutMs: one?.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
        priceVersion: one?.plan.priceVersion ?? null,
        versionsWarned: new Set(),
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
        const outcome = await router.complete(input, { ...ctx, budget: run.spend });
        warnPricedVersions(run, outcome);
        return outcome;
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

    modelClock() {
      const run = current.getStore();
      return run === undefined ? undefined : createRunModelClock(run.modelTimeoutMs);
    },
  };
}
