// B3-08p · FU-AGENT-RUN-CACHED-TEXT (D10-888) · BR-AI-07 请求即算 when the template tool is not the
// call that is stopped: a round asks for a template tool *behind* an ordinary call, and the run
// ends at that ordinary call (tool call budget spent, or its card reaching / passing the card cap).
// The template tool is still asked for in the round, so it counts as called: that round's and
// earlier rounds' held model text is not delivered; the run writes the template fallback of
// B3-08m's key selection (rules → agent.rule.not_found, orders → order_list.empty) and ends with
// done limit. Gate review r1 S1. Contract: ./kit.ts header and orchestrator/core/reply-templates.ts.
import { expect, it } from 'vitest';
import {
  LEAD,
  LIMIT,
  NEXT,
  TEMPLATE_OFFER,
  executed,
  expectNoModelText,
  expectReplaced,
  expectWithinCaps,
  fixed,
  products,
  rig,
  type RigOptions,
} from './kit.ts';

type Scenario = Omit<RigOptions, 'offered'>;

interface Case {
  readonly name: string;
  readonly scenario: Scenario;
  readonly executed: readonly string[];
  readonly cards: readonly string[];
  readonly template: string;
}

it('[AC-B3-08p#7][BR-AI-07] 请求即算（次数用尽支，模板工具与被拦下的调用隔一个普通调用）：工具调用上限 1，本轮请求 [search_products, search_products, search_rules / list_my_orders]，第二个 search_products 因次数用尽被拦下、模板工具排在它后面 → 该轮及之前缓存的模型文本不下发，出对应模板兜底句，done limit；对照：只请求 search_products 的同一场景照发开场白', async () => {
  const contrast = await rig({
    offered: TEMPLATE_OFFER,
    steps: [{ text: LEAD, calls: ['search_products', 'search_products', 'search_products'] }],
    answers: { search_products: [products(2, 'a')] },
    limits: { toolCalls: 1 },
  }).run();
  expect(contrast.result).toEqual(LIMIT);
  expect(contrast.text).toBe(LEAD);
  expectReplaced(contrast, false);

  const cases: readonly Case[] = [
    {
      name: 'one round, search_rules behind the stopped search_products',
      scenario: {
        steps: [{ text: LEAD, calls: ['search_products', 'search_products', 'search_rules'] }],
        answers: { search_products: [products(2, 'a')] },
        limits: { toolCalls: 1 },
      },
      executed: ['search_products'],
      cards: ['product_list'],
      template: fixed('agent.rule.not_found'),
    },
    {
      name: 'two rounds, search_rules behind the stopped search_products of round 2',
      scenario: {
        steps: [
          { text: LEAD, calls: ['search_products'] },
          { text: NEXT, calls: ['search_products', 'search_rules'] },
        ],
        answers: { search_products: [products(2, 'a')] },
        limits: { toolCalls: 1 },
      },
      executed: ['search_products'],
      cards: ['product_list'],
      template: fixed('agent.rule.not_found'),
    },
    {
      name: 'one round, list_my_orders behind the stopped search_products',
      scenario: {
        steps: [{ text: LEAD, calls: ['search_products', 'search_products', 'list_my_orders'] }],
        answers: { search_products: [products(2, 'a')] },
        limits: { toolCalls: 1 },
      },
      executed: ['search_products'],
      cards: ['product_list'],
      template: fixed('order_list.empty'),
    },
  ];
  for (const c of cases) {
    const x = rig({ offered: TEMPLATE_OFFER, ...c.scenario });
    const view = await x.run();
    expect(view.result, c.name).toEqual(LIMIT);
    expect(executed(x), c.name).toEqual(c.executed);
    expect(view.cardTypes, c.name).toEqual(c.cards);
    expectNoModelText(view, [LEAD, NEXT]);
    expect(view.text, c.name).toBe(c.template);
    expectReplaced(view, true);
  }
});

it('[AC-B3-08p#3][BR-AI-07] 请求即算（卡片上限支，模板工具与触界调用隔一个普通调用）：本轮请求 [search_products, search_products, explain_order / search_rules]，第一张列表就触到卡片上限（恰好 12 张或写不下）、本轮后面的 search_products 与模板工具都没执行 → 该轮及之前缓存的模型文本不下发，出对应模板兜底句，done limit，卡片不超上限', async () => {
  const cases: readonly Case[] = [
    {
      name: 'first list reaches the cap exactly (11 items, 12 cards), explain_order two calls later',
      scenario: {
        steps: [{ text: LEAD, calls: ['search_products', 'search_products', 'explain_order'] }],
        answers: { search_products: [products(11, 'a')] },
      },
      executed: ['search_products'],
      cards: ['product_list'],
      template: fixed('order_list.empty'),
    },
    {
      name: 'first list overflows the cap (12 items, 13 cards), explain_order two calls later',
      scenario: {
        steps: [{ text: LEAD, calls: ['search_products', 'search_products', 'explain_order'] }],
        answers: { search_products: [products(12, 'a')] },
      },
      executed: ['search_products'],
      cards: [],
      template: fixed('order_list.empty'),
    },
    {
      name: 'round 2: its first list overflows the cap (9 + 4 cards), search_rules two calls later',
      scenario: {
        steps: [
          { text: LEAD, calls: ['search_products'] },
          { text: NEXT, calls: ['search_products', 'search_products', 'search_rules'] },
        ],
        answers: { search_products: [products(8, 'a'), products(3, 'b')] },
      },
      executed: ['search_products', 'search_products'],
      cards: ['product_list'],
      template: fixed('agent.rule.not_found'),
    },
  ];
  for (const c of cases) {
    const x = rig({ offered: TEMPLATE_OFFER, ...c.scenario });
    const view = await x.run();
    expect(view.result, c.name).toEqual(LIMIT);
    expect(executed(x), c.name).toEqual(c.executed);
    expect(view.cardTypes, c.name).toEqual(c.cards);
    expectNoModelText(view, [LEAD, NEXT]);
    expect(view.text, c.name).toBe(c.template);
    expectReplaced(view, true);
    expectWithinCaps(view, x.limits);
  }
});
