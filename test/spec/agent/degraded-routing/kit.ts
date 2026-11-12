import { expect, vi } from 'vitest';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import { createRoutedDegradedPath } from '../../../../apps/api/src/modules/agent/orchestrator/degraded/routing.ts';
import { createAgentBodyAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/body.ts';
import type { RoutedDegradedPathDeps } from '../../../../apps/api/src/modules/agent/orchestrator/degraded/routing.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { InputProceed } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { DegradeReason } from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { redactForModel } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import { extractCandidates } from '../../../../apps/api/src/modules/parsing/index.ts';
import { createDeterministicPath } from '../../../../apps/api/src/modules/agent/orchestrator/deterministic/index.ts';
import type { LinkQuoteRunner } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { createToolRegistry } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import {
  createKeywordSearch,
  createSearchProductsHandler,
} from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import {
  createListMyOrdersHandler,
  createExplainOrderHandler,
} from '../../../../apps/api/src/modules/agent/tools/orders/index.ts';
import {
  createSearchRulesHandler,
  type RuleChunkRow,
} from '../../../../apps/api/src/modules/agent/tools/rules/index.ts';
import {
  createGetMyEarningsHandler,
  type EarningsReads,
} from '../../../../apps/api/src/modules/agent/tools/earnings/index.ts';
import { createHandoffHandler } from '../../../../apps/api/src/modules/agent/tools/handoff/index.ts';
import { context, input, proceed, setup } from '../orchestrator-core/kit.ts';
import { candidate, fixture as searchFixture } from '../tools-search/kit.ts';
import { fixture as orderFixture, item } from '../tools-orders/kit.ts';

// A9 has not registered these keys yet: defaults copied from pinned 08 BR-TEXT-22.
const pendingTexts: Readonly<Record<string, string>> = {
  'agent.reply.empty': '没太听明白。可以说说想买什么，或者把商品链接发给我。',
  'agent.suggest.empty.1': '帮我找蓝牙耳机',
  'agent.suggest.empty.2': '查一下我的订单',
  'agent.suggest.empty.3': '怎么联系客服',
};
export function copy(key: string): string {
  return (dictionary.texts as Readonly<Record<string, string>>)[key] ?? pendingTexts[key] ?? key;
}
export const shortcuts = [1, 2, 3].map((n) => copy(`agent.suggest.empty.${n}`));
export const allPlatforms = ['taobao', 'jd', 'pdd'];

export interface RunOptions {
  reason?: DegradeReason;
  caller?: Partial<AgentCaller>;
  prepared?: Partial<InputProceed>;
}

/** Real search pipeline, registry, rules/orders/earnings/handoff handlers; only data ports fake.
 * No classifier or routing result is supplied by the fixture. Build the SUT inside each it so
 * the new factory's NotImplemented is a test failure, never an import/collection failure.
 */
export function kit() {
  const rows = [
    candidate('tb:one'),
    candidate('jd:one', 1000, 'jd'),
    candidate('pdd:one', 1000, 'pdd'),
  ];
  const search = searchFixture(rows);
  const orders = orderFixture();
  orders.searchForAgent.mockResolvedValue({ orders: [item()], total: 1 });
  orders.findOwnByNumber.mockResolvedValue([item()]);
  const settings = search.settings;
  const configured = [
    'Wallet',
    'WithdrawRecords',
    'OrderList',
    'AuthManage',
    'InviteShare',
    'Messages',
  ];
  const missingTools = new Set<string>();
  const chunks = vi.fn(async (): Promise<readonly RuleChunkRow[]> => [
    {
      chunk_id: 'synthetic-chunk',
      article_id: 'synthetic-article',
      published_version: 1,
      title: '提现返利结算规则',
      text: '合成规则：请以平台公布的规则为准。',
    },
  ]);
  const readEarnings = vi.fn<EarningsReads['read']>(async () => ({
    wallet: {
      available_fen: 1234,
      withdrawable_fen: 1234,
      negative_fen: 0,
      frozen_fen: 0,
      estimated_total_fen: 5678,
      estimated_fen: 5678,
      pending_credit_fen: 0,
      pending_credit_paused_fen: 0,
      next_credit_period: null,
      credit_overdue: false,
      withdrawn_fen: 0,
      risk_paused_reason: null,
      withdraw_enabled: true,
    },
    latestWithdrawal: null,
  }));
  const text = vi.fn(async (_app: string, key: string) => copy(key));
  const texts = { text, toolDisplay: async () => '合成工具状态' };
  const reference = () => 'synthetic-card-ref';
  const searchDeps = { ...search.deps, texts: text };
  const handlers = [
    createSearchProductsHandler(searchDeps),
    createListMyOrdersHandler({ ...orders.deps, texts: text }),
    createExplainOrderHandler({ ...orders.deps, texts: text }),
    createSearchRulesHandler({
      activeChunks: chunks,
      config: async () => 0,
      texts: text,
      cardReference: reference,
    }),
    createGetMyEarningsHandler({
      reads: { read: readEarnings },
      clock: search.clock,
      texts: text,
      cardReference: reference,
    }),
    createHandoffHandler({ texts: text, cardReference: reference }),
  ];
  for (const handler of handlers) settings.set(`agent.tools.${handler.name}.enabled`, true);
  settings.set('agent.page_guide.enabled', true);
  const registry = createToolRegistry({
    handlers,
    switches: { get: async (_app, key) => settings.get(key) !== false },
  });
  const definitions = vi.fn<typeof registry.definitions>(async (app, caller) =>
    (await registry.definitions(app, caller)).filter((d) => !missingTools.has(d.name)),
  );
  const execute = vi.fn(registry.execute);
  const keyword = createKeywordSearch(searchDeps);
  const searchKeyword = vi.fn(keyword.searchKeyword);
  const previousIntent = vi.fn<RoutedDegradedPathDeps['previousIntent']>(async () => null);
  const deps: RoutedDegradedPathDeps = {
    tools: { ...keyword, definitions, execute, searchKeyword },
    texts,
    config: search.deps.config,
    clock: orders.clock,
    routes: { configured: vi.fn(async () => configured), contract: vi.fn(() => bridge.routes) },
    previousIntent,
    errorMsg: async (_app, code) => `合成错误:${code}`,
  };
  function request(question: string, options: RunOptions = {}) {
    const redacted = redactForModel(question);
    const original = input();
    return {
      input: {
        ...original,
        caller: { ...original.caller, ...options.caller },
        text: question,
        redactedText: redacted.text,
      },
      proceed: proceed({
        modelText: redacted.text,
        placeholders: redacted.placeholders,
        ...options.prepared,
      }),
      reason: options.reason ?? 'route_no_model',
    };
  }
  return {
    deps,
    search,
    orders,
    rows,
    settings,
    configured,
    missingTools,
    chunks,
    readEarnings,
    text,
    execute,
    searchKeyword,
    previousIntent,
    request,
    async run(question: string, options: RunOptions = {}) {
      const output = context();
      const result = await createRoutedDegradedPath(deps).run(
        request(question, options),
        output.ctx,
      );
      return {
        ...output,
        result,
        cards: output.events.flatMap((e) => (e.kind === 'card' ? [e.card] : [])),
      };
    },
    async core(question: string, budget = false) {
      const req = request(question, { prepared: { links: extractCandidates(question) } });
      const base = setup([], { proceed: req.proceed, budget });
      const quotes = vi.fn<LinkQuoteRunner['run']>(async () => ({
        kind: 'ok',
        cards: [],
        modelView: {},
      }));
      const output = context();
      const body = createAgentRunBody({
        ...base.deps,
        tools: deps.tools,
        texts,
        prompt: budget ? base.deps.prompt : { current: async () => null },
        degraded: createRoutedDegradedPath(deps),
        deterministic: createDeterministicPath({ quotes: { run: quotes }, texts }),
      });
      const result = await body(req.input)(output.ctx);
      return { ...output, result, quotes, complete: base.complete, traces: base.traces };
    },
    async mounted(question: string) {
      const req = request(question);
      const base = setup([], { proceed: req.proceed });
      const output = context();
      // Existing production seam, independently of the new factory: leaving the new path
      // disconnected must still fail. These are the complete per-run degraded dependencies.
      const assembly = createAgentBodyAssembly({
        ...base.deps,
        ...deps,
        texts,
        prompt: { current: async () => null },
        route: async () => base.route(),
      });
      const result = await assembly.body(req.input)(output.ctx);
      return { ...output, result, complete: base.complete, traces: base.traces };
    },
  };
}

export type Kit = ReturnType<typeof kit>;
export type Output = Awaited<ReturnType<Kit['run']>>;

export function noSearch(h: Kit) {
  expect(h.search.searchProducts).not.toHaveBeenCalled();
  expect(h.searchKeyword).not.toHaveBeenCalled();
  expect(h.execute.mock.calls.some(([call]) => call.name === 'search_products')).toBe(false);
}
export function done(output: Output, reason = 'stop') {
  expect(output.result).toEqual({ kind: 'done', finishReason: reason });
}
export function toolCalls(h: Kit, name: string) {
  return h.execute.mock.calls.filter(([call]) => call.name === name);
}
export function searchArgs(h: Kit): Record<string, unknown> {
  const calls = toolCalls(h, 'search_products');
  expect(calls).toHaveLength(1);
  return calls[0]![0].args as Record<string, unknown>;
}
export function searched(h: Kit, output: Output, q: string, platforms = allPlatforms) {
  done(output, 'fallback');
  expect(h.search.searchProducts.mock.calls.map(([query]) => query.platform).sort()).toEqual(
    [...platforms].sort(),
  );
  for (const [query] of h.search.searchProducts.mock.calls) expect(query.q).toBe(q);
  expect(output.cards.some((c) => c.type === 'product_list')).toBe(true);
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
  expect(h.readEarnings).not.toHaveBeenCalled();
  expect(h.chunks).not.toHaveBeenCalled();
}
export function empty(h: Kit, output: Output, key: string) {
  noSearch(h);
  done(output);
  expect(output.cards).toEqual([]);
  expect(output.text()).toBe(copy(key));
  expect(output.events.filter((e) => e.kind === 'suggestions')).toEqual([
    {
      kind: 'suggestions',
      items: shortcuts.map((text) => ({ text, send_text: text })),
    },
  ]);
}
