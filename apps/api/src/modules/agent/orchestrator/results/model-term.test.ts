import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext } from '../../stream/run/index.ts';
import { orchestratorLimitsDefaults } from '../core/factories.ts';
import type { OrchestratorTools, ToolContext, ToolOutcome } from '../core/ports.ts';
import { bindQueryCheck } from '../core/query-check.ts';
import type { IntentRequest } from '../intents/index.ts';
import { openServerCall } from './references.ts';
import {
  SERVER_CALL,
  isModelChain,
  newChainId,
  type InternalToolCall,
  type ServerCall,
} from './shared.ts';
import { createMemoryResultSetStore } from './store.ts';
import { createClarification, createRefinement, createResultsTools } from './index.ts';
import type { ResultsDeps } from './index.ts';

// Synthetic only. B3-05s · BR-AI-06 / BR-TEXT-22 (C-32): a model-supplied search term fills
// 「只搜{q_short}」 only after the run's term check; continuations of a model chain (refine,
// withoutCondition) carry the model origin; the server's keyword chains are not checked.
const APP = 'synthetic-app';
const SESSION = 'synthetic-session';
const Q = '合成保温杯加大款双层';
const SHORT = '合成保温杯加大款';

const COPY: Readonly<Record<string, string>> = {
  'agent.suggest.no_result.1': '去掉价格条件再找',
  'agent.suggest.no_result.2': '只搜{q_short}',
  'agent.suggest.no_result.3': '换个平台看看',
};

function chip(text: string) {
  return { text, send_text: text };
}

const WITH_TERM = [chip('去掉价格条件再找'), chip(`只搜${SHORT}`), chip('换个平台看看')];
const WITHOUT_TERM = [chip('去掉价格条件再找'), chip('换个平台看看')];

function input(runId: string): RunBodyInput {
  return {
    caller: {
      appId: APP,
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    sessionId: SESSION,
    runId,
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成续答',
    redactedText: '合成续答' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function request(runId: string): IntentRequest {
  return {
    text: '{}',
    input: input(runId),
    proceed: {
      kind: 'proceed',
      modelText: '合成续答',
      placeholders: Object.freeze({}),
      links: [],
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    },
  };
}

const EMPTY: ToolOutcome = { kind: 'ok', modelView: { items: [] }, cards: [] };

function found(id: string): ToolOutcome {
  return {
    kind: 'ok',
    modelView: { items: [] },
    cards: [
      {
        type: 'product_list',
        schema_version: 1,
        data: { result_set_id: id, items: [{ product_key: 'jd:synthetic' }] },
        fallback_text: '合成商品列表',
      },
    ],
  };
}

function harness() {
  const replies: ToolOutcome[] = [];
  const execute = vi.fn<OrchestratorTools['execute']>(async () => replies.shift() ?? EMPTY);
  const inner: OrchestratorTools = {
    definitions: async () => [],
    execute,
    enabledSearchPlatforms: async () => ['jd'],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  const store = createMemoryResultSetStore();
  const deps: ResultsDeps = {
    store,
    texts: { text: async (_app, key) => COPY[key] ?? key },
    limits: orchestratorLimitsDefaults(),
  };
  const tools = createResultsTools(inner, deps);
  const clarification = createClarification({ ...deps, tools });
  const refinement = createRefinement({ ...deps, tools });
  /** The run's term check (as the core binds it), answering `allowed`. */
  const allows = vi.fn<(term: string) => Promise<boolean>>(async () => true);

  function runSignal(runId: string, bound: boolean): AbortSignal {
    const signal = new AbortController().signal;
    if (bound) bindQueryCheck(signal, runId, { allows });
    return signal;
  }

  /** One call through the decorator in its own run (bound: the core's term check is wired). */
  async function call(
    args: Readonly<Record<string, unknown>>,
    runId: string,
    options: { readonly bound?: boolean; readonly server?: ServerCall } = {},
  ) {
    const id = `call-${runId}`;
    const scope = openServerCall(id, Object.freeze({}));
    const ctx: ToolContext = {
      subject: input(runId).caller,
      runId,
      sessionId: SESSION,
      signal: runSignal(runId, options.bound ?? true),
      placeholders: scope.placeholders,
    };
    const tool: InternalToolCall =
      options.server === undefined
        ? { id, name: 'search_products', args }
        : { id, name: 'search_products', args, [SERVER_CALL]: options.server };
    try {
      return await tools.execute(tool, ctx);
    } finally {
      scope.refs.close();
    }
  }

  function runContext(runId: string, suggestions: unknown[][]): RunContext {
    return {
      runId,
      sessionId: SESSION,
      signal: runSignal(runId, true),
      cardsDelivered: 0,
      text: () => undefined,
      card: async () => undefined,
      suggestions: (items) => {
        suggestions.push([...items]);
      },
      toolStatus: () => undefined,
    };
  }

  /** clarification.withoutCondition in a later run with the term check bound. */
  async function withoutCondition(slot: 'price' | 'platform', runId: string) {
    const suggestions: unknown[][] = [];
    await clarification.withoutCondition(slot, request(runId), runContext(runId, suggestions));
    return suggestions;
  }

  /** A refine continuation (换一批) in a later run with the term check bound. */
  async function nextBatch(runId: string) {
    const suggestions: unknown[][] = [];
    await refinement.run(
      { agent_intent: 'refine', conditions: { next_batch: true } },
      request(runId),
      runContext(runId, suggestions),
    );
    return suggestions;
  }

  return { execute, replies, store, allows, call, withoutCondition, nextBatch };
}

function suggestionsOf(outcome: ToolOutcome): unknown {
  return outcome.kind === 'ok' ? outcome.suggestions : undefined;
}

it('[AC-B3-05s#1][BR-AI-06] model term rejected by the run check: no second suggestion; q_short is what is checked', async () => {
  const h = harness();
  h.allows.mockResolvedValue(false);
  const out = await h.call({ q: Q }, 'run-1');
  expect(suggestionsOf(out)).toEqual(WITHOUT_TERM);
  expect(h.allows).toHaveBeenCalledExactlyOnceWith(SHORT);
});

it('[AC-B3-05s#8][BR-TEXT-22] model term let through by the run check: second suggestion with q_short', async () => {
  const h = harness();
  const out = await h.call({ q: Q }, 'run-1');
  expect(suggestionsOf(out)).toEqual(WITH_TERM);
  expect(h.allows).toHaveBeenCalledExactlyOnceWith(SHORT);
});

it('[AC-B3-05s#1][BR-AI-06] model term outside a core run (no bound check): the guard filters still apply', async () => {
  const h = harness();
  const out = await h.call({ q: '99元合成保温杯' }, 'run-1', { bound: false });
  expect(suggestionsOf(out)).toEqual(WITHOUT_TERM);
  const plain = await h.call({ q: Q }, 'run-2', { bound: false });
  expect(suggestionsOf(plain)).toEqual(WITH_TERM);
  expect(h.allows).not.toHaveBeenCalled();
});

it('[AC-B3-05s#1][BR-TEXT-22] a blank model term is never checked and leaves the second suggestion out', async () => {
  const h = harness();
  const out = await h.call({ q: '  ' }, 'run-1');
  expect(suggestionsOf(out)).toEqual(WITHOUT_TERM);
  expect(h.allows).not.toHaveBeenCalled();
});

it('[AC-B3-05s#9][BR-TEXT-22] the server keyword search is not checked: second suggestion as before', async () => {
  const h = harness();
  h.allows.mockResolvedValue(false);
  const out = await h.call({ q: Q }, 'run-1', {
    server: { kind: 'keyword', chainId: newChainId() },
  });
  expect(suggestionsOf(out)).toEqual(WITH_TERM);
  expect(h.allows).not.toHaveBeenCalled();
});

it('[AC-B3-05s#13][BR-AI-06] a model call starts a model chain; a server keyword chain stays plain', async () => {
  const h = harness();
  await h.call({ q: Q, price_min_fen: 5001, price_max_fen: 5000 }, 'run-1');
  const model = await h.store.currentChain(APP, SESSION);
  expect(model?.status).toBe('awaiting_price');
  expect(isModelChain(model?.chainId ?? '')).toBe(true);
  expect(isModelChain(newChainId())).toBe(false);
  expect(isModelChain(newChainId('model'))).toBe(true);
});

it('[AC-B3-05s#13][BR-AI-06] withoutCondition (price) on a model chain: the inherited term is checked and rejected', async () => {
  const h = harness();
  await h.call({ q: Q, price_min_fen: 5001, price_max_fen: 5000 }, 'run-1');
  expect(h.execute).not.toHaveBeenCalled();
  h.allows.mockResolvedValue(false);
  const suggestions = await h.withoutCondition('price', 'run-2');
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([{ q: Q }]);
  expect(suggestions).toEqual([WITHOUT_TERM]);
  expect(h.allows).toHaveBeenCalledExactlyOnceWith(SHORT);
});

it('[AC-B3-05s#13][BR-TEXT-22] withoutCondition (platform) on a model chain: a term the check lets through is shown', async () => {
  const h = harness();
  h.replies.push(found('synthetic-found'));
  await h.call({ q: Q, platforms: ['jd'] }, 'run-1');
  const suggestions = await h.withoutCondition('platform', 'run-2');
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: Q, platforms: ['jd'] },
    { q: Q },
  ]);
  expect(suggestions).toEqual([WITH_TERM]);
  expect(h.allows).toHaveBeenCalledExactlyOnceWith(SHORT);
});

it('[AC-B3-05s#10][BR-TEXT-22] withoutCondition on a server keyword chain: not checked, second suggestion as before', async () => {
  const h = harness();
  h.replies.push(found('synthetic-found'));
  await h.call({ q: Q, platforms: ['jd'] }, 'run-1', {
    server: { kind: 'keyword', chainId: newChainId() },
  });
  h.allows.mockResolvedValue(false);
  const suggestions = await h.withoutCondition('platform', 'run-2');
  expect(suggestions).toEqual([WITH_TERM]);
  expect(h.allows).not.toHaveBeenCalled();
});

it('[AC-B3-05s#10][BR-AI-06] 换一批 on a model chain: the inherited term is checked and rejected', async () => {
  const h = harness();
  h.replies.push(found('synthetic-found'));
  await h.call({ q: Q }, 'run-1');
  h.allows.mockResolvedValue(false);
  const suggestions = await h.nextBatch('run-2');
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([{ q: Q }, { q: Q, page: 2 }]);
  expect(suggestions).toEqual([WITHOUT_TERM]);
  expect(h.allows).toHaveBeenCalledExactlyOnceWith(SHORT);
});
