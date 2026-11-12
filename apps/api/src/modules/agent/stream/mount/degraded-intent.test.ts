// B3-05n (实现第 5 轮) · BR-AI-14 细则「无模型降级」: through the stream entry's real body assembly
// (createAgentBodyAssembly, the one the runtime and the local evaluation use), the intent the
// routed no-model path serves a message as becomes the run's trace intent, so the next run's 承接
// (previousIntent, played here by the traces the core recorded) reads it: 「查一下我的订单」 (③) then
// 「返了吗」 stays ③ and never asks get_my_earnings. The path registers the intent on the very
// context the core handed its run (core/degraded-intent.ts): a layer that replaced that context
// on the way would leave the first run's intent `search` and turn the second run into ④.
// Synthetic ports only; no database is queried.
import { bridge } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { RunBodyInput } from '../../http/index.ts';
import type {
  OrchestratorToolCall,
  OrchestratorTools,
  OrchestratorTrace,
} from '../../orchestrator/core/ports.ts';
import type { RedactedText } from '../admission/index.ts';
import type { RunContext } from '../run/index.ts';
import { createAgentBodyAssembly, type AgentBodyAssemblyDeps } from './body.ts';

const APP = 'synthetic-app';
const TOOLS = ['list_my_orders', 'explain_order', 'get_my_earnings', 'search_rules'];

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

/** One session on the assembled body; agent_runs.intent is played by the recorded traces. */
function session() {
  const traces = new Map<string, OrchestratorTrace>();
  const order: string[] = [];
  const calls: string[] = [];
  const tools: OrchestratorTools = {
    definitions: async () =>
      TOOLS.map((name) => ({ name, description: 'synthetic', parameters: { type: 'object' } })),
    execute: async (call: OrchestratorToolCall) => {
      calls.push(call.name);
      return { kind: 'ok', modelView: {}, cards: [] };
    },
    enabledSearchPlatforms: async () => ['taobao', 'jd', 'pdd'],
    searchKeyword: async (plan) => ({
      results: plan.platforms.map((platform) => ({ platform, ok: true as const, items: [] })),
      cards: [],
    }),
  };
  const texts = { text: async (_app: string, key: string) => key, toolDisplay: async () => '' };
  const previousIntent = vi.fn<NonNullable<AgentBodyAssemblyDeps['previousIntent']>>(
    async (request) => {
      const before = order.filter((id) => id !== request.input.runId).at(-1);
      const intent = before === undefined ? null : (traces.get(before)?.intent ?? null);
      return intent === 'order_query' || intent === 'earnings_query' ? intent : null;
    },
  );
  const assembly = createAgentBodyAssembly({
    model: {
      complete: async () => ({ kind: 'degraded', reason: 'route_no_model', attempts: [] }),
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
    review: { review: async () => 'pass' },
    texts,
    prompt: { current: async () => null },
    trace: { record: (runId, trace) => traces.set(runId, trace) },
    errorMsg: async (_app, code) => `synthetic-${code}`,
    route: async () => ({ mode: 'no_model', attempts: [], dropped: [] }),
    config: { configValue: async () => null },
    clock: new FixedClock('2031-01-02T03:04:05+08:00'),
    routes: {
      configured: async () => ['Wallet', 'WithdrawRecords', 'OrderList'],
      contract: () => bridge.routes,
    },
    previousIntent,
  });
  return {
    previousIntent,
    async ask(text: string) {
      const runId = `synthetic-run-${order.length + 1}`;
      order.push(runId);
      calls.length = 0;
      const result = await assembly.body(input(text, runId))(context(runId));
      return { result, intent: traces.get(runId)?.intent, called: [...calls] };
    },
  };
}

it('[AC-B3-05n][BR-AI-14] 经组装根两轮：第一轮无模型「查一下我的订单」分到 ③ 记 order_query，第二轮「返了吗」承接 ③、不调 get_my_earnings', async () => {
  const s = session();
  const first = await s.ask('查一下我的订单');
  expect(first.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(first.intent).toBe('order_query');
  expect(first.called).toEqual(['list_my_orders']);

  const second = await s.ask('返了吗');
  expect(s.previousIntent).toHaveBeenCalledTimes(1);
  await expect(s.previousIntent.mock.results[0]!.value).resolves.toBe('order_query');
  expect(second.called).toEqual(['list_my_orders']);
  expect(second.called).not.toContain('get_my_earnings');
  expect(second.intent).toBe('order_query');
});
