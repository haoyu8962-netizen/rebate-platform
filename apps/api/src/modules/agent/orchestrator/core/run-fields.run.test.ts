// B3-08t (BR-AI-19 细则「运行级字段」) on the core run: the model whose output the result used, the
// tokens of every metered call, the unchecked label of a template run, the no-model path page
// guide rejection reason. Synthetic ports only (harness as reply-templates.run.test.ts).
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RunContext } from '../../stream/run/index.ts';
import { markDegradedGuideRejected } from './degraded-intent.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from './factories.ts';
import type {
  AgentRunBodyDeps,
  OrchestratorLimits,
  OrchestratorTrace,
  ToolOutcome,
} from './ports.ts';

const OFFERED = ['search_products', 'search_rules', 'list_my_orders', 'explain_order'];

function input(): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: 'synthetic-user',
      phoneBound: true,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成问题',
    redactedText: '合成问题' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

type Event = Extract<ModelOutcome, { kind: 'model' }>['events'][number];

/** One model round: text deltas then tool calls ([name, raw JSON arguments]). */
function round(
  text: string,
  calls: readonly (readonly [string, string])[] = [],
  model = 'synthetic-model',
  usage = { input_tokens: 1, output_tokens: 1 },
  attempts: Extract<ModelOutcome, { kind: 'model' }>['attempts'] = [],
): ModelOutcome {
  const events: Event[] = [];
  if (text !== '') events.push({ t: 'text_delta', text });
  calls.forEach(([name, args], index) => {
    events.push({
      t: 'tool_call',
      index,
      call: {
        id: `call-${name}-${String(index)}`,
        type: 'function',
        function: { name, arguments: args },
      },
    });
  });
  return {
    kind: 'model',
    entryId: 'synthetic',
    model,
    usage,
    attempts,
    events,
  };
}

const DEGRADED: ModelOutcome = { kind: 'degraded', reason: 'models_failed', attempts: [] };

function rig(
  rounds: ModelOutcome[],
  answer: (name: string) => ToolOutcome,
  limits: Partial<OrchestratorLimits> = {},
) {
  const texts: string[] = [];
  const traces: OrchestratorTrace[] = [];
  const execute = vi.fn(async (call: { readonly name: string }) => answer(call.name));
  const degraded = vi.fn(async (_request: unknown, ctx: RunContext) => {
    markDegradedGuideRejected(ctx, 'disabled');
    return { kind: 'done' as const, finishReason: 'fallback' as const };
  });
  const deps: AgentRunBodyDeps = {
    model: { complete: vi.fn(async () => rounds.shift() ?? round('')) },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools: {
      definitions: async () =>
        OFFERED.map((name) => ({ name, description: 'synthetic', parameters: { type: 'object' } })),
      execute,
      enabledSearchPlatforms: async () => [],
      searchKeyword: async () => ({ results: [], cards: [] }),
    },
    inputCheck: {
      check: async () => ({
        kind: 'proceed',
        modelText: '合成问题',
        placeholders: {},
        links: [],
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      }),
    },
    degraded: { run: degraded },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => `[${key}]`, toolDisplay: async () => 'synthetic' },
    prompt: { current: async () => ({ version: 'synthetic-v1', system: 'synthetic' }) },
    limits: { ...orchestratorLimitsDefaults(), ...limits },
    traceMask: (args) => args,
    trace: { record: (_runId, trace) => traces.push(trace) },
  };
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: (text) => {
      texts.push(text);
    },
    toolStatus: () => undefined,
    card: async () => undefined,
    suggestions: () => undefined,
  };
  return {
    execute,
    degraded,
    texts,
    traces,
    run: () => createAgentRunBody(deps)(input())(ctx),
  };
}

const ORDER_TRACE: Record<string, unknown> = { orders: [], order_ids: [], lookup: 'ok' };
const ORDERS: ToolOutcome = { kind: 'ok', modelView: {}, cards: [], trace: ORDER_TRACE };

it('[AC-B3-08t#6] template run: the primary chose the order tool, the backup text is dropped → model stays the primary', async () => {
  const x = rig(
    [
      round('', [['list_my_orders', '{}']], 'synthetic-primary'),
      round('{"agent_intent":"earnings_query"}', [], 'synthetic-backup'),
    ],
    () => ORDERS,
  );
  await x.run();
  expect(x.traces[0]?.text_replaced_by_template).toBe(true);
  expect(x.traces[0]?.model).toBe('synthetic-primary');
});

it('[AC-B3-08t#1][AC-B3-08t#2] template run: the final round intent object is marked unchecked (the first tool decides)', async () => {
  const x = rig(
    [round('', [['list_my_orders', '{}']]), round('{"agent_intent":"earnings_query"}')],
    () => ORDERS,
  );
  await x.run();
  expect(x.traces[0]?.intent_unchecked).toBe(true);
  expect(x.traces[0]?.tool_calls[0]?.name).toBe('list_my_orders');
});

it('[AC-B3-08t#6] ordinary run: the model whose final text was used is the run model', async () => {
  const x = rig(
    [
      round('', [['search_products', '{}']], 'synthetic-primary'),
      round('结论。', [], 'synthetic-backup'),
    ],
    () => ({ kind: 'ok', modelView: {}, cards: [], trace: {} }),
  );
  await x.run();
  expect(x.traces[0]?.model).toBe('synthetic-backup');
  expect(x.traces[0]?.intent_unchecked).toBeUndefined();
});

it('[AC-B3-08t#10] tokens: a failed attempt the gateway metered counts once with the answer, the answering attempt not twice', async () => {
  const attempts = [
    {
      entryId: 'flash',
      result: 'malformed',
      elapsedMs: 5,
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    {
      entryId: 'plus',
      result: 'ok',
      elapsedMs: 5,
      usage: { input_tokens: 110, output_tokens: 15 },
    },
  ] as unknown as Extract<ModelOutcome, { kind: 'model' }>['attempts'];
  const x = rig(
    [round('结论。', [], 'synthetic-backup', { input_tokens: 110, output_tokens: 15 }, attempts)],
    () => ORDERS,
  );
  await x.run();
  expect(x.traces[0]?.usage).toEqual({ input_tokens: 210, output_tokens: 35 });
});

it('[AC-B3-08t#10] tokens: metered usage of a degraded call (every attempt failed) still counts', async () => {
  const failed: ModelOutcome = {
    kind: 'degraded',
    reason: 'models_failed',
    attempts: [
      {
        entryId: 'flash',
        result: 'malformed',
        elapsedMs: 5,
        usage: { input_tokens: 7, output_tokens: 3 },
      },
      { entryId: 'plus', result: 'timeout', elapsedMs: 5 },
    ] as unknown as ModelOutcome['attempts'],
  };
  const x = rig([failed], () => ORDERS);
  await x.run();
  expect(x.traces[0]?.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  expect(x.traces[0]?.degraded).toBe(true);
});

it('[AC-B3-08t#5][AC-B3-08t#10] the no-model path page guide rejection reason reaches the trace', async () => {
  const x = rig([DEGRADED], () => ORDERS);
  await x.run();
  expect(x.degraded).toHaveBeenCalledOnce();
  expect(x.traces[0]?.page_guide_reject_reason).toBe('disabled');
});
