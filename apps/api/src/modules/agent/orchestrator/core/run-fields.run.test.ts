// B3-08t (BR-AI-19 细则「运行级字段」) on the core run: the model whose output the result used, the
// tokens of every metered call, the no-model path page guide rejection reason, and (统一原则
// D10-2368: 只落核对过的，没核对过就留空) one test per exit point of the result model and the
// intent facts in run.ts: nothing unchecked is marked ruled, no unused output moves result_model.
// Synthetic ports only (harness as reply-templates.run.test.ts).
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RunContext } from '../../stream/run/index.ts';
import { markDegradedGuideRejected } from './degraded-intent.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from './factories.ts';
import type {
  AgentRunBodyDeps,
  InputProceed,
  IntentPort,
  OrchestratorLimits,
  OrchestratorTrace,
  ScenarioEntryPath,
  ToolOutcome,
} from './ports.ts';

const OFFERED = ['search_products', 'search_rules', 'list_my_orders', 'explain_order'];

function input(context?: Readonly<Record<string, unknown>>): RunBodyInput {
  return {
    ...(context === undefined ? {} : { context }),
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

interface RigOptions {
  readonly intents?: IntentPort;
  readonly entry?: ScenarioEntryPath;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly links?: InputProceed['links'];
  readonly noPrompt?: boolean;
  readonly signal?: AbortSignal;
}

function rig(
  rounds: ModelOutcome[],
  answer: (name: string) => ToolOutcome,
  limits: Partial<OrchestratorLimits> = {},
  options: RigOptions = {},
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
        links: options.links ?? [],
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      }),
    },
    degraded: { run: degraded },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => `[${key}]`, toolDisplay: async () => 'synthetic' },
    prompt: {
      current: async () =>
        options.noPrompt === true ? null : { version: 'synthetic-v1', system: 'synthetic' },
    },
    limits: { ...orchestratorLimitsDefaults(), ...limits },
    traceMask: (args) => args,
    trace: { record: (_runId, trace) => traces.push(trace) },
    ...(options.intents === undefined ? {} : { intents: options.intents }),
    ...(options.entry === undefined ? {} : { entry: options.entry }),
  };
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: options.signal ?? new AbortController().signal,
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
    run: () => createAgentRunBody(deps)(input(options.context))(ctx),
  };
}

const ORDER_TRACE: Record<string, unknown> = { orders: [], order_ids: [], lookup: 'ok' };
const ORDERS: ToolOutcome = { kind: 'ok', modelView: {}, cards: [], trace: ORDER_TRACE };

const SEARCHED: ToolOutcome = { kind: 'ok', modelView: {}, cards: [], trace: {} };

// ── Exit point run.ts finalRound (templated): the templates drop the final round ──────────────

it('[AC-B3-08t#6] exit finalRound/templated: the primary chose the order tool, the backup text is dropped → result model stays the primary', async () => {
  const x = rig(
    [
      round('', [['list_my_orders', '{}']], 'synthetic-primary'),
      round('{"agent_intent":"earnings_query"}', [], 'synthetic-backup'),
    ],
    () => ORDERS,
  );
  await x.run();
  expect(x.traces[0]?.text_replaced_by_template).toBe(true);
  expect(x.traces[0]?.result_model).toBe('synthetic-primary');
});

it('[AC-B3-08t#1][AC-B3-08t#2] exit finalRound/templated: the final round intent object is not marked ruled (the first tool decides)', async () => {
  const x = rig(
    [round('', [['list_my_orders', '{}']]), round('{"agent_intent":"earnings_query"}')],
    () => ORDERS,
  );
  await x.run();
  expect(x.traces[0]?.intent).toBe('earnings_query');
  expect(x.traces[0]?.intent_ruled).toBeUndefined();
  expect(x.traces[0]?.tool_calls[0]?.name).toBe('list_my_orders');
});

// ── Exit point run.ts finalRound (plain text written through the guard) ──────────────────────

it('[AC-B3-08t#6] exit finalRound/text: the model whose final text was written is the result model', async () => {
  const x = rig(
    [
      round('', [['search_products', '{}']], 'synthetic-primary'),
      round('结论。', [], 'synthetic-backup'),
    ],
    () => SEARCHED,
  );
  await x.run();
  expect(x.texts.join('')).toContain('结论');
  expect(x.traces[0]?.result_model).toBe('synthetic-backup');
  expect(x.traces[0]?.intent_ruled).toBeUndefined();
});

// ── Exit point run.ts modelPath tool round: the result model moves only with used output ──────

it('[AC-B3-08t#6] exit modelPath/format check (money r2 S1-1): the backup round with JSON text and a search call is dropped → result model stays the primary', async () => {
  const x = rig(
    [
      round('', [['list_my_orders', '{}']], 'synthetic-primary'),
      round('{"foo":1}', [['search_products', '{}']], 'synthetic-backup', {
        input_tokens: 5,
        output_tokens: 4,
      }),
    ],
    (name) => (name === 'list_my_orders' ? ORDERS : SEARCHED),
  );
  await x.run();
  expect(x.execute.mock.calls.map(([call]) => call.name)).toEqual(['list_my_orders']);
  const trace = x.traces[0];
  expect(trace?.model_format_invalid).toBe(true);
  expect(trace?.result_model).toBe('synthetic-primary');
  // trace.model is the last model that answered; the usage of the dropped round still counts once.
  expect(trace?.model).toBe('synthetic-backup');
  expect(trace?.usage).toEqual({ input_tokens: 6, output_tokens: 5 });
});

it('[AC-B3-08t#6] exit modelPath/U-10: the last allowed round still asks for a tool, its call is not run → no result model', async () => {
  const x = rig([round('', [['search_products', '{}']], 'synthetic-primary')], () => SEARCHED, {
    modelRounds: 1,
  });
  await x.run();
  expect(x.execute).not.toHaveBeenCalled();
  expect(x.traces[0]?.result_model).toBeUndefined();
});

it('[AC-B3-08t#6] exit modelPath/tool budget: the backup call over limits.toolCalls is not run → result model stays the primary', async () => {
  const x = rig(
    [
      round('', [['search_products', '{}']], 'synthetic-primary'),
      round('', [['search_products', '{}']], 'synthetic-backup'),
    ],
    () => SEARCHED,
    { toolCalls: 1 },
  );
  await x.run();
  expect(x.execute).toHaveBeenCalledOnce();
  expect(x.traces[0]?.model).toBe('synthetic-backup');
  expect(x.traces[0]?.result_model).toBe('synthetic-primary');
});

it('[AC-B3-08t#6] exit runTool/rejected: an unregistered tool name or broken arguments are not executed → no result model', async () => {
  const x = rig(
    [
      round('', [['no_such_tool', '{}']], 'synthetic-primary'),
      round('', [['search_products', '{not json']], 'synthetic-backup'),
      round('', [], 'synthetic-third'),
    ],
    () => SEARCHED,
  );
  await x.run();
  expect(x.execute).not.toHaveBeenCalled();
  expect(x.traces[0]?.result_model).toBeUndefined();
});

it('[AC-B3-08t#6] exit runTool/executed: the round whose call executed is the result model; an earlier round tail written later does not move it back', async () => {
  const x = rig(
    [
      round('先看看。', [['search_products', '{}']], 'synthetic-primary'),
      round('', [['search_products', '{}']], 'synthetic-backup'),
      round('', [], 'synthetic-third'),
    ],
    () => SEARCHED,
  );
  await x.run();
  expect(x.execute).toHaveBeenCalledTimes(2);
  expect(x.texts.join('')).toContain('先看看');
  expect(x.traces[0]?.result_model).toBe('synthetic-backup');
});

it('[AC-B3-08t#6] exit finalRound/format check: structured final text after delivered output is dropped → result model unchanged', async () => {
  const x = rig(
    [
      round('先看看。', [['search_products', '{}']], 'synthetic-primary'),
      round('{"card":"伪造"}', [], 'synthetic-backup'),
    ],
    () => SEARCHED,
  );
  await x.run();
  expect(x.texts.join('')).toContain('先看看');
  expect(x.texts.join('')).not.toContain('伪造');
  expect(x.traces[0]?.model_format_invalid).toBe(true);
  expect(x.traces[0]?.degraded).toBeUndefined();
  expect(x.traces[0]?.result_model).toBe('synthetic-primary');
});

it('[AC-B3-08t#6] exit finalRound/blank: blank final text without any used output → no result model', async () => {
  const x = rig([round('   ', [], 'synthetic-primary')], () => SEARCHED);
  await x.run();
  expect(x.traces[0]?.model).toBe('synthetic-primary');
  expect(x.traces[0]?.result_model).toBeUndefined();
});

// ── Exit point run.ts finalRound with the IntentPort (money r2 S1-2) ─────────────────────────

it('[AC-B3-08t#1][AC-B3-08t#7] exit finalRound/port pending (money r2 S1-2): stopped before the port recorded its verdict → the model label is not ruled, no result model', async () => {
  const controller = new AbortController();
  const intents: IntentPort = {
    handle: () => {
      // The port re-reads 查一下我的订单 as order_query and is still fetching the login copy.
      controller.abort();
      return new Promise(() => undefined);
    },
  };
  const x = rig(
    [round('{"agent_intent":"earnings_query"}', [], 'synthetic-primary')],
    () => ORDERS,
    {},
    { intents, signal: controller.signal },
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  const trace = x.traces[0];
  expect(trace?.intent).toBe('earnings_query');
  expect(trace?.intent_ruled).toBeUndefined();
  expect(trace?.intent_withheld).toBeUndefined();
  expect(trace?.tool_calls).toEqual([]);
  expect(trace?.result_model).toBeUndefined();
});

it('[AC-B3-08t#6] exit finalRound/port answered: the port answered on a known intent object → that round is the result model, the label still not ruled', async () => {
  const intents: IntentPort = {
    handle: async (_request, ctx) => {
      ctx.text('[agent.refuse.out_of_scope]');
      return { kind: 'done', finishReason: 'stop' };
    },
  };
  const x = rig(
    [round('{"agent_intent":"out_of_scope"}', [], 'synthetic-primary')],
    () => ORDERS,
    {},
    { intents },
  );
  await x.run();
  expect(x.traces[0]?.result_model).toBe('synthetic-primary');
  expect(x.traces[0]?.intent_ruled).toBeUndefined();
});

it('[AC-B3-08t#6] exit finalRound/port answered broken JSON: an object the port refused as broken is not used → no result model', async () => {
  const intents: IntentPort = {
    handle: async (_request, ctx) => {
      ctx.text('[agent.refuse.out_of_scope]');
      return { kind: 'done', finishReason: 'stop' };
    },
  };
  const x = rig(
    [round('{"agent_intent": ', [], 'synthetic-primary')],
    () => ORDERS,
    {},
    {
      intents,
    },
  );
  await x.run();
  expect(x.traces[0]?.result_model).toBeUndefined();
});

it('[AC-B3-08t#4] exit degrade with a model label: the no-model path after a kept model label → not ruled (the label stays unchecked)', async () => {
  // A port that leaves an intent object to the core: structured text, nothing delivered → degrade.
  const intents: IntentPort = { handle: async () => null };
  const x = rig(
    [round('{"agent_intent":"earnings_query"}', [], 'synthetic-primary')],
    () => ORDERS,
    {},
    { intents },
  );
  await x.run();
  expect(x.degraded).toHaveBeenCalledOnce();
  expect(x.traces[0]?.intent).toBe('earnings_query');
  expect(x.traces[0]?.intent_ruled).toBeUndefined();
  expect(x.traces[0]?.degraded).toBe(true);
  expect(x.traces[0]?.result_model).toBeUndefined();
});

// ── Exit point run.ts finalRound U-7 (money r2 S2) ───────────────────────────────────────────

it('[AC-B3-08t#4] exit finalRound/U-7 (money r2 S2): without an IntentPort the label is dropped for out_of_scope → intent withheld, no result model', async () => {
  const x = rig(
    [
      round('', [['search_products', '{}']], 'synthetic-primary'),
      round('{"agent_intent":"earnings_query"}', [], 'synthetic-backup'),
    ],
    () => SEARCHED,
  );
  await x.run();
  expect(x.texts).toContain('[agent.refuse.out_of_scope]');
  const trace = x.traces[0];
  expect(trace?.intent_withheld).toBe(true);
  expect(trace?.intent_ruled).toBeUndefined();
  // The executed search of the first round is still that round's used output.
  expect(trace?.result_model).toBe('synthetic-primary');
});

// ── Exit points run.ts linkPath / order entry / degrade: the deterministic rules ─────────────

it('[AC-B3-08t#3] exit linkPath: a link message is find_by_link by rule → ruled, no result model', async () => {
  const x = rig(
    [],
    () => SEARCHED,
    {},
    {
      links: [{ kind: 'url', raw: 'https://demo.invalid/x' }] as unknown as InputProceed['links'],
    },
  );
  await x.run();
  expect(x.traces[0]).toMatchObject({ intent: 'find_by_link', intent_ruled: true });
  expect(x.traces[0]?.result_model).toBeUndefined();
});

it('[AC-B3-08t#3] exit order entry: context.order_id is order_query by rule → ruled and the entry fact, no result model', async () => {
  const entry = {
    order: vi.fn(async () => ({ kind: 'done' as const, finishReason: 'stop' as const })),
  } as unknown as ScenarioEntryPath;
  const x = rig(
    [],
    () => ORDERS,
    {},
    {
      entry,
      context: { order_id: '0192f3a1-7c00-7000-8000-0000000e0001' },
    },
  );
  await x.run();
  expect(entry.order).toHaveBeenCalledOnce();
  expect(x.traces[0]).toMatchObject({
    intent: 'order_query',
    entry_intent: 'order_query',
    intent_ruled: true,
  });
  expect(x.traces[0]?.result_model).toBeUndefined();
});

it('[AC-B3-08t#3] exit degrade: the no-model path (no prompt) is ①–⑥ by rule → ruled, degraded, no result model', async () => {
  const x = rig([], () => SEARCHED, {}, { noPrompt: true });
  await x.run();
  expect(x.degraded).toHaveBeenCalledOnce();
  expect(x.traces[0]).toMatchObject({ intent: 'search', intent_ruled: true, degraded: true });
  expect(x.traces[0]?.result_model).toBeUndefined();
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
