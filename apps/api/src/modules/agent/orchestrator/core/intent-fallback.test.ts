// B3-05o unit tests (synthetic only): the core's 不空回复 fill, server-initiated calls through the
// IntentPort's context, and the {q_short} suggestions.
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext } from '../../stream/run/index.ts';
import { noResultSuggestions } from '../results/shared.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from './factories.ts';
import {
  qShort,
  serveIntentFallback,
  serverCallsOf,
  type ServerToolCallResult,
} from './intent-fallback.ts';
import type { AgentRunBodyDeps, OrchestratorTrace } from './ports.ts';

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

type Frame = { kind: string; value: unknown };

function context(controller = new AbortController()): { ctx: RunContext; frames: Frame[] } {
  const frames: Frame[] = [];
  let next = 1;
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: controller.signal,
    cardsDelivered: 0,
    text: (text) => {
      frames.push({ kind: 'text', value: text });
    },
    toolStatus: () => undefined,
    card: async (card, delivered) => {
      frames.push({ kind: 'card', value: card.type });
      delivered?.(`c${String(next++)}`);
    },
    suggestions: (items) => {
      frames.push({ kind: 'suggestions', value: items.map((item) => item.text) });
    },
  };
  return { ctx, frames };
}

function round(text: string, calls: readonly string[] = []): ModelOutcome {
  return {
    kind: 'model',
    entryId: 'flash',
    model: 'synthetic-flash',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [],
    events: [
      ...(text === '' ? [] : [{ t: 'text_delta' as const, text }]),
      ...calls.map((name, index) => ({
        t: 'tool_call' as const,
        index,
        call: {
          id: `call-${String(index)}`,
          type: 'function' as const,
          function: { name, arguments: '{}' },
        },
      })),
      { t: 'done' as const, reason: calls.length > 0 ? 'tool_calls' : 'stop' },
    ],
  };
}

function deps(rounds: ModelOutcome[], extra: Partial<AgentRunBodyDeps> = {}): AgentRunBodyDeps {
  return {
    model: { complete: vi.fn(async () => rounds.shift()!) },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools: {
      definitions: async () => [
        { name: 'handoff_to_human', description: 'synthetic', parameters: { type: 'object' } },
      ],
      execute: vi.fn(async () => ({
        kind: 'ok' as const,
        modelView: {},
        cards: [
          {
            type: 'handoff',
            schema_version: 1,
            data: { text_key: 'agent.handoff.default', actions: [] },
            fallback_text: '合成转人工',
          },
        ],
      })),
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
    degraded: { run: async () => ({ kind: 'done', finishReason: 'fallback' }) },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => `合成:${key}`, toolDisplay: async () => 'synthetic' },
    prompt: { current: async () => ({ version: 'synthetic-v1', system: 'synthetic' }) },
    limits: orchestratorLimitsDefaults(),
    traceMask: (args) => args,
    ...extra,
  };
}

it('[AC-B3-05o#30] blank model text: agent.reply.empty, then the three quick questions, port told once', async () => {
  const filled = vi.fn();
  const { ctx, frames } = context();
  const result = await createAgentRunBody(deps([round('  ')], { emptyReplies: { filled } }))(
    input(),
  )(ctx);
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(frames).toEqual([
    { kind: 'text', value: '合成:agent.reply.empty' },
    {
      kind: 'suggestions',
      value: [
        '合成:agent.suggest.empty.1',
        '合成:agent.suggest.empty.2',
        '合成:agent.suggest.empty.3',
      ],
    },
  ]);
  expect(filled).toHaveBeenCalledTimes(1);
  expect(filled).toHaveBeenCalledWith({
    appId: 'synthetic-app',
    runId: 'synthetic-run',
    finishReason: 'stop',
  });
});

it('[AC-B3-05o#36] a cancelled run is never filled', async () => {
  const filled = vi.fn();
  const controller = new AbortController();
  const { ctx, frames } = context(controller);
  const complete = vi.fn(async () => {
    controller.abort();
    return round('');
  });
  const body = createAgentRunBody(deps([], { model: { complete }, emptyReplies: { filled } }));
  expect(await body(input())(ctx)).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(frames).toEqual([]);
  expect(filled).not.toHaveBeenCalled();
});

it('[AC-B3-05o#24] a server call through the IntentPort context counts toward limits.toolCalls and is traced as the server’s', async () => {
  const traces: OrchestratorTrace[] = [];
  const results: ServerToolCallResult['kind'][] = [];
  const handle = vi.fn<NonNullable<AgentRunBodyDeps['intents']>['handle']>(async (_r, ctx) => {
    const server = serverCallsOf(ctx)!;
    expect(server.offered('handoff_to_human')).toBe(true);
    expect(server.offered('search_rules')).toBe(false);
    for (let n = 0; n < 2; n += 1) {
      results.push(
        (await server.call({ id: `s${String(n)}`, name: 'handoff_to_human', args: {} })).kind,
      );
    }
    return { kind: 'done', finishReason: 'stop' };
  });
  const { ctx, frames } = context();
  const body = createAgentRunBody(
    deps([round('', ['nope', 'nope', 'nope']), round('{"agent_intent":"handoff"}')], {
      intents: { handle },
      trace: { record: (_id, trace) => traces.push(trace) },
    }),
  );
  expect(await body(input())(ctx)).toEqual({ kind: 'done', finishReason: 'stop' });
  // Three model calls + one server call fill the four; the second server call is not made.
  expect(results).toEqual(['called', 'exhausted']);
  expect(frames).toEqual([{ kind: 'card', value: 'handoff' }]);
  expect(traces[0]?.tool_calls.map((c) => [c.name, c.initiator ?? 'model'])).toEqual([
    ['nope', 'model'],
    ['nope', 'model'],
    ['nope', 'model'],
    ['handoff_to_human', 'server'],
  ]);
});

it('[AC-B3-05o#48] {q_short}: first 8 code points; no search term → no second suggestion', async () => {
  expect(qShort('𠮷野家牛肉饭套餐双人份')).toBe('𠮷野家牛肉饭套餐');
  expect(qShort('耳机')).toBe('耳机');
  const texts = {
    text: async (_app: string, key: string) =>
      ({
        'agent.suggest.no_result.1': '去掉价格条件再找',
        'agent.suggest.no_result.2': '只搜{q_short}',
        'agent.suggest.no_result.3': '换个平台看看',
      })[key] ?? key,
  };
  expect(await noResultSuggestions(texts, 'synthetic-app', 'abcdefghi')).toEqual([
    { text: '去掉价格条件再找', send_text: '去掉价格条件再找' },
    { text: '只搜abcdefgh', send_text: '只搜abcdefgh' },
    { text: '换个平台看看', send_text: '换个平台看看' },
  ]);
  for (const q of [null, '', '  ']) {
    expect((await noResultSuggestions(texts, 'synthetic-app', q)).map((i) => i.text)).toEqual([
      '去掉价格条件再找',
      '换个平台看看',
    ]);
  }
});

// ------------------------------------------------------------------------------------------------
// 实现第 2 轮：BR-AI-07 held text vs server-initiated template calls; order numbers (BR-AI-01).

function heldRun(serverTool: string) {
  const offered = ['search_products', 'list_my_orders', 'handoff_to_human'];
  const execute = vi.fn(async (call: { name: string }) => ({
    kind: 'ok' as const,
    modelView: {},
    cards:
      call.name === 'handoff_to_human'
        ? [
            {
              type: 'handoff' as const,
              schema_version: 1 as const,
              data: { text_key: 'agent.handoff.default', actions: [] },
              fallback_text: '合成转人工',
            },
          ]
        : [],
  }));
  const handle = vi.fn<NonNullable<AgentRunBodyDeps['intents']>['handle']>(async (_r, ctx) => {
    await serverCallsOf(ctx)!.call({ id: 'server-1', name: serverTool, args: {} });
    return { kind: 'done', finishReason: 'stop' };
  });
  const base = deps([round('合成说明文字。', ['search_products']), round('{"agent_intent":"x"}')], {
    intents: { handle },
  });
  return createAgentRunBody({
    ...base,
    tools: {
      ...base.tools,
      definitions: async () =>
        offered.map((name) => ({ name, description: 'synthetic', parameters: { type: 'object' } })),
      execute,
    },
  });
}

it('[AC-B3-05o] r2 BR-AI-07: earlier round wrote text and called search_products, the last round is order_query served by list_my_orders → no model text, only the order template', async () => {
  const { ctx, frames } = context();
  expect(await heldRun('list_my_orders')(input())(ctx)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  const texts = frames.filter((f) => f.kind === 'text').map((f) => f.value as string);
  expect(texts.some((t) => t.includes('合成说明文字'))).toBe(false);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.every((t) => t.startsWith('合成:order_list.'))).toBe(true);
});

it('[AC-B3-05o] r2: a non-template server call (handoff_to_human) releases the held text first, before its card', async () => {
  const { ctx, frames } = context();
  expect(await heldRun('handoff_to_human')(input())(ctx)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(frames).toEqual([
    { kind: 'text', value: '合成说明文字。' },
    { kind: 'card', value: 'handoff' },
  ]);
});

it('[AC-B3-05o] r2 intent fallback order_query: order_no is only what touches the placeholder (「订单 ID <num_1>」→ <num_1>; 「订单A1-<num_1>」→ A1-<num_1>)', async () => {
  const served: unknown[] = [];
  const server = {
    offered: () => true,
    calledByModel: () => false,
    call: vi.fn(async (call: { args: unknown }) => {
      served.push(call.args);
      return { kind: 'unavailable' as const };
    }),
  };
  const fallbackDeps = {
    config: { configValue: async () => null },
    clock: { now: () => new Date('2031-01-02T00:00:00Z') },
    texts: { text: async (_app: string, key: string) => key },
    enabledSearchPlatforms: async () => [],
  };
  for (const text of ['帮我查京东订单 ID <num_1>', '订单A1-<num_1>']) {
    const request = {
      input: input(),
      proceed: {
        kind: 'proceed' as const,
        modelText: text,
        placeholders: {},
        links: [],
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      },
    };
    const { ctx } = context();
    await serveIntentFallback('order_query', request, server, ctx, fallbackDeps);
  }
  expect(served).toEqual([{ order_no: '<num_1>', platform: 'jd' }, { order_no: 'A1-<num_1>' }]);
});
