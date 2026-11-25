import { createGovernor, GovernanceError } from '../../../platform/index.ts';
import type { Governor } from '../../../platform/index.ts';
import { assertOnlineVendor, VendorError } from '../vendors/index.ts';
import {
  assembleChunks,
  buildModelRequest,
  ModelProtocolError,
  quirksFor,
  toVendorRequest,
} from '../openai-compat/index.ts';
import type { ModelErrorKind } from '../openai-compat/index.ts';
import type { DegradeReason } from '../degraded/index.ts';
import { RunDeadlineError, withinRun } from './attempt.ts';
import { gatewayBilling } from './billing.ts';
import { budgetedRequest, chargeFor } from './budget.ts';
import type { BudgetedRequest, CallCharge } from './budget.ts';
import type {
  AttemptRecord,
  ModelOutcome,
  ModelRouter,
  ModelRouterOptions,
  RouteEntry,
  RouterChatInput,
} from './types.ts';

function failureKind(error: unknown): ModelErrorKind | 'circuit_open' {
  if (error instanceof ModelProtocolError) return error.kind;
  if (error instanceof GovernanceError) {
    if (error.code === 'timeout' || error.code === 'circuit_open') return error.code;
    return 'bad_request';
  }
  if (error instanceof VendorError) return error.code === 'aborted' ? 'aborted' : 'bad_request';
  return 'network';
}

/**
 * 成功和协议失败的用量均由网关计量；路由器只负责组装结果。
 * B3-09m：带本 run 预算时，发出的是预先按余额定好 max_tokens 的请求，用量（或结果不明时的最坏成本）
 * 计入本 run 的已花 U（budget.ts chargeFor，只计一次）。
 */
async function invoke(
  options: ModelRouterOptions,
  entry: RouteEntry,
  input: RouterChatInput,
  signal: AbortSignal,
  budgeted?: { readonly planned: BudgetedRequest; readonly charge: CallCharge },
) {
  const vendor = assertOnlineVendor(entry.vendor);
  const request =
    budgeted?.planned.request ??
    toVendorRequest(buildModelRequest({ ...input, vendor, model: entry.model }, quirksFor(vendor)));
  budgeted?.charge.dispatched();
  let response;
  try {
    response = await options.gateway.invoke(
      { ...request, vendor, purpose: 'online', dataClass: 'user_input' },
      signal,
    );
  } catch (error) {
    budgeted?.charge.failed(error);
    throw error;
  }
  budgeted?.charge.answered(response.usage);
  // 组装失败或内容拒绝时，response 已由网关计量，不得在此重复计量。
  const events = assembleChunks(response.chunks);
  if (events.some((event) => event.t === 'done' && event.reason === 'content_filter')) {
    throw new ModelProtocolError('content_refused', 'Model declined content');
  }
  return { events, usage: response.usage };
}

function validateBillable(options: ModelRouterOptions): void {
  const registered = gatewayBilling(options.gateway)?.billable;
  const declared: unknown = options.billable;
  if (declared !== undefined && typeof declared !== 'boolean') {
    throw new ModelProtocolError('bad_request', 'Router billable flag must be a boolean');
  }
  if (declared !== undefined && registered !== undefined && declared !== registered) {
    throw new ModelProtocolError('bad_request', 'Router billable flag contradicts its gateway');
  }
}

export function createModelRouter(inputOptions: ModelRouterOptions): ModelRouter {
  validateBillable(inputOptions);
  const options = {
    ...inputOptions,
    config: {
      ...inputOptions.config,
      breaker: { ...inputOptions.config.breaker },
    },
  };
  const policy = {
    timeoutMs: options.config.attemptTimeoutMs,
    retries: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    breaker: options.config.breaker,
  };
  // 立即校验配置；每条目仍有独立、持久的 Governor，不按每次调用重建。
  createGovernor('model.routing', policy, { scheduler: options.scheduler });
  const governors = new Map<string, Governor>();
  const governorFor = (id: string): Governor => {
    let governor = governors.get(id);
    if (governor === undefined) {
      governor = createGovernor(`model.${id}`, policy, { scheduler: options.scheduler });
      governors.set(id, governor);
    }
    return governor;
  };
  return {
    breakerState: (id) => governors.get(id)?.breakerState() ?? 'closed',
    async complete(input, ctx): Promise<ModelOutcome> {
      const attempts: AttemptRecord[] = [];
      const degrade = (reason: DegradeReason): ModelOutcome => ({
        kind: 'degraded',
        reason,
        attempts,
      });
      if (ctx.signal.aborted) return { kind: 'aborted', attempts };
      if (options.budgetExhausted()) return degrade('budget');
      // 后台切换仅影响下一次 complete；当前调用使用独立快照。
      const route = structuredClone(options.route());
      for (const drop of route.dropped) {
        options.onAlert?.({ kind: 'route_dropped', entryId: drop.id });
      }
      if (route.mode === 'no_model') return degrade('route_no_model');
      if (route.attempts.length === 0) return degrade('route_unavailable');
      for (const entry of route.attempts) {
        if (ctx.signal.aborted) return { kind: 'aborted', attempts };
        const remaining = ctx.clock.remainingMs();
        if (!(remaining > 0) || !Number.isFinite(remaining)) return degrade('model_timeout');
        const governor = governorFor(entry.id);
        if (governor.breakerState() === 'open') {
          attempts.push({ entryId: entry.id, result: 'circuit_open', elapsedMs: 0 });
          continue;
        }
        // B3-09m · BR-AI-16: with the run's budget, the request is priced before it goes out; a
        // model without a price is skipped, a call the remaining reservation cannot pay for (or
        // with non-text content) is not made and the run ends by budget.
        let budgeted: { planned: BudgetedRequest; charge: CallCharge } | undefined;
        const budget = ctx.budget;
        if (budget !== undefined) {
          if (budget.prices.priceOf(entry.model) === undefined) continue;
          let planned: BudgetedRequest | null | undefined;
          try {
            planned = budgetedRequest(entry, input, budget);
          } catch {
            // A request that cannot be built goes through invoke below and fails there as before
            // (never sent, so nothing is charged).
            planned = undefined;
          }
          if (planned === null) return degrade('budget');
          if (planned !== undefined) {
            budgeted = { planned, charge: chargeFor(budget, planned, options.budgetLogger) };
          }
        }
        const started = options.scheduler.now();
        let result;
        let failure: ModelErrorKind | 'circuit_open' | undefined;
        try {
          result = await governor.call(
            (signal) =>
              withinRun(
                (upstream) => invoke(options, entry, input, upstream, budgeted),
                signal,
                ctx.signal,
                options.scheduler,
                remaining < policy.timeoutMs ? remaining : Infinity,
              ),
            {
              kind: 'write',
              classify(error) {
                if (error instanceof RunDeadlineError) return 'rejected';
                const kind = failureKind(error);
                return kind === 'aborted' ||
                  kind === 'content_refused' ||
                  kind === 'auth' ||
                  kind === 'bad_request' ||
                  kind === 'model_not_pinned'
                  ? 'rejected'
                  : 'failure';
              },
            },
          );
        } catch (error) {
          failure = ctx.signal.aborted ? 'aborted' : failureKind(error);
          // Given up (timeout, cancel) before the vendor answered: the late answer is not awaited.
          budgeted?.charge.failed(error);
        } finally {
          const elapsedMs = Math.max(0, options.scheduler.now() - started);
          ctx.clock.charge(elapsedMs);
          attempts.push({ entryId: entry.id, result: failure ?? 'ok', elapsedMs });
        }
        if (ctx.signal.aborted || failure === 'aborted') return { kind: 'aborted', attempts };
        if (failure === 'content_refused') return { kind: 'refused', entryId: entry.id, attempts };
        if (failure === 'auth' || failure === 'bad_request' || failure === 'model_not_pinned') {
          options.onAlert?.({
            kind: failure === 'auth' ? 'auth' : 'bad_request',
            entryId: entry.id,
          });
          return degrade('vendor_misconfigured');
        }
        if (ctx.clock.remainingMs() <= 0) return degrade('model_timeout');
        if (result !== undefined) {
          return { kind: 'model', entryId: entry.id, model: entry.model, ...result, attempts };
        }
      }
      // B3-09m: every candidate lacked a price (none was tried): the run ends by budget.
      if (ctx.budget !== undefined && attempts.length === 0) return degrade('budget');
      return degrade('models_failed');
    },
  };
}
