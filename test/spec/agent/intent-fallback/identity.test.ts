// BR-AI-01 细则「意图兜底与不空回复」: identity first, then the tool's availability (判定顺序 ③④
// unchanged); the server never calls an order or earnings tool for a guest or an unbound user.
import { expect, it } from 'vitest';
import { GUEST, UNBOUND, done, intent, kit, typesOf, type Kit } from './kit.ts';

function noPersonalReads(h: Kit): void {
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
  expect(h.orders.findOwnByNumber).not.toHaveBeenCalled();
  expect(h.orders.take).not.toHaveBeenCalled();
  expect(h.readEarnings).not.toHaveBeenCalled();
}

it('[AC-B3-05o#17] 游客只得到 order_query → auth_required(login)，不代调订单工具', async () => {
  const h = kit();
  const question = '帮我看看最近的单';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question, { caller: GUEST });
  done(view, 'auth_required');
  noPersonalReads(h);
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'auth_required',
      data: expect.objectContaining({ reason: 'login' }),
    }),
  ]);
});

it('[AC-B3-05o#18] 已登录未绑手机只得到 earnings_query → auth_required(bind_phone)，不读收益', async () => {
  const h = kit();
  const question = '我余额还有多少';
  h.say(question, [{ text: intent('earnings_query') }]);
  const view = await h.run(question, { caller: UNBOUND });
  done(view, 'auth_required');
  noPersonalReads(h);
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'auth_required',
      data: expect.objectContaining({ reason: 'bind_phone' }),
    }),
  ]);
});

it('[AC-B3-05o#19] 游客发来带订单号的消息 → auth_required(login)，不按单号查、不扣每日按单号次数', async () => {
  const h = kit();
  const question = '帮我查订单250911223344556';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question, { caller: GUEST });
  done(view, 'auth_required');
  noPersonalReads(h);
});

it('[AC-B3-05o#20] 已绑手机、两个订单工具都关闭 → 订单页引导卡，不代调', async () => {
  const h = kit();
  h.settings.set('agent.tools.list_my_orders.enabled', false);
  h.settings.set('agent.tools.explain_order.enabled', false);
  const question = '帮我看看最近的单';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  noPersonalReads(h);
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'page_guide',
      data: expect.objectContaining({ route: 'OrderList' }),
    }),
  ]);
});

it('[AC-B3-05o#21] 已绑手机、收益工具关闭 → 钱包引导卡，不读收益', async () => {
  const h = kit();
  h.settings.set('agent.tools.get_my_earnings.enabled', false);
  const question = '我余额还有多少';
  h.say(question, [{ text: intent('earnings_query') }]);
  const view = await h.run(question);
  done(view);
  noPersonalReads(h);
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'page_guide',
      data: expect.objectContaining({ route: 'Wallet' }),
    }),
  ]);
});

it('[AC-B3-05o#22] 规则工具关闭时 rule_qa 不代调 search_rules，也不落到商品检索', async () => {
  const h = kit();
  h.settings.set('agent.tools.search_rules.enabled', false);
  const question = '返利一般什么时候结算';
  h.say(question, [{ text: intent('rule_qa') }]);
  const view = await h.run(question);
  expect(h.chunks).not.toHaveBeenCalled();
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(typesOf(view)).not.toContain('rule_ref');
  expect(view.result.kind).toBe('done');
});
