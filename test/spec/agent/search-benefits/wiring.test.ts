import { expect, it, vi } from 'vitest';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createResultsTools } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createToolRegistry } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { createSearchProductsHandler } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import { fixture as resultsFixture } from '../orchestrator-results/kit.ts';
import { candidate, fixture as searchFixture } from '../tools-search/kit.ts';

function fixture() {
  // 联盟有可用的有券商品；关闭淘礼金时不能搜索或拿它作为替代结果。
  const search = searchFixture([
    candidate('synthetic-coupon', 1000, 'taobao', { price_fen: 1100n, coupon_fen: 100n }),
  ]);
  search.settings.set('tlj.enabled', false);
  const handler = createSearchProductsHandler(search.deps);
  const run = vi.fn(handler.run.bind(handler));
  const registry = createToolRegistry({
    handlers: [{ ...handler, run }],
    switches: { get: async () => true },
  });
  const results = resultsFixture();
  // 不伪造工具结果：编排层的每次调用都经过注册表及真实搜索 handler。
  results.execute.mockImplementation((call, ctx) => registry.execute(call, ctx));
  const tools = createResultsTools(results.inner, results.deps);
  return {
    search,
    run,
    execute: results.execute,
    call: (args: Readonly<Record<string, unknown>>) =>
      tools.execute({ id: 'synthetic-tlj-call', name: 'search_products', args }, results.ctx),
  };
}

function expectClosedOutcome(
  h: ReturnType<typeof fixture>,
  outcome: ToolOutcome,
  args: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): void {
  expect(h.search.searchProducts).not.toHaveBeenCalled();
  expect(h.search.assemble).not.toHaveBeenCalled();
  expect(h.search.registered).toEqual([]);
  // 联盟零调用不足以证明没有重试：淘礼金 handler 每次都会直接返回 notice。
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([args]);
  expect(h.run).toHaveBeenCalledTimes(1);
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return;
  // 精确限制卡片集合，同时排除商品卡、relaxed_* 与 no_result notice。
  expect(
    outcome.cards.map((card) => ({ type: card.type, text_key: card.data['text_key'] })),
  ).toEqual(expectedKeys.map((key) => ({ type: 'notice', text_key: key })));
  expect(outcome.suggestions ?? []).toEqual([]);
  expect(outcome.modelView).toMatchObject({
    items: [],
    server_notices: expectedKeys.map((key) => key.slice(key.lastIndexOf('.') + 1)),
  });
}

it('[AC-B3-04k#13] 淘礼金带价格上限经过结果编排仍只出关闭提示，不放宽价格或追加普通建议', async () => {
  const h = fixture();
  const args = { q: '牛奶', benefits: ['taolijin'], price_max_fen: 5000 };
  const outcome = await h.call(args);
  expectClosedOutcome(h, outcome, args, ['agent.notice.tlj_none']);
});

it('[AC-B3-04k#14] 淘礼金不带价格上限经过结果编排不追加无结果提示，保留模型可见关闭提示', async () => {
  const h = fixture();
  const args = { q: '牛奶', benefits: ['taolijin'] };
  const outcome = await h.call(args);
  expectClosedOutcome(h, outcome, args, ['agent.notice.tlj_none']);
});

it('[AC-B3-04k#15] 淘礼金限定京东且有规格与价格上限时不放宽，只保留关闭及淘宝限定提示', async () => {
  const h = fixture();
  const args = {
    q: '牛奶',
    benefits: ['taolijin'],
    platforms: ['jd'],
    spec: '24盒',
    price_max_fen: 5000,
  };
  const outcome = await h.call(args);
  expectClosedOutcome(h, outcome, args, ['agent.notice.tlj_none', 'agent.notice.tlj_taobao_only']);
});
