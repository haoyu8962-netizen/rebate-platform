// B3-05n (实现第 2 轮): the routed no-model path inside the core. The intent it routed a message
// to becomes the run's trace intent, so the next run's 承接 (previousIntent, agent_runs.intent)
// reads it: 「查一下我的订单」 (③) then 「返了吗」 stays ③ and never goes to ④.
import { bridge } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext } from '../../stream/run/index.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from '../core/factories.ts';
import type {
  AgentRunBodyDeps,
  OrchestratorToolCall,
  OrchestratorTools,
  OrchestratorTrace,
  ToolContext,
  ToolOutcome,
} from '../core/ports.ts';
import { cardReference } from '../core/card-references.ts';
import { createRoutedDegradedPath, type RoutedDegradedPathDeps } from './routing.ts';

const APP = 'synthetic-app';
const TOOLS = [
  'list_my_orders',
  'explain_order',
  'get_my_earnings',
  'search_rules',
  'handoff_to_human',
  'search_products',
];

function input(text: string, runId: string): RunBodyInput {
  return {
    caller: {
      appId: APP,
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: 'synthetic-user',
      phoneBound: true,
    },
    sessionId: 'synthetic-session',
    runId,
    userMessageId: `${runId}-user`,
    assistantMessageId: `${runId}-assistant`,
    text,
    redactedText: text as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function context(runId: string): RunContext {
  return {
    runId,
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: () => undefined,
    toolStatus: () => undefined,
    card: async () => undefined,
    suggestions: () => undefined,
  };
}

/** Two runs of one session. agent_runs.intent is played by the traces the core records. */
function session(settings: Readonly<Record<string, boolean>> = {}) {
  const traces = new Map<string, OrchestratorTrace>();
  const order: string[] = [];
  // Production handlers number their cards through the core's cardReference, which only works
  // inside a call scope (core/card-references.ts): every call records whether it had one.
  const scoped: boolean[] = [];
  const execute = vi.fn(
    async (_call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome> => {
      try {
        cardReference(ctx, 0);
        scoped.push(true);
      } catch {
        scoped.push(false);
      }
      return { kind: 'ok', modelView: {}, cards: [] };
    },
  );
  const tools: OrchestratorTools = {
    definitions: async () =>
      TOOLS.map((name) => ({ name, description: 'synthetic', parameters: { type: 'object' } })),
    execute,
    enabledSearchPlatforms: async () => ['taobao', 'jd', 'pdd'],
    searchKeyword: async (plan) => ({
      results: plan.platforms.map((platform) => ({ platform, ok: true as const, items: [] })),
      cards: [],
    }),
  };
  const texts = { text: async (_app: string, key: string) => key, toolDisplay: async () => '' };
  const previousIntent = vi.fn<RoutedDegradedPathDeps['previousIntent']>(async (request) => {
    const before = order.filter((id) => id !== request.input.runId).at(-1);
    const intent = before === undefined ? null : (traces.get(before)?.intent ?? null);
    return intent === 'order_query' || intent === 'earnings_query' ? intent : null;
  });
  const routed: RoutedDegradedPathDeps = {
    tools,
    texts,
    errorMsg: async (_app, code) => `synthetic-${code}`,
    clock: new FixedClock('2031-01-02T03:04:05+08:00'),
    config: {
      configValue: async (_app, key) => {
        const value = settings[key];
        return value === undefined ? null : { value, version: 1 };
      },
    },
    routes: {
      configured: async () => ['Wallet', 'WithdrawRecords', 'OrderList'],
      contract: () => bridge.routes,
    },
    previousIntent,
  };
  const deps: AgentRunBodyDeps = {
    model: {
      complete: vi.fn(
        async () => ({ kind: 'degraded', reason: 'route_no_model', attempts: [] }) as const,
      ),
    },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools,
    inputCheck: {
      check: async (run) => ({
        kind: 'proceed',
        modelText: run.redactedText,
        placeholders: {},
        links: [],
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      }),
    },
    degraded: createRoutedDegradedPath(routed),
    review: { review: async () => 'pass' },
    texts,
    prompt: { current: async () => null },
    limits: orchestratorLimitsDefaults(),
    traceMask: (args) => args,
    trace: { record: (runId, trace) => traces.set(runId, trace) },
  };
  const body = createAgentRunBody(deps);
  return {
    execute,
    scoped,
    previousIntent,
    called: () => execute.mock.calls.map(([call]) => call.name),
    async ask(text: string) {
      const runId = `synthetic-run-${order.length + 1}`;
      order.push(runId);
      execute.mockClear();
      const result = await body(input(text, runId))(context(runId));
      return { result, intent: traces.get(runId)?.intent };
    },
  };
}

it('[AC-B3-05n][BR-AI-14] 两轮衔接：第一轮降级 ③ 记 order_query，第二轮「返了吗」承接走 ③ 不走 ④', async () => {
  const s = session();
  const first = await s.ask('查一下我的订单');
  expect(first.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(first.intent).toBe('order_query');
  expect(s.called()).toEqual(['list_my_orders']);

  const second = await s.ask('返了吗');
  expect(s.previousIntent).toHaveBeenCalledTimes(1);
  await expect(s.previousIntent.mock.results[0]!.value).resolves.toBe('order_query');
  expect(s.called()).toEqual(['list_my_orders']);
  expect(s.called()).not.toContain('get_my_earnings');
  expect(second.intent).toBe('order_query');
  // Each tool call of the no-model path ran in its own card-reference scope.
  expect(s.scoped).toEqual([true, true]);
});

it('[AC-B3-05n][BR-AI-14] 两轮衔接：上一轮是 ④ 时「返了吗」按 ④，本轮也记 earnings_query', async () => {
  const s = session();
  expect((await s.ask('我的余额还有多少')).intent).toBe('earnings_query');
  const second = await s.ask('返了吗');
  expect(s.called()).toEqual(['get_my_earnings']);
  expect(second.intent).toBe('earnings_query');
});

it('[AC-B3-05n][BR-AI-14] 降级分流的意图逐个记进本轮 trace：① page_guide ② rule_qa ⑤ handoff ⑥ search', async () => {
  const s = session({ 'agent.page_guide.enabled': true });
  expect((await s.ask('钱包在哪')).intent).toBe('page_guide');
  expect((await s.ask('提现一般多久到账')).intent).toBe('rule_qa');
  expect((await s.ask('转人工')).intent).toBe('handoff');
  expect((await s.ask('纸巾')).intent).toBe('search');
});

it('[AC-B3-05n][BR-AI-14] 开关 agent.degraded.route_intents 关：不分流，本轮意图仍是 search', async () => {
  const s = session({ 'agent.degraded.route_intents': false });
  expect((await s.ask('查一下我的订单')).intent).toBe('search');
  expect(s.called()).not.toContain('list_my_orders');
});
