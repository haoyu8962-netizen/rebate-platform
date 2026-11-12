// B3-05p ④ (D10-1378) · BR-AI-01 细则「判定顺序」④ and「意图兜底与不空回复」: a phone-bound user's
// order_query that the model left without a tool call is served by the server; when the one order
// tool that question needs is switched off, the user gets what they get with both order tools off
// (the OrderList page guide card, [AC-B3-05o#20]), never the 不空回复 fallback and never the other
// order tool:
//   - explain_order on, list_my_orders off, a message without an order number;
//   - list_my_orders on, explain_order off, a message with an order number.
// The oracle is a run of the same message with both order tools off. Production composition as in
// ../intent-fallback/kit.ts.
import { expect, it } from 'vitest';
import {
  content,
  done,
  expectNoEmptyReply,
  intent,
  kit,
  type Kit,
  type RunView,
} from '../intent-fallback/kit.ts';

const RECENT = '帮我看看最近的单';
const BY_NUMBER = '帮我查订单250911223344556返了没';

/** One run of `question` (the model gives only order_query) under the given order switches. */
async function orderQuery(
  question: string,
  switches: { readonly list: boolean; readonly explain: boolean },
): Promise<{ readonly h: Kit; readonly view: RunView }> {
  const h = kit();
  h.settings.set('agent.tools.list_my_orders.enabled', switches.list);
  h.settings.set('agent.tools.explain_order.enabled', switches.explain);
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  return { h, view };
}

function noOrderReads(h: Kit): void {
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
  expect(h.orders.findOwnByNumber).not.toHaveBeenCalled();
  expect(h.orders.take).not.toHaveBeenCalled();
}

function expectOrderListGuide(view: RunView): void {
  done(view);
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'page_guide',
      data: expect.objectContaining({ route: 'OrderList' }),
    }),
  ]);
  expectNoEmptyReply(view);
  expect(view.trace?.tool_calls ?? []).toEqual([]);
}

it('[AC-B3-05p#13][BR-AI-01] explain_order 开、list_my_orders 关：「最近的单」不带单号、模型只给 order_query → 与订单工具全关时一样出 OrderList 引导卡，不是空回复', async () => {
  const partial = await orderQuery(RECENT, { list: false, explain: true });
  noOrderReads(partial.h);
  expectOrderListGuide(partial.view);

  const allOff = await orderQuery(RECENT, { list: false, explain: false });
  expectOrderListGuide(allOff.view);
  expect(content(partial.view)).toEqual(content(allOff.view));
});

it('[AC-B3-05p#14][BR-AI-01] list_my_orders 开、explain_order 关：按单号问、模型只给 order_query → 与订单工具全关时一样出 OrderList 引导卡，不改查订单列表、不扣按单号次数', async () => {
  const partial = await orderQuery(BY_NUMBER, { list: true, explain: false });
  noOrderReads(partial.h);
  expectOrderListGuide(partial.view);

  const allOff = await orderQuery(BY_NUMBER, { list: false, explain: false });
  expectOrderListGuide(allOff.view);
  expect(content(partial.view)).toEqual(content(allOff.view));
});
