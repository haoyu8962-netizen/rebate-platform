import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { cardReference } from './card-references.ts';
import { routeDegradedIntent } from './degraded-intent.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from './factories.ts';
import type { AgentRunBodyDeps, OrchestratorTrace, ToolOutcome } from './ports.ts';
import { intentOf, isStructuredText } from './run.ts';

function input(): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成订单 987654321012',
    redactedText: '合成订单 <num_1>' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function context(): { ctx: RunContext; texts: string[]; suggestions: unknown[][] } {
  const texts: string[] = [];
  const suggestions: unknown[][] = [];
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
    suggestions: (items) => {
      suggestions.push([...items]);
    },
  };
  return { ctx, texts, suggestions };
}

function baseDeps(
  rounds: ModelOutcome[],
  execute: AgentRunBodyDeps['tools']['execute'],
  placeholders: Readonly<Record<string, string>> = {},
): AgentRunBodyDeps {
  return {
    model: { complete: vi.fn(async () => rounds.shift()!) },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools: {
      definitions: async () => [
        { name: 'search_products', description: 'synthetic', parameters: { type: 'object' } },
      ],
      execute,
      enabledSearchPlatforms: async () => [],
      searchKeyword: async () => ({ results: [], cards: [] }),
    },
    inputCheck: {
      check: async () => ({
        kind: 'proceed',
        modelText: '合成订单 <num_1>',
        placeholders,
        links: [],
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      }),
    },
    degraded: { run: async () => ({ kind: 'done', finishReason: 'fallback' }) },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => key, toolDisplay: async () => 'synthetic' },
    prompt: { current: async () => ({ version: 'synthetic-v1', system: 'synthetic' }) },
    limits: orchestratorLimitsDefaults(),
    traceMask: (args) => args,
  };
}

function call(id: string, name: string, args: string) {
  return { id, type: 'function' as const, function: { name, arguments: args } };
}

function modelRound(events: Extract<ModelOutcome, { kind: 'model' }>['events']): ModelOutcome {
  return {
    kind: 'model',
    entryId: 'flash',
    model: 'synthetic-flash',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [{ entryId: 'flash', result: 'ok', elapsedMs: 0 }],
    events,
  };
}

it('[B3-05b review S2] every traced tool call goes through traceMask, whatever its status', async () => {
  const args = '{"order_no":"<num_1>"}';
  const rounds = [
    modelRound([
      { t: 'tool_call', index: 0, call: call('a', 'search_products', args) },
      { t: 'tool_call', index: 1, call: call('b', 'search_products', args) },
      { t: 'tool_call', index: 2, call: call('c', 'synthetic_unknown', args) },
      { t: 'tool_call', index: 3, call: call('d', 'search_products', '{not json') },
      { t: 'done', reason: 'tool_calls' },
    ]),
    modelRound([
      { t: 'text_delta', text: '合成说明。' },
      { t: 'done', reason: 'stop' },
    ]),
  ];
  const outcomes: ToolOutcome[] = [
    { kind: 'rejected', modelView: { error: 'invalid_args' } },
    { kind: 'failed', modelView: { error: 'synthetic_failed' } },
  ];
  const execute = vi.fn(
    async (): Promise<ToolOutcome> => outcomes.shift() ?? { kind: 'ok', modelView: {}, cards: [] },
  );
  const traces: OrchestratorTrace[] = [];
  const placeholders = { '<num_1>': '987654321012' };
  const traceMask = vi.fn(() => 'masked');
  const deps: AgentRunBodyDeps = {
    ...baseDeps(rounds, execute, placeholders),
    traceMask,
    trace: { record: (_runId, trace) => traces.push(trace) },
  };
  const out = context();
  expect(await createAgentRunBody(deps)(input())(out.ctx)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(traces[0]?.tool_calls).toEqual([
    { name: 'search_products', args: 'masked', status: 'rejected' },
    { name: 'search_products', args: 'masked', status: 'failed' },
    { name: 'synthetic_unknown', args: 'masked', status: 'rejected' },
    { name: 'search_products', args: 'masked', status: 'rejected' },
  ]);
  expect(traceMask.mock.calls).toEqual([
    [{ order_no: '<num_1>' }, placeholders],
    [{ order_no: '<num_1>' }, placeholders],
    [{ order_no: '<num_1>' }, placeholders],
    ['{not json', placeholders],
  ]);
  expect(JSON.stringify(traces)).not.toContain('<num_1>');
  expect(out.texts.join('')).toBe('合成说明。');
});

it.each(['same round', 'across rounds'] as const)(
  '[B3-05b review-codex-r1 S1][BR-AI-06] suggestions are capped at 3 per run, %s',
  async (mode) => {
    const toolA = call('a', 'search_products', '{"q":"合成甲"}');
    const toolB = call('b', 'search_products', '{"q":"合成乙"}');
    const finalRound = modelRound([
      { t: 'text_delta', text: '合成说明。' },
      { t: 'done', reason: 'stop' },
    ]);
    const rounds =
      mode === 'same round'
        ? [
            modelRound([
              { t: 'tool_call', index: 0, call: toolA },
              { t: 'tool_call', index: 1, call: toolB },
              { t: 'done', reason: 'tool_calls' },
            ]),
            finalRound,
          ]
        : [
            modelRound([
              { t: 'tool_call', index: 0, call: toolA },
              { t: 'done', reason: 'tool_calls' },
            ]),
            modelRound([
              { t: 'tool_call', index: 0, call: toolB },
              { t: 'done', reason: 'tool_calls' },
            ]),
            finalRound,
          ];
    const batch = (tag: string) =>
      [1, 2, 3].map((i) => ({ text: `合成建议${tag}${i}`, send_text: `合成后续${tag}${i}` }));
    const first = batch('甲');
    const second = batch('乙');
    const results = [first, second];
    const execute = vi.fn(async (): Promise<ToolOutcome> => ({
      kind: 'ok',
      modelView: {},
      cards: [],
      suggestions: results.shift() ?? [],
    }));
    const out = context();
    expect(await createAgentRunBody(baseDeps(rounds, execute))(input())(out.ctx)).toEqual({
      kind: 'done',
      finishReason: 'stop',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    // 3 in total for the run; the second tool's suggestions find no room and are dropped.
    expect(out.suggestions).toEqual([first]);
    expect(out.suggestions.flat()).toHaveLength(3);
    expect(out.texts.join('')).toBe('合成说明。');
  },
);

it('[B3-05b review-codex-r1 S1][BR-AI-06] a partial batch only uses the room left in the run', async () => {
  const rounds = [
    modelRound([
      { t: 'tool_call', index: 0, call: call('a', 'search_products', '{}') },
      { t: 'tool_call', index: 1, call: call('b', 'search_products', '{}') },
      { t: 'done', reason: 'tool_calls' },
    ]),
    modelRound([{ t: 'done', reason: 'stop' }]),
  ];
  const results = [
    [{ text: '合成一', send_text: '合成一' }],
    [1, 2, 3].map((i) => ({ text: `合成${i}`, send_text: `合成${i}` })),
  ];
  const execute = vi.fn(async (): Promise<ToolOutcome> => ({
    kind: 'ok',
    modelView: {},
    cards: [],
    suggestions: results.shift() ?? [],
  }));
  const out = context();
  await createAgentRunBody(baseDeps(rounds, execute))(input())(out.ctx);
  expect(out.suggestions).toEqual([
    [{ text: '合成一', send_text: '合成一' }],
    [
      { text: '合成1', send_text: '合成1' },
      { text: '合成2', send_text: '合成2' },
    ],
  ]);
});

it('[B3-05b] invalid limits are rejected when the body factory is built', () => {
  const limits = { ...orchestratorLimitsDefaults(), cards: 0 };
  expect(() => createAgentRunBody({ limits } as AgentRunBodyDeps)).toThrow(RangeError);
});

it('[B3-05b] intentOf recognises intent objects only', () => {
  expect(intentOf('{"agent_intent":"page_guide","route":"wallet"}')).toEqual({
    name: 'page_guide',
  });
  expect(intentOf('```json\n{"agent_intent":"clarify"}\n```')).toEqual({ name: 'clarify' });
  expect(intentOf('{"agent_intent": 3}')).toEqual({ name: null });
  expect(intentOf('{"agent_intent":"page_gu')).toEqual({ name: null });
  expect(intentOf('{"title":"合成"}')).toBeUndefined();
  expect(intentOf('合成说明 {"agent_intent":"x"}')).toBeUndefined();
  expect(intentOf('[1,2]')).toBeUndefined();
});

// review-codex-r2 S1: structured model text (card JSON etc.) is never delivered as text.delta.
const CARD_JSON = '{"type":"product_card","data":{"price":2990}}';
const STRUCTURED = [
  { label: 'card JSON', parts: ['{"type":"product_card",', '"data":{"price":2990}}'] },
  { label: 'fenced JSON', parts: ['```json\n', CARD_JSON, '\n```'] },
  { label: 'JSON array', parts: ['[{"title":"合成","price":2990}]'] },
  { label: 'unparseable object', parts: ['{"type":"product_card","data":{"pri'] },
  {
    label: 'prefixed card JSON',
    parts: ['推荐如下：', '{"ty', 'pe":', '"product_card","data":{"price":2990}}'],
  },
  { label: 'prefixed JSON fence', parts: ['推荐如下：```json\n', CARD_JSON, '\n```'] },
  { label: 'prefixed unlabelled fence', parts: ['推荐如下：```\n', CARD_JSON, '\n```'] },
  {
    label: 'prefixed other-language fence',
    parts: ['推荐如下：```javascript\n', CARD_JSON, '\n```'],
  },
  { label: 'prefixed object array', parts: ['推荐如下：[', CARD_JSON, ']'] },
  { label: 'prefixed spaced key', parts: ['推荐如下：{ \n " price " \t', ': 2990}'] },
  { label: 'prefixed escaped key', parts: ['推荐如下：{"a\\"b":2990}'] },
  { label: 'prefixed fenced scalar array', parts: ['推荐如下：```json\n[2990, 3000]\n```'] },
  { label: 'prefixed incomplete fenced array', parts: ['推荐如下：```\n[2990,'] },
];

function textRound(parts: readonly string[]): ModelOutcome {
  return modelRound([
    ...parts.map((text) => ({ t: 'text_delta' as const, text })),
    { t: 'done', reason: 'stop' },
  ]);
}

function formatDeps(rounds: ModelOutcome[], outcomes: ToolOutcome[] = []) {
  const traces: OrchestratorTrace[] = [];
  const degraded = vi.fn<AgentRunBodyDeps['degraded']['run']>(async () => ({
    kind: 'done',
    finishReason: 'fallback',
  }));
  const execute = vi.fn(
    async (): Promise<ToolOutcome> => outcomes.shift() ?? { kind: 'ok', modelView: {}, cards: [] },
  );
  const deps: AgentRunBodyDeps = {
    ...baseDeps(rounds, execute),
    degraded: { run: degraded },
    trace: { record: (_runId, trace) => traces.push(trace) },
  };
  return { deps, traces, degraded, execute };
}

it.each(STRUCTURED)(
  '[AC-B3-05b-format#1][BR-AI-06] final-round $label is not delivered; nothing sent yet => models_failed degrade',
  async ({ parts }) => {
    const r = formatDeps([textRound(parts)]);
    const out = context();
    expect(await createAgentRunBody(r.deps)(input())(out.ctx)).toEqual({
      kind: 'done',
      finishReason: 'fallback',
    });
    expect(out.texts).toEqual([]);
    expect(r.degraded).toHaveBeenCalledTimes(1);
    expect(r.degraded.mock.calls[0]?.[0].reason).toBe('models_failed');
    expect(r.traces[0]?.model_format_invalid).toBe(true);
  },
);

it.each(STRUCTURED)(
  '[AC-B3-05b-format#2][BR-AI-06] final-round $label after delivered content: flush and done stop',
  async ({ parts }) => {
    const card = {
      type: 'notice',
      schema_version: 1,
      data: { level: 'info', text_key: 'agent.degraded.empty', actions: [] },
      fallback_text: '合成卡',
    } as const;
    const r = formatDeps(
      [
        modelRound([
          { t: 'text_delta', text: '合成第一句' },
          { t: 'tool_call', index: 0, call: call('a', 'search_products', '{}') },
          { t: 'done', reason: 'tool_calls' },
        ]),
        textRound(parts),
      ],
      [{ kind: 'ok', modelView: {}, cards: [card] }],
    );
    const out = context();
    expect(await createAgentRunBody(r.deps)(input())(out.ctx)).toEqual({
      kind: 'done',
      finishReason: 'stop',
    });
    // The open sentence of the earlier round is flushed; the structured text never appears.
    expect(out.texts).toEqual(['合成第一句']);
    expect(r.degraded).not.toHaveBeenCalled();
    expect(r.traces[0]?.model_format_invalid).toBe(true);
  },
);

it.each(STRUCTURED)(
  '[AC-B3-05b-format#3][BR-AI-06] tool-round $label is rejected before executing tools',
  async ({ parts }) => {
    const r = formatDeps([
      modelRound([
        ...parts.map((text) => ({ t: 'text_delta' as const, text })),
        { t: 'tool_call', index: 0, call: call('a', 'search_products', '{}') },
        { t: 'done', reason: 'tool_calls' },
      ]),
    ]);
    const out = context();
    expect(await createAgentRunBody(r.deps)(input())(out.ctx)).toEqual({
      kind: 'done',
      finishReason: 'fallback',
    });
    expect(out.texts).toEqual([]);
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.degraded.mock.calls[0]?.[0].reason).toBe('models_failed');
    expect(r.traces[0]?.model_format_invalid).toBe(true);
  },
);

it('[B3-05b review-codex-r2 S1][BR-AI-06] an IntentPort returning null does not let card JSON through', async () => {
  const r = formatDeps([textRound([CARD_JSON])]);
  const handle = vi.fn(async () => null);
  const out = context();
  expect(await createAgentRunBody({ ...r.deps, intents: { handle } })(input())(out.ctx)).toEqual({
    kind: 'done',
    finishReason: 'fallback',
  });
  expect(handle).toHaveBeenCalledTimes(1);
  expect(out.texts).toEqual([]);
});

it.each([
  '合成说明{约}可看卡片。',
  '[提示] 合成说明可看卡片。',
  '合成说明(含税)，{尺码}与[推荐]请看卡片。',
])(
  '[AC-B3-05b-format#4][BR-AI-06] ordinary prose with braces or a bracket tag is delivered: %s',
  async (text) => {
    const r = formatDeps([textRound([text])]);
    const out = context();
    expect(await createAgentRunBody(r.deps)(input())(out.ctx)).toEqual({
      kind: 'done',
      finishReason: 'stop',
    });
    expect(out.texts.join('')).toBe(text);
    expect(r.degraded).not.toHaveBeenCalled();
    expect(r.traces[0]?.model_format_invalid).toBe(false);
  },
);

it('[B3-05b] the agent_intent rule still wins over the structured-text rule', async () => {
  const r = formatDeps([textRound(['{"agent_intent":"page_guide"}'])]);
  const out = context();
  expect(await createAgentRunBody(r.deps)(input())(out.ctx)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(out.texts).toEqual(['agent.refuse.out_of_scope']);
  expect(r.degraded).not.toHaveBeenCalled();
  expect(r.traces[0]?.model_format_invalid).toBe(false);
});

it('[AC-B3-05b-format#5] isStructuredText', () => {
  expect(isStructuredText(`  ${CARD_JSON}  `)).toBe(true);
  expect(isStructuredText('```\n{"a":1}\n```')).toBe(true);
  expect(isStructuredText('```json\n{"a":1')).toBe(true);
  expect(isStructuredText('[1, 2]')).toBe(true);
  expect(isStructuredText('[{"a":')).toBe(true);
  expect(isStructuredText('{约}合成')).toBe(true);
  expect(isStructuredText('[提示] 合成')).toBe(false);
  expect(isStructuredText('合成说明 {"a":1}')).toBe(true);
  expect(isStructuredText('')).toBe(false);
});

it.each([
  ['receipts', ['c41', 'c57'], { first: 'c41', second: 'c57', refs: ['c41', 'c57'] }],
  ['one unconfirmed write', ['c41', undefined], { first: 'c41', refs: ['c41'] }],
  ['a context without receipts', [undefined, undefined], { refs: [] }],
] as const)(
  '[B3-05i][BR-AI-05] modelView references follow the run context receipts: %s',
  async (_label, receipts, expected) => {
    const rounds = [
      modelRound([
        { t: 'tool_call', index: 0, call: call('a', 'search_products', '{}') },
        { t: 'done', reason: 'tool_calls' },
      ]),
      modelRound([
        { t: 'text_delta', text: '合成说明。' },
        { t: 'done', reason: 'stop' },
      ]),
    ];
    const issued: string[] = [];
    const notice: UnnumberedCard = {
      type: 'notice',
      schema_version: 1,
      data: { level: 'info', text_key: 'synthetic.notice', actions: [] },
      fallback_text: 'synthetic',
    };
    const execute = vi.fn<AgentRunBodyDeps['tools']['execute']>(async (_call, ctx) => {
      const refs = [0, 1].map((index) => cardReference(ctx, index));
      issued.push(...refs);
      return {
        kind: 'ok',
        cards: refs.map(() => notice),
        modelView: { first: refs[0], second: refs[1], refs },
        trace: { card_sources: refs.map((ref) => ({ card_id: ref, fields: { n: 1 } })) },
      };
    });
    const traces: OrchestratorTrace[] = [];
    const deps: AgentRunBodyDeps = {
      ...baseDeps(rounds, execute),
      trace: { record: (_runId, trace) => traces.push(trace) },
    };
    const pending: unknown[] = [...receipts];
    const out = context();
    // Receipt shapes are what is under test, hence the cast through unknown.
    const card = (async (_card: UnnumberedCard, delivered?: (cardId: unknown) => void) => {
      const receipt = pending.shift();
      if (receipt !== undefined) delivered?.(receipt);
    }) as unknown as RunContext['card'];
    const result = await createAgentRunBody(deps)(input())({ ...out.ctx, card });
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    const messages = vi.mocked(deps.model.complete).mock.calls[1]?.[0].messages ?? [];
    const tool = messages.find((message) => message.role === 'tool');
    expect(JSON.parse(tool?.content ?? 'null')).toEqual(expected);
    const delivered = receipts.filter((receipt) => receipt !== undefined);
    // The trace omits card_sources when none is left.
    expect(traces[0]?.card_sources ?? []).toEqual(
      delivered.map((cardId) => ({ card_id: cardId, fields: { n: 1 } })),
    );
    const exposed = JSON.stringify({ chat: vi.mocked(deps.model.complete).mock.calls, traces });
    for (const reference of issued) expect(exposed).not.toContain(reference);
  },
);

/** Degraded runs whose trace intent is under test; `run` is the path's one entry. */
function routedDeps(run: AgentRunBodyDeps['degraded']['run']) {
  const traces: OrchestratorTrace[] = [];
  const execute = vi.fn(async (): Promise<ToolOutcome> => ({
    kind: 'ok',
    modelView: {},
    cards: [],
  }));
  const deps: AgentRunBodyDeps = {
    ...baseDeps([], execute),
    prompt: { current: async () => null },
    degraded: { run },
    trace: { record: (_runId, trace) => traces.push(trace) },
  };
  return { deps, traces };
}

it('[AC-B3-05n][BR-AI-14] 降级路径在 core 交给 run 的上下文上登记意图：登记了记该意图，没登记仍是 search', async () => {
  const contexts: RunContext[] = [];
  const run = vi.fn<AgentRunBodyDeps['degraded']['run']>(async (_request, ctx) => {
    contexts.push(ctx);
    expect(routeDegradedIntent(ctx, 'order_query')).toBe(true);
    return { kind: 'done', finishReason: 'stop' };
  });
  const routed = routedDeps(run);
  expect(await createAgentRunBody(routed.deps)(input())(context().ctx)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(routed.traces.at(-1)?.intent).toBe('order_query');
  // The slot is closed with the trace: a late registration changes nothing.
  expect(routeDegradedIntent(contexts[0]!, 'search')).toBe(false);
  expect(routed.traces.at(-1)?.intent).toBe('order_query');

  const plain = routedDeps(async () => ({ kind: 'done', finishReason: 'fallback' }));
  await createAgentRunBody(plain.deps)(input())(context().ctx);
  expect(plain.traces.at(-1)?.intent).toBe('search');

  // An intent outside the no-model set, or a copy of the context, registers nothing.
  const odd = routedDeps(async (_request, ctx) => {
    expect(() => routeDegradedIntent(ctx, 'clarify' as never)).toThrow(RangeError);
    expect(() => routeDegradedIntent({ ...ctx }, 'order_query')).toThrow();
    return { kind: 'done', finishReason: 'stop' };
  });
  await createAgentRunBody(odd.deps)(input())(context().ctx);
  expect(odd.traces.at(-1)?.intent).toBe('search');
  // Not the context of a degraded run call.
  expect(() => routeDegradedIntent(context().ctx, 'order_query')).toThrow();
});

it('[AC-B3-05n][BR-AI-14] 模型已给出意图后降级：降级路径登记的意图不改它', async () => {
  const r = formatDeps([textRound(['{"agent_intent":"clarify"}'])]);
  const registered: boolean[] = [];
  const run = vi.fn<AgentRunBodyDeps['degraded']['run']>(async (_request, ctx) => {
    registered.push(routeDegradedIntent(ctx, 'order_query'));
    return { kind: 'done', finishReason: 'fallback' };
  });
  const handle = vi.fn(async () => null);
  expect(
    await createAgentRunBody({ ...r.deps, degraded: { run }, intents: { handle } })(input())(
      context().ctx,
    ),
  ).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(registered).toEqual([false]);
  expect(r.traces.at(-1)?.intent).toBe('clarify');
});

it('[AC-B3-05n][BR-AI-14] 登记意图后用户中途停止本轮（降级路径尚未返回）：留痕仍记该意图', async () => {
  const controller = new AbortController();
  let late: RunContext | undefined;
  const run = vi.fn<AgentRunBodyDeps['degraded']['run']>(async (_request, ctx) => {
    routeDegradedIntent(ctx, 'order_query');
    late = ctx;
    controller.abort('cancelled');
    // The path never returns before the core gives up waiting.
    return new Promise(() => undefined);
  });
  const routed = routedDeps(run);
  const out = context();
  const result = await createAgentRunBody(routed.deps)(input())({
    ...out.ctx,
    signal: controller.signal,
  });
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(routed.traces).toHaveLength(1);
  expect(routed.traces[0]?.intent).toBe('order_query');
  expect(routeDegradedIntent(late!, 'earnings_query')).toBe(false);
  expect(routed.traces[0]?.intent).toBe('order_query');
});
