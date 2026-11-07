// B3-08p · FU-AGENT-RUN-CACHED-TEXT (D10-888 (b2)) · BR-AI-07 with 02 §9.2「输出上限」: the card cap
// is a point where the run is certain to end. A run offered a template tool that made no template
// call releases its held model text before it reaches the cap (same text as a run without template
// tools offered); a run with a template call, made or only requested (请求即算), delivers no model
// text. The cap counts frames plus embedded products (12 by default); reaching it exactly counts.
// Contract: ./kit.ts header and orchestrator/core/reply-templates.ts.
import { expect, it } from 'vitest';
import {
  LEAD,
  LIMIT,
  NEXT,
  PLAIN_OFFER,
  TEMPLATE_OFFER,
  cardsOf,
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

/** Round 1: an 8-item list (9 cards). Round 2: a 3-item list (4 cards): 13 > 12, not written. */
const OVER: Scenario = {
  steps: [
    { text: LEAD, calls: ['search_products'] },
    { text: NEXT, calls: ['search_products'] },
  ],
  answers: { search_products: [products(8, 'a'), products(3, 'b')] },
};

/** One round: an 8-item list (9 cards), then a 2-item list (3 cards): exactly 12, the cap. */
const EXACT: Scenario = {
  steps: [{ text: LEAD, calls: ['search_products', 'search_products'] }],
  answers: { search_products: [products(8, 'a'), products(2, 'b')] },
};

/** OVER without template tools offered, as delivered before this change (frame by frame). */
const OVER_PLAIN = [
  `text:${LEAD}`,
  'status:search_products:start',
  'status:search_products:end',
  'card:product_list:c1',
  `text:${NEXT}`,
  'status:search_products:start',
  'status:search_products:end',
];

/** EXACT without template tools offered, as delivered before this change (frame by frame). */
const EXACT_PLAIN = [
  `text:${LEAD}`,
  'status:search_products:start',
  'status:search_products:end',
  'card:product_list:c1',
  'status:search_products:start',
  'status:search_products:end',
  'card:product_list:c10',
];

it('[AC-B3-08p#1][AC-B3-08p#5][BR-AI-07] 提供了 search_rules、只调 search_products 的 run，卡片超上限（8 件列表 + 3 件列表，第二张写不下）→ 缓存的工具轮文本「我先看看。」「再看看别的。」在撞上限前放行，done limit，卡片与帧不超上限；不提供模板工具的同一场景逐帧不变', async () => {
  const plain = await rig({ offered: PLAIN_OFFER, ...OVER }).run();
  expect(plain.result).toEqual(LIMIT);
  expect(plain.log).toEqual(OVER_PLAIN);

  const x = rig({ offered: TEMPLATE_OFFER, ...OVER });
  const held = await x.run();
  expect(held.result).toEqual(LIMIT);
  expect(executed(x)).toEqual(['search_products', 'search_products']);
  expect(held.text).toBe(`${LEAD}${NEXT}`);
  expect(held.text).toBe(plain.text);
  expect(cardsOf(held)).toEqual(cardsOf(plain));
  expectWithinCaps(held, x.limits);
  expectReplaced(held, false);
});

it('[AC-B3-08p#1][AC-B3-08p#5][BR-AI-07] 提供了 search_rules、只调 search_products 的 run，卡片恰好到上限 12 张（8 件列表 + 2 件列表）→ 缓存的「我先看看。」在撞上限前放行，两张列表照发，done limit；不提供模板工具的同一场景逐帧不变', async () => {
  const plain = await rig({ offered: PLAIN_OFFER, ...EXACT }).run();
  expect(plain.result).toEqual(LIMIT);
  expect(plain.log).toEqual(EXACT_PLAIN);
  expect(plain.cardsUsed).toBe(12);

  const x = rig({ offered: TEMPLATE_OFFER, ...EXACT });
  const held = await x.run();
  expect(held.result).toEqual(LIMIT);
  expect(held.text).toBe(LEAD);
  expect(cardsOf(held)).toEqual(cardsOf(plain));
  expect(held.cardsUsed).toBe(12);
  expectWithinCaps(held, x.limits);
  expectReplaced(held, false);
});

it('[AC-B3-08p#2][AC-B3-08p#1][BR-AI-07] 同样撞卡片上限，但前一轮已调 search_rules，或本轮 explain_order 排在触界调用之前 → 没有任何模型文本，text_replaced_by_template 与是否写出模板文本一致；对照：同一上限场景只调 search_products 的 run 放行缓存文本', async () => {
  const contrast = await rig({ offered: TEMPLATE_OFFER, ...OVER }).run();
  expect(contrast.result).toEqual(LIMIT);
  expect(contrast.text).toBe(`${LEAD}${NEXT}`);

  const cases: readonly {
    readonly name: string;
    readonly scenario: Scenario;
    readonly template: string;
    readonly cards: readonly string[];
  }[] = [
    {
      name: 'search_rules in the previous round',
      scenario: {
        steps: [
          { text: LEAD, calls: ['search_rules'] },
          { text: NEXT, calls: ['search_products', 'search_products'] },
        ],
        answers: { search_products: [products(8, 'a'), products(3, 'b')] },
      },
      template: fixed('agent.rule.found'),
      cards: ['rule_ref', 'product_list'],
    },
    {
      name: 'explain_order before the capping call in the same round',
      scenario: {
        steps: [{ text: LEAD, calls: ['explain_order', 'search_products', 'search_products'] }],
        answers: { search_products: [products(8, 'a'), products(3, 'b')] },
      },
      template: fixed('order_status.PAID.summary'),
      cards: ['order_status', 'product_list'],
    },
  ];
  for (const c of cases) {
    const x = rig({ offered: TEMPLATE_OFFER, ...c.scenario });
    const view = await x.run();
    expect(view.result, c.name).toEqual(LIMIT);
    expect(view.cardTypes, c.name).toEqual(c.cards);
    expectNoModelText(view, [LEAD, NEXT]);
    // Only the run's template text, if any reached the user before the cap.
    expect(['', c.template], c.name).toContain(view.text);
    expectReplaced(view, view.text !== '');
    expectWithinCaps(view, x.limits);
  }
});

it('[AC-B3-08p#3][BR-AI-07] 请求即算（卡片上限支）：同一轮请求了 [search_products, explain_order]，search_products 的列表写不下（撞卡片上限），explain_order 没执行 → 该轮与前一轮缓存的模型文本都不下发，出订单类兜底句 order_list.empty，done limit', async () => {
  const x = rig({
    offered: TEMPLATE_OFFER,
    steps: [
      { text: LEAD, calls: ['search_products'] },
      { text: NEXT, calls: ['search_products', 'explain_order'] },
    ],
    answers: { search_products: [products(8, 'a'), products(3, 'b')] },
  });
  const view = await x.run();
  expect(view.result).toEqual(LIMIT);
  expect(executed(x)).toEqual(['search_products', 'search_products']);
  expect(view.cardTypes).toEqual(['product_list']);
  expectNoModelText(view, [LEAD, NEXT]);
  expect(view.text).toBe(fixed('order_list.empty'));
  expectReplaced(view, true);
  expectWithinCaps(view, x.limits);
});

it('[AC-B3-08p#3][BR-AI-07] 请求即算（卡片恰好到上限）：同一轮请求了 [search_products, search_products, search_rules]，第二张列表使卡片恰好到 12 张，search_rules 没执行 → 「我先看看。」不下发，出 agent.rule.not_found，两张列表照发，done limit', async () => {
  const x = rig({
    offered: TEMPLATE_OFFER,
    steps: [{ text: LEAD, calls: ['search_products', 'search_products', 'search_rules'] }],
    answers: { search_products: [products(8, 'a'), products(2, 'b')] },
  });
  const view = await x.run();
  expect(view.result).toEqual(LIMIT);
  expect(executed(x)).toEqual(['search_products', 'search_products']);
  expect(view.cardTypes).toEqual(['product_list', 'product_list']);
  expect(view.cardsUsed).toBe(12);
  expectNoModelText(view, [LEAD]);
  expect(view.text).toBe(fixed('agent.rule.not_found'));
  expectReplaced(view, true);
  expectWithinCaps(view, x.limits);
});
