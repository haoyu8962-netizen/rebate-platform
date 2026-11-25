// B3-09m · BR-AI-16: the router's per-call budget (budget.ts). Synthetic gateway, no network.
import { expect, it, vi } from 'vitest';

import type { Scheduler } from '../../../platform/index.ts';
import { parseModelPrices } from '../../budget/index.ts';
import { VendorError, type VendorGateway, type VendorResponse } from '../vendors/index.ts';
import { budgetedRequest, chargeFor, textOnlyBody } from './budget.ts';
import { createModelRouter } from './router.ts';
import type { RouteEntry, RouterChatInput, RunCallBudget } from './types.ts';

const MODEL = 'qwen-flash-2026-09-01';
const entry: RouteEntry = {
  id: 'flash',
  vendor: 'qwen',
  tier: 'flash',
  model: MODEL,
  evaluation: { report: 'reports/synthetic.md', signed: true },
};
const chat: RouterChatInput = {
  system: '合成系统前缀',
  tools: [],
  messages: [{ role: 'user', content: '合成：找保温杯' }],
};

function budget(reserveMfen = 5_000n): RunCallBudget {
  return {
    reserveMfen,
    spentMfen: 0n,
    calls: 0,
    prices: parseModelPrices({
      [MODEL]: { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'synthetic-v1' },
    }),
  };
}

function response(input: number, output: number): VendorResponse {
  return {
    chunks: [
      { choices: [{ index: 0, delta: { content: '合成回答' } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: input, completion_tokens: output },
      },
    ],
    usage: { input_tokens: input, output_tokens: output },
  };
}

function router(gateway: VendorGateway, warn = vi.fn()) {
  // Time never advances: no timeout fires; a cancelled wait rejects as the interface says.
  const scheduler: Scheduler = {
    now: () => 0,
    sleep: (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  };
  return createModelRouter({
    gateway,
    route: () => ({ mode: 'models', attempts: [entry], dropped: [] }),
    budgetExhausted: () => false,
    config: {
      attemptTimeoutMs: 3_000,
      breaker: { windowMs: 10_000, minRequests: 1_000, failureRatePercent: 99, openMs: 1_000 },
    },
    scheduler,
    meter: { record: () => undefined },
    clock: { now: () => new Date('2026-10-07T01:02:03.000Z') },
    budgetLogger: { warn },
  });
}

function ctx(run: RunCallBudget) {
  return {
    clock: { remainingMs: () => 8_000, charge: () => undefined },
    signal: new AbortController().signal,
    budget: run,
  };
}

it('[AC-B3-09m#u12] 厂商回报的用量超过最坏成本时照实累加并打一条告警日志', async () => {
  const run = budget();
  const planned = budgetedRequest(entry, chat, run)!;
  const warn = vi.fn();
  // 50,000 in + 50,000 out costs 5,000 + 20,000 = 25,000 mfen, far above W.
  const gateway: VendorGateway = { invoke: vi.fn(async () => response(50_000, 50_000)) };
  const outcome = await router(gateway, warn).complete(chat, ctx(run));
  expect(outcome.kind).toBe('model');
  expect(run).toMatchObject({ spentMfen: 25_000n, calls: 1 });
  expect(planned.worstMfen).toBeLessThan(25_000n);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ cost_mfen: '25000' }),
    'agent.budget_usage_over_worst',
  );
});

it('[AC-B3-09m#u13] 请求带上按余额定的 max_tokens，正常用量不告警', async () => {
  const run = budget();
  const warn = vi.fn();
  const invoke = vi.fn<VendorGateway['invoke']>(async () => response(20, 10));
  await router({ invoke }, warn).complete(chat, ctx(run));
  const body = invoke.mock.calls[0]![0].body as { max_tokens: number };
  const bytes = BigInt(Buffer.byteLength(JSON.stringify(body), 'utf8'));
  expect(body.max_tokens).toBe(Number(((5_000n - (bytes + 9n) / 10n) * 5n) / 2n));
  expect(run).toMatchObject({ spentMfen: 6n, calls: 1 });
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B3-09m#u14] 网关在发出前拒绝（VendorError）不计；发出后结果不明按最坏成本计', () => {
  const run = budget();
  const planned = budgetedRequest(entry, chat, run)!;
  const refused = chargeFor(run, planned);
  refused.dispatched();
  refused.failed(new VendorError('purpose_not_registered', 'synthetic'));
  expect(run).toMatchObject({ spentMfen: 0n, calls: 0 });
  const unknown = chargeFor(run, planned);
  unknown.dispatched();
  unknown.failed(new Error('synthetic network'));
  unknown.answered({ input_tokens: 1, output_tokens: 1 });
  expect(run).toMatchObject({ spentMfen: planned.worstMfen, calls: 1 });
});

it('[AC-B3-09m#u15] 余额放不下或含非文本内容时不出请求', () => {
  expect(budgetedRequest(entry, chat, budget(100n))).toBeNull();
  expect(textOnlyBody({ messages: [{ role: 'user', content: 'x' }] })).toBe(true);
  expect(
    textOnlyBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }),
  ).toBe(false);
});
