// BR-AI-01 细则「意图兜底与不空回复」: the model gave an intent object without calling its tool →
// the server calls the read-only tool itself; replies by the BR-AI-07 templates.
import { expect, it } from 'vitest';
import { item } from '../tools-orders/kit.ts';
import { TODAY, copy, done, intent, kit, tracedCalls, typesOf, type RunView } from './kit.ts';

function noModelText(view: RunView): void {
  expect(view.text).not.toContain('agent_intent');
  expect(view.text).not.toContain('{');
}

it('[AC-B3-05o#1] 已绑手机用户「帮我看看最近的单」只得到 order_query：服务端查今天往前 30 天的订单出卡，文本用 order_list.summary', async () => {
  const h = kit();
  const question = '帮我看看最近的单';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
  expect(h.orders.searchForAgent.mock.calls[0]![1]).toMatchObject({
    date_from: '2026-10-13',
    date_to: TODAY,
  });
  expect(h.orders.findOwnByNumber).not.toHaveBeenCalled();
  expect(typesOf(view)).toEqual(['order_status', 'order_status']);
  expect(view.text).toBe(copy('order_list.summary').replace('{n}', '2'));
  noModelText(view);
});

it.each([
  [2, 7, undefined, '2026-11-05'],
  [3, 120, undefined, '2026-08-14'],
  [4, undefined, 20, '2026-10-23'],
  [5, 45, 60, '2026-09-28'],
] as const)(
  '[AC-B3-05o#%i] 付款日跨度取 agent.orders.default_span_days=%s，不大于 max_span_days=%s（默认 90）：date_from=%s',
  async (_id, span, max, from) => {
    const h = kit();
    if (span !== undefined) h.settings.set('agent.orders.default_span_days', span);
    if (max !== undefined) h.settings.set('agent.orders.max_span_days', max);
    const question = '我最近买的东西返了没';
    h.say(question, [{ text: intent('order_query') }]);
    const view = await h.run(question);
    done(view);
    expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
    expect(h.orders.searchForAgent.mock.calls[0]![1]).toMatchObject({
      date_from: from,
      date_to: TODAY,
    });
  },
);

it('[AC-B3-05o#6] 消息含长数字占位符：改调 explain_order，order_no 连同占位符前后紧挨的字母、数字、连接符一并还原，未点名平台不带 platform', async () => {
  const h = kit();
  const question = '帮我查订单SO-250911223344556-B2返了没';
  h.orders.findOwnByNumber.mockResolvedValue([item({ display_status: 'PAID', reason: null })]);
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
  expect(h.orders.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(h.orders.findOwnByNumber.mock.calls[0]![1]).toEqual({
    order_no: 'SO-250911223344556-B2',
  });
  expect(typesOf(view)).toEqual(['order_status']);
  expect(view.text).toBe(copy('order_status.PAID.summary'));
  noModelText(view);
});

it('[AC-B3-05o#7] 多个长数字占位符时取第一个所在的那一串', async () => {
  const h = kit();
  const question = '订单250911223344556和260911223344557哪个返了';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  expect(h.orders.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(h.orders.findOwnByNumber.mock.calls[0]![1]).toMatchObject({
    order_no: '250911223344556',
  });
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
});

it('[AC-B3-05o#8] 本句点名平台时 platform 取该平台；查不到出 claim_draft 卡，文本 order_reason.NOT_TRACKED.summary', async () => {
  const h = kit();
  const question = '京东订单250911223344556返了吗';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  expect(h.orders.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(h.orders.findOwnByNumber.mock.calls[0]![1]).toEqual({
    order_no: '250911223344556',
    platform: 'jd',
  });
  expect(typesOf(view)).toEqual(['claim_draft']);
  expect(view.text).toBe(copy('order_reason.NOT_TRACKED.summary'));
});

it('[AC-B3-05o#9] 未点名平台且名下查不到（判定规则 7）：文本 order_list.empty，不出卡、不追问；两个不同单号的响应完全相同', async () => {
  const h = kit();
  const first = '帮我查下订单250911223344556';
  const second = '帮我查下订单370922334455667';
  // Both redact to the same model text (帮我查下订单<num_1>), so one script serves both runs.
  h.say(first, [{ text: intent('order_query') }, { text: intent('order_query') }]);
  const a = await h.run(first);
  const b = await h.run(second);
  for (const view of [a, b]) {
    done(view);
    expect(view.cards).toEqual([]);
    expect(view.suggestions).toEqual([]);
    expect(view.text).toBe(copy('order_list.empty'));
  }
  expect(h.orders.findOwnByNumber).toHaveBeenCalledTimes(2);
  for (const [, query] of h.orders.findOwnByNumber.mock.calls) {
    expect(query).not.toHaveProperty('platform');
  }
  expect(b.events).toEqual(a.events);
});

it('[AC-B3-05o#10] earnings_query → 服务端调 get_my_earnings：出 earnings_summary 卡，文本 agent.earnings.summary，文本里没有金额', async () => {
  const h = kit();
  const question = '我余额还有多少';
  h.say(question, [{ text: intent('earnings_query') }]);
  const view = await h.run(question);
  done(view);
  expect(h.readEarnings).toHaveBeenCalledTimes(1);
  expect(h.readEarnings.mock.calls[0]![0]).toEqual({
    appId: 'synthetic-app',
    userId: 'synthetic-user',
  });
  expect(typesOf(view)).toEqual(['earnings_summary']);
  expect(view.text).toBe(copy('agent.earnings.summary'));
  expect(view.text).not.toMatch(/\d/u);
});

it('[AC-B3-05o#11] rule_qa → 服务端调 search_rules，问句取本条消息脱敏后的文字；命中出 rule_ref 卡，文本 agent.rule.found', async () => {
  const h = kit();
  const question = '返利一般什么时候结算';
  h.say(question, [{ text: intent('rule_qa') }]);
  const view = await h.run(question);
  done(view);
  expect(h.chunks).toHaveBeenCalled();
  expect(typesOf(view)).toEqual(['rule_ref']);
  expect(view.text).toBe(copy('agent.rule.found'));
  expect(tracedCalls(view, 'search_rules')).toEqual([
    expect.objectContaining({ args: { question }, status: 'ok', initiator: 'server' }),
  ]);
});

it('[AC-B3-05o#12] handoff → 服务端调 handoff_to_human，出转人工卡', async () => {
  const h = kit();
  const question = '帮我转人工客服';
  h.say(question, [{ text: intent('handoff') }]);
  const view = await h.run(question);
  done(view);
  expect(typesOf(view)).toEqual(['handoff']);
  expect(tracedCalls(view, 'handoff_to_human')).toEqual([
    expect.objectContaining({ status: 'ok', initiator: 'server' }),
  ]);
  noModelText(view);
});

it('[AC-B3-05o#13] search（模型没调工具）→ 按无模型降级 ⑥ 取词检索出卡：只搜点名平台、带价格条件，结束原因 stop', async () => {
  const h = kit();
  const question = '京东纸巾 30元以内';
  h.say(question, [{ text: intent('search') }]);
  const view = await h.run(question);
  done(view, 'stop');
  expect(h.searchProducts.mock.calls.map(([query]) => query.platform)).toEqual(['jd']);
  for (const [query] of h.searchProducts.mock.calls) {
    expect(query).toMatchObject({ q: '纸巾', platform: 'jd', price_max_fen: 3000 });
  }
  expect(typesOf(view)).toContain('product_list');
  noModelText(view);
});

it('[AC-B3-05o#14] find_by_link 但消息里没有链接 → 同样按 ⑥ 取词检索全部已开启平台，结束原因 stop', async () => {
  const h = kit();
  const question = '耳机 50以内';
  h.say(question, [{ text: intent('find_by_link') }]);
  const view = await h.run(question);
  done(view, 'stop');
  expect(h.searchProducts.mock.calls.map(([query]) => query.platform).sort()).toEqual([
    'jd',
    'pdd',
    'taobao',
  ]);
  for (const [query] of h.searchProducts.mock.calls) {
    expect(query).toMatchObject({ q: '耳机', price_max_fen: 5000 });
  }
  expect(typesOf(view)).toContain('product_list');
});

it('[AC-B3-05o#15] 服务端代调的订单查询在留痕里记为服务端发起，参数是服务端算出的日期', async () => {
  const h = kit();
  const question = '帮我看看最近的单';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  expect(view.trace?.intent).toBe('order_query');
  expect(tracedCalls(view, 'list_my_orders')).toEqual([
    expect.objectContaining({
      args: { date_from: '2026-10-13', date_to: TODAY },
      status: 'ok',
      initiator: 'server',
    }),
  ]);
});

it('[AC-B3-05o#16] 模型本轮已调过对应工具时不再代调（只按模板答复）', async () => {
  const h = kit();
  const question = '帮我看看最近的单';
  h.say(question, [
    { calls: [{ name: 'list_my_orders', args: { date_from: '2026-11-01', date_to: TODAY } }] },
    { text: intent('order_query') },
  ]);
  const view = await h.run(question);
  done(view);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
  expect(h.orders.searchForAgent.mock.calls[0]![1]).toMatchObject({ date_from: '2026-11-01' });
  expect(typesOf(view)).toEqual(['order_status', 'order_status']);
  expect(view.text).toBe(copy('order_list.summary').replace('{n}', '2'));
  for (const call of tracedCalls(view, 'list_my_orders')) {
    expect(call).not.toMatchObject({ initiator: 'server' });
  }
});
