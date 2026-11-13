// B3-05q implementation unit tests: the core's entry branches (run.ts) over a synthetic entry path.
// No database, no listen.
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from './factories.ts';
import type {
  AgentRunBodyDeps,
  EntryQuoteResult,
  InputProceed,
  OrchestratorTrace,
  ScenarioEntryPath,
} from './ports.ts';

const ENTRY_KEY = 'tb:synthetic-entry';
const ORDER = '0192f3a1-7c00-7000-8000-0000000e0001';

const quoteCard: UnnumberedCard = {
  type: 'rebate_quote',
  schema_version: 1,
  data: {
    product: {
      product_key: ENTRY_KEY,
      platform: 'taobao',
      title: '合成入口商品',
      final_price_fen: 990,
      benefit_tags: ['coupon'],
    },
  },
  fallback_text: '合成',
};

function notice(key: string): UnnumberedCard {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'warn', text_key: key, actions: [] },
    fallback_text: key,
  };
}

function input(context?: Readonly<Record<string, unknown>>): RunBodyInput {
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
    ...(context === undefined ? {} : { context }),
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

type Event = Extract<ModelOutcome, { kind: 'model' }>['events'][number];

function round(
  text: string,
  call?: { readonly name: string; readonly args: unknown },
): ModelOutcome {
  const events: Event[] = [];
  if (text !== '') events.push({ t: 'text_delta', text });
  if (call !== undefined) {
    events.push({
      t: 'tool_call',
      index: 0,
      call: {
        id: 'call-0',
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      },
    });
  }
  return {
    kind: 'model',
    entryId: 'synthetic',
    model: 'synthetic-model',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [],
    events,
  };
}

interface RigOptions {
  readonly quote?: EntryQuoteResult['kind'];
  readonly prompt?: boolean;
  readonly rounds?: ModelOutcome[];
  readonly links?: InputProceed['links'];
}

function rig(options: RigOptions = {}) {
  const log: string[] = [];
  let next = 1;
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: (text) => log.push(`text:${text}`),
    toolStatus: () => undefined,
    card: async (card, delivered) => {
      const id = `c${String(next)}`;
      next += card.type === 'rebate_quote' ? 2 : 1;
      log.push(`card:${card.type}:${String(card.data['text_key'] ?? id)}`);
      delivered?.(id);
    },
    suggestions: () => log.push('suggestions'),
  };
  const product = vi.fn<ScenarioEntryPath['product']>(async (_request, _key, path) => {
    const kind = options.quote ?? 'quoted';
    if (kind === 'quoted') {
      let frame: string | null = null;
      await path.card(quoteCard, (id) => {
        frame = id;
      });
      return { kind, card: quoteCard, frameCardId: frame };
    }
    if (kind === 'answered') {
      await path.card(notice('error.30141'));
      return { kind };
    }
    return kind === 'server_failed' ? { kind: 'server_failed' } : { kind: 'stopped' };
  });
  const order = vi.fn<ScenarioEntryPath['order']>(async (_request, _id, path, report) => {
    report('explain_order', { entry: 'order_id' }, 'ok');
    path.text('合成订单模板');
    return { kind: 'done', finishReason: 'stop' };
  });
  const entry: ScenarioEntryPath = {
    product,
    order,
    quoteFailedNotice: async () => notice('agent.notice.quote_failed'),
    serverFailure: async () => ({
      kind: 'error',
      error: { code: 50401, msg: '合成错误', retryable: false, fallback: null, fallback_q: null },
    }),
  };
  const rounds = [...(options.rounds ?? [round('合成回答')])];
  const complete = vi.fn<AgentRunBodyDeps['model']['complete']>(
    async () => rounds.shift() ?? round(''),
  );
  const execute = vi.fn<AgentRunBodyDeps['tools']['execute']>(async () => ({
    kind: 'ok',
    modelView: {},
    cards: [],
  }));
  const check = vi.fn<AgentRunBodyDeps['inputCheck']['check']>(async () => ({
    kind: 'proceed',
    modelText: '合成问题',
    placeholders: {},
    links: options.links ?? [],
    notices: [],
    untrustedInput: false,
    paramsRequested: false,
  }));
  const degraded = vi.fn<AgentRunBodyDeps['degraded']['run']>(async () => ({
    kind: 'done',
    finishReason: 'fallback',
  }));
  const traces: OrchestratorTrace[] = [];
  const deps: AgentRunBodyDeps = {
    model: { complete },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools: {
      definitions: async () => [
        { name: 'get_rebate_quote', description: 'synthetic', parameters: { type: 'object' } },
      ],
      execute,
      enabledSearchPlatforms: async () => [],
      searchKeyword: async () => ({ results: [], cards: [] }),
    },
    inputCheck: { check },
    degraded: { run: degraded },
    deterministic: {
      run: vi.fn(async () => ({ kind: 'done' as const, finishReason: 'stop' as const })),
    },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => `[${key}]`, toolDisplay: async () => 'synthetic' },
    prompt: {
      current: async () =>
        options.prompt === false ? null : { version: 'synthetic-v1', system: 'synthetic' },
    },
    limits: orchestratorLimitsDefaults(),
    traceMask: (args) => args,
    trace: { record: (_runId, trace) => traces.push(trace) },
    entry,
  };
  const run = (context?: Readonly<Record<string, unknown>>): Promise<RunBodyResult> =>
    createAgentRunBody(deps)(input(context))(ctx);
  return { log, run, product, order, complete, execute, check, degraded, traces, deps };
}

it('[B3-05q][BR-AI-01][BR-AI-14] 商品入口、无模型：入口卡出完即 stop，不进无模型分流；留痕意图 find_by_link', async () => {
  const r = rig({ prompt: false });
  expect(await r.run({ product_key: ENTRY_KEY })).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.log).toEqual(['card:rebate_quote:c1']);
  expect(r.degraded).not.toHaveBeenCalled();
  expect(r.complete).not.toHaveBeenCalled();
  expect(r.traces[0]?.intent).toBe('find_by_link');
  expect(r.traces[0]?.model).toBeNull();
});

it('[B3-05q][BR-AI-15] 商品入口服务端原因失败、无模型：以 error 50401 结束，不出卡', async () => {
  const r = rig({ prompt: false, quote: 'server_failed' });
  expect(await r.run({ product_key: ENTRY_KEY })).toMatchObject({
    kind: 'error',
    error: { code: 50401, retryable: false },
  });
  expect(r.log).toEqual([]);
  expect(r.degraded).not.toHaveBeenCalled();
});

it('[B3-05q][BR-AI-15] 商品入口服务端原因失败、有模型：先出 quote_failed notice 再交模型；模型随后降级也以 stop 结束', async () => {
  const withModel = rig({ quote: 'server_failed' });
  expect(await withModel.run({ product_key: ENTRY_KEY })).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(withModel.log).toEqual(['card:notice:agent.notice.quote_failed', 'text:合成回答']);

  const degrading = rig({
    quote: 'server_failed',
    rounds: [{ kind: 'degraded', reason: 'models_failed', attempts: [] }],
  });
  expect(await degrading.run({ product_key: ENTRY_KEY })).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(degrading.log).toEqual(['card:notice:agent.notice.quote_failed']);
  expect(degrading.degraded).not.toHaveBeenCalled();
});

it('[B3-05q][BR-AI-05] 同一轮模型用入口商品自己的 card_id 再报价：不执行工具、不再出卡，返回这个编号', async () => {
  const r = rig({
    rounds: [round('', { name: 'get_rebate_quote', args: { card_id: 'c2' } }), round('合成回答')],
  });
  expect(await r.run({ product_key: ENTRY_KEY })).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.execute).not.toHaveBeenCalled();
  expect(r.log).toEqual(['card:rebate_quote:c1', 'text:合成回答']);
  const tool = r.complete.mock.calls[1]?.[0].messages.find((m) => m.role === 'tool');
  expect(JSON.parse(tool?.content ?? 'null')).toEqual({
    products: [
      {
        card_id: 'c2',
        title: '<untrusted>合成入口商品</untrusted>',
        platform: 'taobao',
        benefit_tags: ['coupon'],
      },
    ],
  });
  // Another card_id is not the entry's: the tool runs as usual.
  const other = rig({
    rounds: [round('', { name: 'get_rebate_quote', args: { card_id: 'c9' } }), round('合成回答')],
  });
  await other.run({ product_key: ENTRY_KEY });
  expect(other.execute).toHaveBeenCalledTimes(1);
});

it('[B3-05q][BR-AI-01][BR-AI-07] 订单入口：入口路径的结果就是本轮结果，不调模型；留痕意图 order_query、代调记 server', async () => {
  const r = rig();
  expect(await r.run({ order_id: ORDER })).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(r.order).toHaveBeenCalledTimes(1);
  expect(r.order.mock.calls[0]?.[1]).toBe(ORDER);
  expect(r.complete).not.toHaveBeenCalled();
  expect(r.log).toEqual(['text:合成订单模板']);
  expect(r.traces[0]?.intent).toBe('order_query');
  expect(r.traces[0]?.tool_calls).toEqual([
    { name: 'explain_order', args: { entry: 'order_id' }, status: 'ok', initiator: 'server' },
  ]);
});

it('[B3-05q][BR-AI-01] 本条带链接：走链接路径，入口不用；context.text 不交给任何端口', async () => {
  const linked = rig({ links: [{ kind: 'url', raw: 'https://demo.invalid/x', index: 0 }] });
  await linked.run({ product_key: ENTRY_KEY });
  expect(linked.product).not.toHaveBeenCalled();
  expect(linked.deps.deterministic?.run).toHaveBeenCalledTimes(1);

  const clipped = rig();
  await clipped.run({ text: '合成剪贴板' });
  expect(clipped.product).not.toHaveBeenCalled();
  expect(clipped.order).not.toHaveBeenCalled();
  expect(clipped.check.mock.calls[0]?.[0].context).toBeUndefined();
  expect(JSON.stringify(clipped.complete.mock.calls)).not.toContain('合成剪贴板');
});

it('[B3-05q][BR-AI-01] 没有入口路径（旧装配）：context 原样交给工具，不出入口卡', async () => {
  const r = rig({
    rounds: [round('', { name: 'get_rebate_quote', args: { product_key: ENTRY_KEY } }), round('')],
  });
  const { entry, ...rest } = r.deps;
  void entry;
  await createAgentRunBody(rest)(input({ product_key: ENTRY_KEY }))({
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: () => undefined,
    toolStatus: () => undefined,
    card: async () => undefined,
    suggestions: () => undefined,
  });
  expect(r.product).not.toHaveBeenCalled();
  expect(r.execute.mock.calls[0]?.[1].context).toEqual({ product_key: ENTRY_KEY });
});
