// B3-09o · BR-AI-16 / BR-AI-14: a budgeted run's model calls on the budgeted model path
// (./budget.ts). The admission transaction is not run here (no database): its verdict for the
// accepted run is stubbed (pg/admit.ts budgetVerdictOf), everything else is the real path, router
// and per-call budget. Synthetic ports and a virtual scheduler only (no listen, no network).
import { expect, it, vi } from 'vitest';

import type { Scheduler } from '../../../platform/index.ts';
import type { RunBodyInput } from '../../http/index.ts';
import { ModelProtocolError } from '../../model-gateway/openai-compat/index.ts';
import type { ModelOutcome, ResolvedRoute, RouteEntry } from '../../model-gateway/routing/index.ts';
import type { VendorGateway, VendorResponse } from '../../model-gateway/vendors/index.ts';
import type { AdmissionRequest, AdmissionResult } from '../admission/index.ts';
import type { RunBudgetPlan, RunBudgetVerdict } from '../pg/admit.ts';
import type { RunContext } from '../run/index.ts';
import { createBudgetedModelPath } from './budget.ts';

const verdict = vi.hoisted(() => ({ current: undefined as RunBudgetVerdict | undefined }));
vi.mock('../pg/admit.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pg/admit.ts')>();
  return { ...actual, budgetVerdictOf: () => verdict.current };
});

const DAILY = 'agent.daily_budget_fen';
const MODELS = 'agent.models';
const TIMEOUT = 'agent.model_timeout_ms';
const FLASH = 'qwen-flash-2026-09-01';
const PLUS = 'qwen-plus-2026-09-01';

function entry(id: 'flash' | 'plus', model: string): RouteEntry {
  return {
    id,
    vendor: 'qwen',
    tier: id,
    model,
    evaluation: { report: 'reports/synthetic.md', signed: true },
  };
}

const ROUTE: ResolvedRoute = {
  mode: 'models',
  attempts: [entry('flash', FLASH), entry('plus', PLUS)],
  dropped: [],
};

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

/** A scheduler whose time only moves in advance(): sleeps resolve in due order. */
function virtualTime() {
  let now = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const scheduler: Scheduler = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = { at: now + ms, resolve };
        timers.push(timer);
        signal?.addEventListener(
          'abort',
          () => {
            const index = timers.indexOf(timer);
            if (index >= 0) timers.splice(index, 1);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  async function advance(to: number): Promise<void> {
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > to) break;
      timers.shift();
      now = next.at;
      next.resolve();
    }
    now = to;
  }
  return { scheduler, advance };
}

interface Options {
  readonly gateway: VendorGateway;
  readonly prices: Record<string, unknown>;
  readonly timeout?: () => Promise<unknown>;
  readonly scheduler?: Scheduler;
}

function path(options: Options) {
  const warn = vi.fn();
  const built = createBudgetedModelPath({
    gateway: options.gateway,
    route: async () => ROUTE,
    content: {
      async configValuesByKey(key) {
        return [{ appId: 'synthetic-app', value: key === DAILY ? 100 : 5_000 }];
      },
      async freshConfigValue(_appId, key) {
        if (key === MODELS) return { value: options.prices as never, version: 1 };
        if (key === TIMEOUT) {
          if (options.timeout === undefined) return null;
          return { value: (await options.timeout()) as never, version: 1 };
        }
        throw new Error(`synthetic: unexpected key ${key}`);
      },
    },
    clock: { now: () => new Date('2026-10-06T12:00:00+08:00') },
    scheduler: options.scheduler ?? {
      now: () => 0,
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    },
    logger: { warn } as never,
    attemptTimeoutMs: 20_000,
  });
  return { built, warn };
}

const request = { runId: 'synthetic-run', sessionId: 'synthetic-session' } as AdmissionRequest;

/** Admits the run with a reservation (the stubbed verdict of the admission transaction). */
async function admitted(built: ReturnType<typeof path>['built']): Promise<RunBudgetPlan> {
  let plan: RunBudgetPlan | undefined;
  await built.admit(request, async (budgeted) => {
    plan = await budgeted.budget!.plan('synthetic-app');
    verdict.current = { exhausted: false, reserved: true, plan };
    return { kind: 'accepted' } as AdmissionResult;
  });
  verdict.current = undefined;
  return plan!;
}

function inRun<T>(built: ReturnType<typeof path>['built'], work: () => Promise<T>): Promise<T> {
  let value: T | undefined;
  const body = built.bind({ runId: 'synthetic-run' } as RunBodyInput, async () => {
    value = await work();
    return { kind: 'done', finishReason: 'stop' };
  });
  return body({} as RunContext).then(() => value as T);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** W of one sent request (BR-AI-16 细则「一次调用最多可能花多少」) at the given prices. */
function worstOf(body: unknown, inPrice: bigint, outPrice: bigint): bigint {
  const bytes = BigInt(Buffer.byteLength(JSON.stringify(body), 'utf8'));
  const maxTokens = BigInt((body as { max_tokens: number }).max_tokens);
  return ceilDiv(bytes * inPrice, 1_000_000n) + ceilDiv(maxTokens * outPrice, 1_000_000n);
}

const chat = {
  system: '合成系统前缀',
  tools: [],
  messages: [{ role: 'user' as const, content: '合成：找保温杯' }],
};

it('[AC-B3-09o#u9] 主备单价版本不同：主模型失败后备用按它自己的单价调用并计价，版本差异同一 run 只告警一次', async () => {
  const invoke = vi.fn<VendorGateway['invoke']>(async (call) => {
    if (call.model === FLASH) {
      // Usage reported, then the stream failed: 2,000 in + 300 out at Flash's price = 320.
      throw new ModelProtocolError('server', 'synthetic', {
        status: 503,
        usage: { input_tokens: 2_000, output_tokens: 300 },
      });
    }
    // 1,000 in + 100 out at Plus's own price: 200 + 60 = 260.
    return response(1_000, 100);
  });
  const { built, warn } = path({
    gateway: { invoke },
    prices: {
      [FLASH]: { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'v1' },
      [PLUS]: { in_mfen_per_m: 200_000, out_mfen_per_m: 600_000, version: 'v2' },
    },
  });
  const plan = await admitted(built);
  expect(plan).toEqual({
    blocked: false,
    budgetMfen: 100_000n,
    reserveMfen: 5_000n,
    priceVersion: 'v1',
  });
  const outcomes = await inRun(built, async () => {
    const clock = { remainingMs: () => 8_000, charge: () => undefined };
    const signal = new AbortController().signal;
    const first = await built.model.complete(chat, { clock, signal });
    const second = await built.model.complete(chat, { clock, signal });
    return [first, second] as ModelOutcome[];
  });
  for (const outcome of outcomes) expect(outcome).toMatchObject({ kind: 'model', model: PLUS });
  expect(invoke.mock.calls.map(([call]) => call.model)).toEqual([FLASH, PLUS, FLASH, PLUS]);
  // The backup's request is bounded by its own output price (M = floor(Rem × 1e6 / 600,000)).
  const plusBody = invoke.mock.calls[1]![0].body as { max_tokens: number };
  const plusBytes = BigInt(Buffer.byteLength(JSON.stringify(plusBody), 'utf8'));
  const plusIn = ceilDiv(plusBytes * 200_000n, 1_000_000n);
  expect(plusBody.max_tokens).toBe(Number(((5_000n - 320n - plusIn) * 1_000_000n) / 600_000n));
  expect(await built.settleFields('synthetic-run')).toMatchObject({ spentMfen: 1_160n, calls: 4 });
  const versionWarns = warn.mock.calls.filter(
    ([, msg]) => msg === 'agent.budget_price_version_differs',
  );
  expect(versionWarns).toEqual([
    [
      { run_id: 'synthetic-run', admitted_price_version: 'v1', priced_price_version: 'v2' },
      'agent.budget_price_version_differs',
    ],
  ]);
});

it('[AC-B3-09o#u10] 本 run 的模型累计时钟取本 app 的 agent.model_timeout_ms：缺、读失败、非法都用 8,000', async () => {
  const prices = { [FLASH]: { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'v1' } };
  const gateway = { invoke: vi.fn() };
  const cases: { timeout?: () => Promise<unknown>; ms: number; warned?: string }[] = [
    { ms: 8_000 },
    { timeout: async () => 3_000, ms: 3_000 },
    { timeout: async () => 0, ms: 8_000, warned: 'agent.model_timeout_invalid' },
    {
      timeout: () => Promise.reject(new Error('synthetic read failure')),
      ms: 8_000,
      warned: 'agent.model_timeout_unread',
    },
  ];
  for (const one of cases) {
    const { built, warn } = path({
      gateway,
      prices,
      ...(one.timeout === undefined ? {} : { timeout: one.timeout }),
    });
    expect(built.modelClock()).toBeUndefined();
    const plan = await admitted(built);
    // The timeout read never changes the budget verdict.
    expect(plan).toMatchObject({ blocked: false, priceVersion: 'v1' });
    const remaining = await inRun(built, async () => built.modelClock()?.remainingMs());
    expect(remaining).toBe(one.ms);
    const messages = warn.mock.calls.map(([, msg]) => msg as string);
    if (one.warned === undefined) expect(messages).toEqual([]);
    else expect(messages).toEqual([one.warned]);
  }
});

it('[AC-B3-09o#u11] 默认 8,000 毫秒：模型第 10 秒才答，这次不采用并走无模型降级；已发出、结果不明按 W 计', async () => {
  const time = virtualTime();
  const invoke = vi.fn<VendorGateway['invoke']>((_call, signal) =>
    time.scheduler.sleep(10_000, signal).then(() => response(2_000, 300)),
  );
  const { built } = path({
    gateway: { invoke },
    prices: { [FLASH]: { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'v1' } },
    scheduler: time.scheduler,
  });
  await admitted(built);
  const pending = inRun(built, async () => {
    const clock = built.modelClock()!;
    const outcome = await built.model.complete(chat, {
      clock,
      signal: new AbortController().signal,
    });
    return { outcome, remaining: clock.remainingMs() };
  });
  await time.advance(20_000);
  const { outcome, remaining } = await pending;
  // Only the first entry was tried: the run's model time was used up at 8 s.
  expect(outcome).toMatchObject({ kind: 'degraded', reason: 'model_timeout' });
  expect(remaining).toBe(0);
  expect(invoke).toHaveBeenCalledTimes(1);
  const body = invoke.mock.calls[0]![0].body;
  expect(await built.settleFields('synthetic-run')).toMatchObject({
    spentMfen: worstOf(body, 100_000n, 400_000n),
    calls: 1,
  });
});
