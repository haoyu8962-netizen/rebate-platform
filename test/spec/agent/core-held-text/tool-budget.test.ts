// B3-08p · FU-AGENT-RUN-CACHED-TEXT (D10-888) · BR-AI-07 请求即算, the tool call budget branch of
// orchestrator/core/run.ts (limits.toolCalls spent: the round's remaining calls are not run, the run
// ends with done limit): a template tool asked for in a round counts as called even when the spent
// budget keeps it from running. That round's and earlier rounds' held model text is not delivered;
// the run writes the template fallback of B3-08m's key selection (rules without a hit →
// agent.rule.not_found; order calls without an order entry → order_list.empty; orders before
// rules). A run that only asked for non-template tools still delivers its held text at that end.
// Contract: ./kit.ts header and orchestrator/core/reply-templates.ts.
import { expect, it } from 'vitest';
import {
  LEAD,
  LIMIT,
  NEXT,
  TEMPLATE_OFFER,
  executed,
  expectNoModelText,
  expectReplaced,
  fixed,
  products,
  rig,
} from './kit.ts';

it('[AC-B3-08p#7][BR-AI-07] 请求即算（次数用尽支）：工具调用上限 1，同一轮请求 [search_products, search_rules]，search_rules 因次数用尽未执行 → 缓存的「我先看看。」不下发，出 agent.rule.not_found，商品卡照发，done limit；对照：同样次数用尽、只请求 search_products 的 run 照发开场白', async () => {
  const contrast = await rig({
    offered: TEMPLATE_OFFER,
    steps: [{ text: LEAD, calls: ['search_products', 'search_products'] }],
    limits: { toolCalls: 1 },
  }).run();
  expect(contrast.result).toEqual(LIMIT);
  expect(contrast.text).toBe(LEAD);
  expectReplaced(contrast, false);

  const x = rig({
    offered: TEMPLATE_OFFER,
    steps: [{ text: LEAD, calls: ['search_products', 'search_rules'] }],
    answers: { search_products: [products(2, 'a')] },
    limits: { toolCalls: 1 },
  });
  const view = await x.run();
  expect(view.result).toEqual(LIMIT);
  expect(executed(x)).toEqual(['search_products']);
  expect(view.cardTypes).toEqual(['product_list']);
  expectNoModelText(view, [LEAD]);
  expect(view.text).toBe(fixed('agent.rule.not_found'));
  expectReplaced(view, true);
});

it('[AC-B3-08p#7][BR-AI-07] 请求即算（次数用尽支）：第一轮「我先看看。」+ search_products 用完 1 次额度，第二轮「再看看别的。」+ search_rules 未执行 → 两轮缓存文本都不下发，出 agent.rule.not_found，done limit', async () => {
  const x = rig({
    offered: TEMPLATE_OFFER,
    steps: [
      { text: LEAD, calls: ['search_products'] },
      { text: NEXT, calls: ['search_rules'] },
    ],
    answers: { search_products: [products(2, 'a')] },
    limits: { toolCalls: 1 },
  });
  const view = await x.run();
  expect(view.result).toEqual(LIMIT);
  expect(executed(x)).toEqual(['search_products']);
  expect(view.cardTypes).toEqual(['product_list']);
  expectNoModelText(view, [LEAD, NEXT]);
  expect(view.text).toBe(fixed('agent.rule.not_found'));
  expectReplaced(view, true);
});

it('[AC-B3-08p#7][BR-AI-07] 请求即算（次数用尽支，订单类）：工具调用上限 1，同一轮请求 [search_products, list_my_orders] 或 [search_products, explain_order]，订单工具未执行 → 「我先看看。」不下发，按 B3-08m 选键出 order_list.empty，done limit', async () => {
  for (const tool of ['list_my_orders', 'explain_order']) {
    const x = rig({
      offered: TEMPLATE_OFFER,
      steps: [{ text: LEAD, calls: ['search_products', tool] }],
      answers: { search_products: [products(2, 'a')] },
      limits: { toolCalls: 1 },
    });
    const view = await x.run();
    expect(view.result, tool).toEqual(LIMIT);
    expect(executed(x), tool).toEqual(['search_products']);
    expect(view.cardTypes, tool).toEqual(['product_list']);
    expectNoModelText(view, [LEAD]);
    expect(view.text, tool).toBe(fixed('order_list.empty'));
    expectReplaced(view, true);
  }
});

it('[AC-B3-08p#7][BR-AI-07] 请求即算与已执行的模板调用合并选键：工具调用上限 2，第一轮 search_rules 命中，第二轮请求 [search_products, explain_order]、explain_order 因次数用尽未执行 → 先 order_list.empty 再 agent.rule.found，模型文本不下发，done limit', async () => {
  const x = rig({
    offered: TEMPLATE_OFFER,
    steps: [
      { text: LEAD, calls: ['search_rules'] },
      { text: NEXT, calls: ['search_products', 'explain_order'] },
    ],
    answers: { search_products: [products(2, 'a')] },
    limits: { toolCalls: 2 },
  });
  const view = await x.run();
  expect(view.result).toEqual(LIMIT);
  expect(executed(x)).toEqual(['search_rules', 'search_products']);
  expect(view.cardTypes).toEqual(['rule_ref', 'product_list']);
  expectNoModelText(view, [LEAD, NEXT]);
  expect(view.text).toBe(`${fixed('order_list.empty')}${fixed('agent.rule.found')}`);
  expectReplaced(view, true);
});
