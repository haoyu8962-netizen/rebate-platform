// B3-08p implementation unit tests: RunOutput's read-only cap predicates, and the held-text
// release before a suggestions frame that ends the output / before a capping card that the run
// context drops as an invalid frame. Synthetic ports only (no database, no listen).
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { StreamProtocolError } from '../../stream/writer/index.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from './factories.ts';
import { RunOutput } from './output.ts';
import type { AgentRunBodyDeps, OrchestratorLimits, ToolOutcome } from './ports.ts';

const OFFERED = ['search_products', 'search_rules', 'list_my_orders', 'explain_order'];
const SUGGESTION = [{ text: '合成', send_text: '合成' }];

const handoff: UnnumberedCard = {
  type: 'handoff',
  schema_version: 1,
  data: { text_key: 'agent.handoff.default', actions: [] },
  fallback_text: '合成',
};

function list(count: number): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { items: Array.from({ length: count }, () => ({})) },
    fallback_text: '合成',
  };
}

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

function round(text: string, calls: readonly string[] = []): ModelOutcome {
  const events: Event[] = [];
  if (text !== '') events.push({ t: 'text_delta', text });
  calls.forEach((name, index) => {
    events.push({
      t: 'tool_call',
      index,
      call: { id: `call-${String(index)}`, type: 'function', function: { name, arguments: '{}' } },
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

function context(log: string[], card: RunContext['card']): RunContext {
  return {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: (text) => log.push(`text:${text}`),
    toolStatus: () => undefined,
    card,
    suggestions: () => log.push('suggestions'),
  };
}

function rig(
  rounds: ModelOutcome[],
  answer: () => ToolOutcome,
  limits: Partial<OrchestratorLimits>,
  card: (log: string[]) => RunContext['card'] = (log) => async (c) => {
    log.push(`card:${c.type}`);
  },
  review: AgentRunBodyDeps['review'] = { review: async () => 'pass' },
) {
  const log: string[] = [];
  const deps: AgentRunBodyDeps = {
    model: { complete: vi.fn(async () => rounds.shift() ?? round('')) },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools: {
      definitions: async () =>
        OFFERED.map((name) => ({ name, description: 'synthetic', parameters: { type: 'object' } })),
      execute: vi.fn(async () => answer()),
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
    degraded: {
      run: vi.fn(async () => ({ kind: 'done' as const, finishReason: 'fallback' as const })),
    },
    review,
    texts: { text: async (_app, key) => `[${key}]`, toolDisplay: async () => 'synthetic' },
    prompt: { current: async () => ({ version: 'synthetic-v1', system: 'synthetic' }) },
    limits: { ...orchestratorLimitsDefaults(), ...limits },
    traceMask: (args) => args,
  };
  return { log, run: () => createAgentRunBody(deps)(input())(context(log, card(log))) };
}

it('[AC-B3-08p#1] RunOutput.closesWith: true for a card that reaches the cards or frames cap exactly or does not fit; false below the caps and once closed', async () => {
  const limits = { ...orchestratorLimitsDefaults(), cards: 12, contentFrames: 2 };
  const out = new RunOutput(
    context([], async () => undefined),
    limits,
  );
  expect(out.closesWith(list(10))).toBe(false);
  expect(out.closesWith(list(11))).toBe(true);
  expect(out.closesWith(list(12))).toBe(true);
  expect(out.closesWithSuggestions(SUGGESTION)).toBe(false);
  expect(out.text('甲。')).toBe(true);
  expect(out.closesWith(handoff)).toBe(true);
  expect(out.closesWithSuggestions(SUGGESTION)).toBe(true);
  expect(out.closesWithSuggestions([])).toBe(false);
  expect(await out.card(handoff)).toBe(true);
  expect(out.limitHit).toBe(true);
  expect(out.closesWith(handoff)).toBe(false);
});

it('[AC-B3-08p#1] holding run without a template call: a suggestions frame that reaches the content frame cap → held text released first, done limit', async () => {
  const x = rig(
    [round('甲。', ['search_products'])],
    () => ({ kind: 'ok', modelView: {}, cards: [handoff], suggestions: SUGGESTION }),
    { contentFrames: 2 },
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.log).toEqual(['card:handoff', 'text:甲。']);
});

it('[AC-B3-08p#1] held text released before a capping card the run context drops as an invalid frame → the run still ends there with done limit (no later model round)', async () => {
  const x = rig(
    [round('甲。', ['search_products']), round('乙。')],
    () => ({ kind: 'ok', modelView: {}, cards: [list(11)] }),
    {},
    () => async () => {
      throw new StreamProtocolError('invalid_frame', 'synthetic');
    },
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.log).toEqual(['text:甲。']);
});

it('[AC-B3-08p#3] 请求即算 across positions: search_rules asked behind a capping card in the same round → template written before the card, no model text, done limit', async () => {
  const x = rig(
    [round('甲。', ['search_products', 'search_rules'])],
    () => ({ kind: 'ok', modelView: {}, cards: [list(11)] }),
    {},
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.log).toEqual(['text:[agent.rule.not_found]', 'card:product_list']);
});

function reviewing(blocked: string): AgentRunBodyDeps['review'] {
  return { review: async (text) => (text.includes(blocked) ? 'block' : 'pass') };
}

it('[AC-B3-08p#7] gate r1 S1: the last allowed round first asks for explain_order, its first sentence passes the guard and the second is blocked → no model order conclusion, only agent.refuse.output_blocked, done safety', async () => {
  for (const calls of [['explain_order'], ['search_products', 'explain_order']]) {
    const x = rig(
      [round('这笔订单已返利到账。坏句子。', calls)],
      () => ({ kind: 'ok', modelView: {}, cards: [handoff] }),
      { modelRounds: 1 },
      undefined,
      reviewing('坏句子'),
    );
    expect(await x.run()).toEqual({ kind: 'done', finishReason: 'safety' });
    expect(x.log).toEqual(['text:[agent.refuse.output_blocked]']);
  }
});

it('[AC-B3-08p#7] gate r1 S1: same guard stop in an earlier round that asks for search_rules (rounds left) → no model text of this or the earlier round, only the blocked notice, done safety, tool not run', async () => {
  const x = rig(
    [round('我先看看。', ['search_products']), round('坏句子。', ['search_rules'])],
    () => ({ kind: 'ok', modelView: {}, cards: [handoff] }),
    {},
    undefined,
    reviewing('坏句子'),
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'safety' });
  expect(x.log).toEqual(['card:handoff', 'text:[agent.refuse.output_blocked]']);
});

it('[AC-B3-08p#3] 请求即算 before the format check: a structured tool round asking for list_my_orders → no degraded path, order_list.empty, done stop', async () => {
  const x = rig(
    [round('{"type":"order_status"}', ['list_my_orders'])],
    () => ({
      kind: 'ok',
      modelView: {},
      cards: [],
    }),
    {},
  );
  expect(await x.run()).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.log).toEqual(['text:[order_list.empty]']);
});
