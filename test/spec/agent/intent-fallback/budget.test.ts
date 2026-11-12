// BR-AI-01 细则「意图兜底与不空回复」: a server-initiated call counts toward the run's 4 tool calls
// (02 §9.1–9.2) and, by order number, toward the daily by-number quota (BR-AI-07 判定规则 4); it is
// traced like a model call and marked as the server's.
import { expect, it } from 'vitest';
import {
  TODAY,
  UNKNOWN_TOOL,
  copy,
  done,
  expectEmptyReply,
  intent,
  kit,
  tracedCalls,
  typesOf,
  unknownCalls,
} from './kit.ts';

it('[AC-B3-05o#23] 模型已用完单轮 4 次工具调用后只给 order_query：不再代调，按不空回复补 agent.reply.empty 与 3 个快捷问法', async () => {
  const h = kit();
  const question = '帮我看看最近的单';
  h.say(question, [unknownCalls(4), { text: intent('order_query') }]);
  const view = await h.run(question);
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
  expect(tracedCalls(view, 'list_my_orders')).toEqual([]);
  expectEmptyReply(view, 'stop');
});

it('[AC-B3-05o#24] 模型用了 3 次后只给 order_query：代调作为第 4 次照常执行', async () => {
  const h = kit();
  const question = '帮我看看最近的单';
  h.say(question, [unknownCalls(3), { text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
  expect(typesOf(view)).toEqual(['order_status', 'order_status']);
  expect(view.text).toBe(copy('order_list.summary').replace('{n}', '2'));
  const calls = view.trace?.tool_calls ?? [];
  expect(calls.map((c) => c.name)).toEqual([
    UNKNOWN_TOOL,
    UNKNOWN_TOOL,
    UNKNOWN_TOOL,
    'list_my_orders',
  ]);
  expect(calls[3]).toMatchObject({
    args: { date_from: '2026-10-13', date_to: TODAY },
    status: 'ok',
    initiator: 'server',
  });
  for (const call of calls.slice(0, 3)) expect(call).not.toMatchObject({ initiator: 'server' });
});

it('[AC-B3-05o#25] 上限已用完时 search 意图同样不代调检索，补不空回复', async () => {
  const h = kit();
  const question = '耳机 50以内';
  h.say(question, [unknownCalls(4), { text: intent('search') }]);
  const view = await h.run(question);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expectEmptyReply(view, 'stop');
});

it('[AC-B3-05o#26] 上限已用完时 earnings_query 不代调收益工具，补不空回复', async () => {
  const h = kit();
  const question = '我余额还有多少';
  h.say(question, [unknownCalls(4), { text: intent('earnings_query') }]);
  const view = await h.run(question);
  expect(h.readEarnings).not.toHaveBeenCalled();
  expectEmptyReply(view, 'stop');
});

it('[AC-B3-05o#27] 按单号代调计入每天按单号查询上限：扣 1 次', async () => {
  const h = kit();
  const question = '帮我查订单250911223344556';
  h.say(question, [{ text: intent('order_query') }]);
  await h.run(question);
  expect(h.orders.take).toHaveBeenCalledTimes(1);
  expect(h.orders.take.mock.calls[0]).toEqual(['synthetic-app', 'synthetic-user']);
});

it('[AC-B3-05o#28] 按单号代调超出每日上限：不查订单，文本 agent.order.lookup_limited，不出卡', async () => {
  const h = kit();
  h.orders.take.mockResolvedValue(false);
  const question = '帮我查订单250911223344556';
  h.say(question, [{ text: intent('order_query') }]);
  const view = await h.run(question);
  done(view);
  expect(h.orders.findOwnByNumber).not.toHaveBeenCalled();
  expect(view.cards).toEqual([]);
  expect(view.text).toBe(copy('agent.order.lookup_limited'));
  expect(tracedCalls(view, 'explain_order')).toEqual([
    expect.objectContaining({ initiator: 'server' }),
  ]);
});

it('[AC-B3-05o#29] 按日期代调的订单列表不扣按单号查询次数', async () => {
  const h = kit();
  const question = '帮我看看最近的单';
  h.say(question, [{ text: intent('order_query') }]);
  await h.run(question);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
  expect(h.orders.take).not.toHaveBeenCalled();
});
