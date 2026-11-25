// B3-09m · BR-AI-16 细则「一次调用最多可能花多少」「输出上限按剩余额度定」「已花 U 怎么累加」: the
// router's per-call budget check. Before a call: the request as it will be sent (with its
// max_tokens), its UTF-8 body bytes and the run's allowance (budget/index.ts callAllowance); no
// allowance, or non-text content in the request, and the call is not made (the run ends by
// budget). After it: the spend is added to the run's in-memory U exactly once.
import { callCostMfen } from '@couli/money';

import { callAllowance, type ModelPrice } from '../../budget/index.ts';
import {
  buildModelRequest,
  quirksFor,
  toVendorRequest,
  wasNotSent,
} from '../openai-compat/index.ts';
import { assertOnlineVendor, VendorError } from '../vendors/index.ts';
import type { VendorRequest, VendorUsage } from '../vendors/index.ts';
import type { RouteEntry, RouterChatInput, RunCallBudget } from './types.ts';

/** At most this many rounds to settle max_tokens against the body bytes it changes. */
const FIT_ROUNDS = 6;

export interface BudgetedRequest {
  readonly request: VendorRequest;
  readonly worstMfen: bigint;
  readonly price: ModelPrice;
}

function utf8Bytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

/** Every message content is a string, null, or a list of `{type: 'text'}` parts only. */
export function textOnlyBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  return messages.every((message: unknown) => {
    if (typeof message !== 'object' || message === null) return false;
    const content = (message as { content?: unknown }).content;
    if (content === null || content === undefined || typeof content === 'string') return true;
    if (!Array.isArray(content)) return false;
    return content.every(
      (part: unknown) =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
    );
  });
}

function requestWith(entry: RouteEntry, input: RouterChatInput, maxTokens: number): VendorRequest {
  const vendor = assertOnlineVendor(entry.vendor);
  return toVendorRequest(
    buildModelRequest(
      {
        ...input,
        sampling: { ...input.sampling, max_tokens: maxTokens },
        vendor,
        model: entry.model,
      },
      quirksFor(vendor),
    ),
  );
}

/**
 * The request to send for `entry` under the run's budget, or null when the call must not be made
 * (no price for the model, non-text content, or nothing the remaining reservation can pay for).
 * max_tokens is part of the body it bounds, so M and the body bytes are settled together: M is the
 * fixed point M = allowance(bytes(body with M)) when there is one, else the largest M tried whose
 * own body still allows it. W = ceil(bytes × in / 1e6) + ceil(M × out / 1e6) ≤ R − U.
 * Request build errors propagate (the caller treats them as before: a misconfigured request).
 */
export function budgetedRequest(
  entry: RouteEntry,
  input: RouterChatInput,
  budget: RunCallBudget,
): BudgetedRequest | null {
  const price = budget.prices.priceOf(entry.model);
  if (price === undefined) return null;
  const configured = input.sampling?.max_tokens;
  const allowanceAt = (bytes: number) =>
    callAllowance({
      reserveMfen: budget.reserveMfen,
      spentMfen: budget.spentMfen,
      requestBytes: bytes,
      inMfenPerM: price.inMfenPerM,
      outMfenPerM: price.outMfenPerM,
      ...(configured === undefined ? {} : { configuredMaxTokens: configured }),
    });
  // The first try uses the configured cap (or the smallest useful one: fewest body bytes).
  let candidate = configured ?? 256;
  let best: { request: VendorRequest; bytes: number; maxTokens: number } | null = null;
  for (let round = 0; round < FIT_ROUNDS; round += 1) {
    const request = requestWith(entry, input, candidate);
    if (!textOnlyBody(request.body)) return null;
    const bytes = utf8Bytes(request.body);
    const allowance = allowanceAt(bytes);
    if (allowance === null) break;
    if (allowance.maxTokens >= candidate && (best === null || candidate > best.maxTokens)) {
      best = { request, bytes, maxTokens: candidate };
    }
    if (allowance.maxTokens === candidate) break;
    candidate = allowance.maxTokens;
  }
  if (best === null) return null;
  return {
    request: best.request,
    worstMfen: callCostMfen(
      BigInt(best.bytes),
      BigInt(best.maxTokens),
      price.inMfenPerM,
      price.outMfenPerM,
    ),
    price,
  };
}

function usageCost(usage: unknown, price: ModelPrice): bigint | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const { input_tokens: input, output_tokens: output } = usage as Partial<VendorUsage>;
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  ) {
    return null;
  }
  return callCostMfen(BigInt(input), BigInt(output), price.inMfenPerM, price.outMfenPerM);
}

/** One call's charge to the run's U, applied at most once (whichever end comes first). */
export interface CallCharge {
  /** The request is about to be handed to the gateway. */
  dispatched(): void;
  /** The gateway answered with usage (success or a response that failed later). */
  answered(usage: unknown): void;
  /**
   * The call failed or was given up on: by its usage when known, else W if it was sent (a
   * VendorError or an error the transport marked as raised before fetch was never sent).
   */
  failed(error: unknown): void;
}

export function chargeFor(
  budget: RunCallBudget,
  planned: BudgetedRequest,
  logger?: { warn(obj: object, msg: string): void },
): CallCharge {
  let dispatched = false;
  let done = false;
  const add = (cost: bigint) => {
    done = true;
    budget.spentMfen += cost;
    budget.calls += 1;
  };
  const byUsage = (usage: unknown): boolean => {
    const cost = usageCost(usage, planned.price);
    if (cost === null) return false;
    if (cost > planned.worstMfen) {
      // 细则: the premise failed; booked as reported, not capped, one warn line.
      logger?.warn(
        { cost_mfen: cost.toString(), worst_mfen: planned.worstMfen.toString() },
        'agent.budget_usage_over_worst',
      );
    }
    add(cost);
    return true;
  };
  return {
    dispatched() {
      dispatched = true;
    },
    answered(usage) {
      if (done) return;
      if (!byUsage(usage)) add(planned.worstMfen);
    },
    failed(error) {
      if (done) return;
      const usage =
        typeof error === 'object' && error !== null ? (error as { usage?: unknown }).usage : null;
      if (byUsage(usage)) return;
      // Never sent, not charged: the gateway refuses before the transport with VendorError, or
      // the transport failed before handing the request to its HTTP client (B3-09o: wasNotSent).
      if (!dispatched || error instanceof VendorError || wasNotSent(error)) {
        done = true;
        return;
      }
      add(planned.worstMfen);
    },
  };
}
