// B3-09m · BR-AI-16: the router's per-call budget (budget.ts). Synthetic gateway, no network.
import { expect, it, vi } from 'vitest';

import type { Scheduler } from '../../../platform/index.ts';
import { parseModelPrices } from '../../budget/index.ts';
import {
  createHttpTransport,
  markNotSent,
  ModelProtocolError,
  quirksFor,
} from '../openai-compat/index.ts';
import { VendorError, type VendorGateway, type VendorResponse } from '../vendors/index.ts';
import { budgetedRequest, chargeFor, textOnlyBody } from './budget.ts';
import { createModelRouter } from './router.ts';
import type { ModelRouterOptions, RouteEntry, RouterChatInput, RunCallBudget } from './types.ts';

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
  // B3-09o: a later event without usage leaves the W booking (late usage corrects it: #u12–#u17).
  unknown.answered(undefined);
  expect(run).toMatchObject({ spentMfen: planned.worstMfen, calls: 1 });
});

it('[AC-B3-09m#u15] 余额放不下或含非文本内容时不出请求', () => {
  expect(budgetedRequest(entry, chat, budget(100n))).toBeNull();
  expect(textOnlyBody({ messages: [{ role: 'user', content: 'x' }] })).toBe(true);
  expect(
    textOnlyBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }),
  ).toBe(false);
});

it('[AC-B3-09o#u4] 传输层在 fetch 之前失败（凭据读不到）不计入 U；fetch 之后结果不明仍按最坏成本计', async () => {
  const fetch = vi.fn(() => Promise.reject(new Error('synthetic network down')));
  let key: () => string = () => {
    throw new Error('synthetic credential rotation');
  };
  const transport = createHttpTransport({
    vendor: 'qwen',
    baseUrl: 'https://synthetic-model.invalid/compatible-mode/v1',
    apiKey: () => key(),
    fetch,
    quirks: quirksFor('qwen'),
  });
  const gateway: VendorGateway = { invoke: (call, signal) => transport.send(call, signal) };
  const unsent = budget();
  const first = await router(gateway).complete(chat, ctx(unsent));
  expect(fetch).not.toHaveBeenCalled();
  expect(first).toMatchObject({ kind: 'degraded', reason: 'vendor_misconfigured' });
  expect(unsent).toMatchObject({ spentMfen: 0n, calls: 0 });
  key = () => 'synthetic-key';
  const sent = budget();
  const planned = budgetedRequest(entry, chat, sent)!;
  await router(gateway).complete(chat, ctx(sent));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sent).toMatchObject({ spentMfen: planned.worstMfen, calls: 1 });
});

// B3-09o · money review r1 S0 (D10-3330): one call booked at W is rebooked once by its usage when
// that arrives later (router timeout branch first, transport's usage-carrying error after).
// Synthetic prices: 2,000 in + 300 out = 200 + 120 = 320 mfen; W of this request is the whole 5,000.
const USAGE = { input_tokens: 2_000, output_tokens: 300 } as const;
const timedOut = () => new ModelProtocolError('timeout', 'synthetic timeout');
const abortedWithUsage = (usage: { input_tokens: number; output_tokens: number } = USAGE) =>
  new ModelProtocolError('aborted', 'synthetic abort', { usage });

function sentCharge(run: RunCallBudget, warn = vi.fn()) {
  const planned = budgetedRequest(entry, chat, run)!;
  const charge = chargeFor(run, planned, { warn });
  charge.dispatched();
  return { planned, charge, warn };
}

it('[AC-B3-09o#u12] 先到不带用量的超时错、后到带用量的错：改按用量记，calls 只计 1', () => {
  const run = budget();
  const { planned, charge } = sentCharge(run);
  charge.failed(timedOut());
  expect(run).toMatchObject({ spentMfen: planned.worstMfen, calls: 1 });
  charge.failed(abortedWithUsage());
  expect(planned.worstMfen).toBeGreaterThan(320n);
  expect(run).toMatchObject({ spentMfen: 320n, calls: 1 });
});

it('[AC-B3-09o#u13] 先到带用量的错、后到不带用量的超时错：仍按用量记，calls 1', () => {
  const run = budget();
  const { charge } = sentCharge(run);
  charge.failed(abortedWithUsage());
  charge.failed(timedOut());
  charge.answered(undefined);
  expect(run).toMatchObject({ spentMfen: 320n, calls: 1 });
});

it('[AC-B3-09o#u14] 按 W 记之后：不带用量的事件不改；用量只改一次，之后再来的用量不再改', () => {
  const run = budget();
  const { planned, charge, warn } = sentCharge(run);
  charge.failed(timedOut());
  charge.answered(undefined);
  charge.failed(new Error('synthetic late network'));
  charge.answered({ input_tokens: -1, output_tokens: 3 });
  expect(run).toMatchObject({ spentMfen: planned.worstMfen, calls: 1 });
  charge.answered(USAGE);
  expect(run).toMatchObject({ spentMfen: 320n, calls: 1 });
  charge.answered(USAGE);
  charge.failed(abortedWithUsage({ input_tokens: 10, output_tokens: 10 }));
  charge.answered({ input_tokens: 40_000, output_tokens: 40_000 });
  expect(run).toMatchObject({ spentMfen: 320n, calls: 1 });
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B3-09o#u15] 按 W 记之后晚到的用量成本高于 W：照实记不封顶，并打一条告警日志', () => {
  const run = budget();
  const { planned, charge, warn } = sentCharge(run);
  charge.failed(timedOut());
  // 50,000 in + 50,000 out = 5,000 + 20,000 = 25,000 mfen > W.
  charge.failed(abortedWithUsage({ input_tokens: 50_000, output_tokens: 50_000 }));
  expect(planned.worstMfen).toBeLessThan(25_000n);
  expect(run).toMatchObject({ spentMfen: 25_000n, calls: 1 });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      cost_mfen: '25000',
      worst_mfen: planned.worstMfen.toString(),
      late: true,
    }),
    'agent.budget_usage_over_worst',
  );
});

it('[AC-B3-09o#u16] 没发出（VendorError、传输层登记的未发出错、未交给网关）之后再来用量：不计', () => {
  const vendorRefused = budget();
  const a = sentCharge(vendorRefused).charge;
  a.failed(new VendorError('purpose_not_registered', 'synthetic'));
  a.failed(abortedWithUsage());
  a.answered(USAGE);
  expect(vendorRefused).toMatchObject({ spentMfen: 0n, calls: 0 });

  const transportUnsent = budget();
  const b = sentCharge(transportUnsent).charge;
  const unsent = new Error('synthetic credential rotation');
  markNotSent(unsent);
  b.failed(unsent);
  b.answered(USAGE);
  b.failed(abortedWithUsage());
  expect(transportUnsent).toMatchObject({ spentMfen: 0n, calls: 0 });

  const neverDispatched = budget();
  const c = chargeFor(neverDispatched, budgetedRequest(entry, chat, neverDispatched)!);
  c.failed(new Error('synthetic build failure'));
  c.answered(USAGE);
  expect(neverDispatched).toMatchObject({ spentMfen: 0n, calls: 0 });
});

it('[AC-B3-09o#u17] 经路由：单次时限先由路由超时分支按 W 记，传输层随后带用量拒绝，改按用量记；下一次（备用模型）按改后的余额定输出上限', async () => {
  const PLUS: RouteEntry = { ...entry, id: 'plus', tier: 'plus', model: 'qwen-plus-2026-09-01' };
  const run: RunCallBudget = {
    reserveMfen: 5_000n,
    spentMfen: 0n,
    calls: 0,
    prices: parseModelPrices({
      [MODEL]: { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'synthetic-v1' },
      [PLUS.model]: { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'synthetic-v1' },
    }),
  };
  // The governor's per-call timer is the only sleep (run time left 8,000 > 3,000): fired by hand.
  const timers: Array<() => void> = [];
  const scheduler: Scheduler = {
    now: () => 0,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        timers.push(resolve);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  };
  // Flash hangs; once aborted it holds its usage-carrying rejection until the test releases it.
  let releaseLate: (() => void) | undefined;
  const invoke = vi.fn<VendorGateway['invoke']>((call, signal) => {
    if (call.model === PLUS.model) return Promise.resolve(response(20, 10));
    return new Promise<VendorResponse>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          releaseLate = () => reject(abortedWithUsage());
        },
        { once: true },
      );
    });
  });
  let attempts: RouteEntry[] = [entry];
  const options: ModelRouterOptions = {
    gateway: { invoke },
    route: () => ({ mode: 'models', attempts, dropped: [] }),
    budgetExhausted: () => false,
    config: {
      attemptTimeoutMs: 3_000,
      breaker: { windowMs: 10_000, minRequests: 1_000, failureRatePercent: 99, openMs: 1_000 },
    },
    scheduler,
    meter: { record: () => undefined },
    clock: { now: () => new Date('2026-10-07T01:02:03.000Z') },
    budgetLogger: { warn: vi.fn() },
  };
  const flashW = budgetedRequest(entry, chat, run)!.worstMfen;
  const modelRouter = createModelRouter(options);
  const pending = modelRouter.complete(chat, ctx(run));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(timers).toHaveLength(1);
  timers[0]!();
  const first = await pending;
  // Order is fixed by construction: the vendor's rejection does not exist until releaseLate runs,
  // so the router's timeout branch has settled the call at W first.
  expect(first).toMatchObject({ kind: 'degraded', reason: 'models_failed' });
  expect(run).toMatchObject({ spentMfen: flashW, calls: 1 });
  expect(flashW).toBeGreaterThan(320n);
  expect(releaseLate).toBeDefined();
  releaseLate!();
  await vi.waitFor(() => expect(run.spentMfen).toBe(320n));
  expect(run.calls).toBe(1);

  attempts = [PLUS];
  const second = await modelRouter.complete(chat, ctx(run));
  expect(second).toMatchObject({ kind: 'model', entryId: 'plus' });
  const body = invoke.mock.calls[1]![0].body as { max_tokens: number };
  const bytes = BigInt(Buffer.byteLength(JSON.stringify(body), 'utf8'));
  // M = floor((R − U − ceil(bytes × 100,000 / 1e6)) × 1e6 / 400,000) with U = 320.
  expect(body.max_tokens).toBe(Number(((5_000n - 320n - (bytes + 9n) / 10n) * 5n) / 2n));
  expect(run).toMatchObject({ spentMfen: 326n, calls: 2 });
});
