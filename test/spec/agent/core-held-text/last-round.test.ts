// B3-08p · FU-AGENT-RUN-CACHED-TEXT (D10-888) · BR-AI-07 请求即算 on the "last round still asks for
// tools" branch of orchestrator/core/run.ts (U-10): the last allowed model round (limits.modelRounds)
// asks for tools, none of its calls is run, the run ends with done limit. When that round asks for
// search_rules or an order tool (no template call before), the template tool counts as called: the
// round's and earlier rounds' held model text is not delivered (e.g. a 「已返利到账」 conclusion,
// BR-AI-07), the run writes the template fallback (orders → order_list.empty, rules →
// agent.rule.not_found) and ends with done limit. A last round asking only for search_products
// delivers its held text exactly as a run without template tools offered. Gate review r1 S2 (U-10).
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
  fixed,
  products,
  rig,
  type RigOptions,
} from './kit.ts';

type Scenario = Omit<RigOptions, 'offered'>;

/** A model conclusion BR-AI-07 forbids (passes the OutputGuard: no amount, link or code). */
const CONCLUSION = '这笔订单已返利到账。';

it('[AC-B3-08p#7][BR-AI-07] 请求即算（最后一轮仍要工具支，U-10）：模型轮上限 1，唯一一轮文本「这笔订单已返利到账。」并请求 explain_order / list_my_orders（或 [search_products, explain_order]），调用都不执行 → 模型文本不下发，出 order_list.empty，done limit；对照：该轮只请求 search_products 时开场白照发、done limit，与不提供模板工具的同一场景逐帧一致', async () => {
  const only: Scenario = {
    steps: [{ text: LEAD, calls: ['search_products'] }],
    limits: { modelRounds: 1 },
  };
  const plain = await rig({ offered: PLAIN_OFFER, ...only }).run();
  expect(plain.result).toEqual(LIMIT);
  expect(plain.log).toEqual([`text:${LEAD}`]);
  const contrast = rig({ offered: TEMPLATE_OFFER, ...only });
  const sent = await contrast.run();
  expect(sent.result).toEqual(LIMIT);
  expect(executed(contrast)).toEqual([]);
  expect(sent.log).toEqual(plain.log);
  expectReplaced(sent, false);

  const requests: readonly (readonly string[])[] = [
    ['explain_order'],
    ['list_my_orders'],
    ['search_products', 'explain_order'],
  ];
  for (const calls of requests) {
    const name = calls.join(',');
    const x = rig({
      offered: TEMPLATE_OFFER,
      steps: [{ text: CONCLUSION, calls }],
      limits: { modelRounds: 1 },
    });
    const view = await x.run();
    expect(view.result, name).toEqual(LIMIT);
    expect(executed(x), name).toEqual([]);
    expect(view.cardTypes, name).toEqual([]);
    expectNoModelText(view, [CONCLUSION, '已返利']);
    expect(view.text, name).toBe(fixed('order_list.empty'));
    expectReplaced(view, true);
  }
});

it('[AC-B3-08p#7][BR-AI-07] 请求即算（最后一轮仍要工具支，U-10）：模型轮上限 2，第一轮「我先看看。」+ search_products，第二轮（最后一轮）「再看看别的。」+ search_rules 不执行 → 两轮缓存文本都不下发，出 agent.rule.not_found，商品卡照发，done limit；对照：第二轮只请求 search_products 时两轮文本照发，文本与卡片和不提供模板工具的同一场景一致', async () => {
  const onlyProducts: Scenario = {
    steps: [
      { text: LEAD, calls: ['search_products'] },
      { text: NEXT, calls: ['search_products'] },
    ],
    answers: { search_products: [products(2, 'a')] },
    limits: { modelRounds: 2 },
  };
  const plain = await rig({ offered: PLAIN_OFFER, ...onlyProducts }).run();
  expect(plain.result).toEqual(LIMIT);
  expect(plain.text).toBe(`${LEAD}${NEXT}`);
  const contrast = rig({ offered: TEMPLATE_OFFER, ...onlyProducts });
  const sent = await contrast.run();
  expect(sent.result).toEqual(LIMIT);
  expect(executed(contrast)).toEqual(['search_products']);
  expect(sent.text).toBe(plain.text);
  expect(cardsOf(sent)).toEqual(cardsOf(plain));
  expectReplaced(sent, false);

  const x = rig({
    offered: TEMPLATE_OFFER,
    steps: [
      { text: LEAD, calls: ['search_products'] },
      { text: NEXT, calls: ['search_rules'] },
    ],
    answers: { search_products: [products(2, 'a')] },
    limits: { modelRounds: 2 },
  });
  const view = await x.run();
  expect(view.result).toEqual(LIMIT);
  expect(executed(x)).toEqual(['search_products']);
  expect(view.cardTypes).toEqual(['product_list']);
  expectNoModelText(view, [LEAD, NEXT]);
  expect(view.text).toBe(fixed('agent.rule.not_found'));
  expectReplaced(view, true);
});
