// B3-08m gate review follow-ups (S1-1, S1-2, S2-a, S2-b) on the core run: synthetic ports only.
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
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
function round(text: string, calls: readonly (readonly [string, string])[] = []): ModelOutcome {
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
    model: 'synthetic-model',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [],
    events,
  };
}

const DEGRADED: ModelOutcome = { kind: 'degraded', reason: 'models_failed', attempts: [] };

const card: UnnumberedCard = {
  type: 'handoff',
  schema_version: 1,
  data: { text_key: 'agent.handoff.default', actions: [] },
  fallback_text: '合成',
};

function rig(
  rounds: ModelOutcome[],
  answer: (name: string) => ToolOutcome,
  limits: Partial<OrchestratorLimits> = {},
) {
  const texts: string[] = [];
  const traces: OrchestratorTrace[] = [];
  const execute = vi.fn(async (call: { readonly name: string }) => answer(call.name));
  const degraded = vi.fn(async () => ({
    kind: 'done' as const,
    finishReason: 'fallback' as const,
  }));
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

const ok = (trace: Record<string, unknown>, cards: UnnumberedCard[] = []): ToolOutcome => ({
  kind: 'ok',
  modelView: {},
  cards,
  trace,
});
const FAILED: ToolOutcome = { kind: 'failed', modelView: { error: 'tool_failed' } };
const REJECTED: ToolOutcome = { kind: 'rejected', modelView: { error: 'invalid_args' } };

it('[AC-B3-08m#1] gate S1-1: search_rules failed without a card, then the router degrades → no degraded path, only agent.rule.not_found, done stop', async () => {
  const x = rig([round('', [['search_rules', '{"question":"q"}']]), DEGRADED], () => FAILED);
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.degraded).not.toHaveBeenCalled();
  expect(x.texts).toEqual(['[agent.rule.not_found]']);
  expect(x.traces[0]?.text_replaced_by_template).toBe(true);
});

it('[AC-B3-08m#3] gate S1-1: explain_order rate_limited without a card, then structured text → no degraded path, only agent.order.lookup_limited, done stop', async () => {
  const x = rig(
    [round('', [['explain_order', '{"order_no":"1"}']]), round('{"type":"order_status"}')],
    () => ok({ orders: [], order_ids: [], lookup: 'rate_limited' }),
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.degraded).not.toHaveBeenCalled();
  expect(x.texts).toEqual(['[agent.order.lookup_limited]']);
  expect(x.traces[0]?.model_format_invalid).toBe(true);
});

it('[AC-B3-08m#1] gate S1-1: a template run whose next tool round is structured text also ends with the template, never the degraded path', async () => {
  const x = rig(
    [round('', [['search_rules', '{}']]), round('[1,2]', [['search_products', '{}']])],
    () => FAILED,
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.degraded).not.toHaveBeenCalled();
  expect(x.texts).toEqual(['[agent.rule.not_found]']);
});

it('[AC-B3-08m#1] gate S1-2: search_rules rejected by the registry (invalid_args, e.g. app_id in the arguments) → later model text dropped, agent.rule.not_found, trace replaced', async () => {
  const x = rig(
    [round('我先看看。', [['search_rules', '{"question":"q","app_id":"x"}']]), round('结论。')],
    () => REJECTED,
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.execute).toHaveBeenCalledTimes(1);
  expect(x.texts).toEqual(['[agent.rule.not_found]']);
  expect(x.traces[0]?.text_replaced_by_template).toBe(true);
});

it('[AC-B3-08m#3] gate S1-2: list_my_orders with unparseable JSON arguments (core rejection, no execute) → later model text dropped, order_list.empty, trace replaced', async () => {
  const x = rig([round('我先看看。', [['list_my_orders', '{not json']]), round('结论。')], () =>
    ok({}),
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.execute).not.toHaveBeenCalled();
  expect(x.texts).toEqual(['[order_list.empty]']);
  expect(x.traces[0]?.text_replaced_by_template).toBe(true);
});

it('[AC-B3-08m#4] gate S2-a: template tools offered, only search_products, last round still asks for tools → model text as is, done limit', async () => {
  const x = rig(
    [round('甲。', [['search_products', '{}']]), round('乙。', [['search_products', '{}']])],
    () => ok({}, [card]),
    { modelRounds: 2 },
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.texts).toEqual(['甲。', '乙。']);
  expect(x.traces[0]?.text_replaced_by_template).toBeUndefined();
});

it('[AC-B3-08m#4] gate S2-a: template tools offered, only search_products, tool call budget spent → model text as is, done limit', async () => {
  const x = rig(
    [
      round('甲。', [
        ['search_products', '{}'],
        ['search_products', '{}'],
      ]),
    ],
    () => ok({}, [card]),
    { toolCalls: 1 },
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.execute).toHaveBeenCalledTimes(1);
  expect(x.texts).toEqual(['甲。']);
});

it('[AC-B3-08m#4] gate S2-a: template tools offered, search_products without cards then the router degrades → text already answered ends stop as before; without text it degrades as before', async () => {
  const withText = rig([round('甲。', [['search_products', '{}']]), DEGRADED], () => ok({}));
  expect(await withText.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(withText.degraded).not.toHaveBeenCalled();
  expect(withText.texts).toEqual(['甲。']);

  const silent = rig([round('', [['search_products', '{}']]), DEGRADED], () => ok({}));
  expect(await silent.run()).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(silent.degraded).toHaveBeenCalledTimes(1);
  expect(silent.texts).toEqual([]);
});

it('[AC-B3-08m#3] gate S2-b: list_my_orders finds one order (WAITING), then explain_order of the same order → counted once: order_status.WAITING.summary, not order_list.summary', async () => {
  const waiting = { reason_code: null, display_status: 'WAITING' };
  const x = rig(
    [
      round('', [['list_my_orders', '{}']]),
      round('', [['explain_order', '{"card_id":"c1"}']]),
      round('结论。'),
    ],
    () => ok({ orders: [waiting], order_ids: ['synthetic-order-1'] }, [card]),
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.texts).toEqual(['[order_status.WAITING.summary]']);
});
