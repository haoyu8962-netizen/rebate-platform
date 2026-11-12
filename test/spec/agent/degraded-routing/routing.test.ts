import { expect, it } from 'vitest';
import {
  copy,
  done,
  empty,
  kit,
  noSearch,
  searched,
  searchArgs,
  shortcuts,
  toolCalls,
} from './kit.ts';

it.each([
  [1, '钱包在哪', 'Wallet'],
  [2, '提现记录在哪看', 'WithdrawRecords'],
  [3, '淘宝订单在哪看', 'OrderList'],
] as const)('[AC-B3-05n#%i] ① %s → %s 引导卡，不搜索', async (_id, question, route) => {
  const h = kit();
  const out = await h.run(question);
  done(out);
  noSearch(h);
  expect(out.cards).toEqual([
    {
      type: 'page_guide',
      schema_version: 1,
      data: { route, text_key: `agent.guide.${route}` },
      fallback_text: copy(`agent.guide.${route}`),
    },
  ]);
  expect(out.text()).toBe('');
  expect(out.events.filter((e) => e.kind === 'suggestions')).toEqual([]);
  expect(h.execute).not.toHaveBeenCalled();
});

it.each([
  [4, '提现最低多少'],
  [5, '返利一般多久结算'],
  [6, '拼多多返利一般多久结算'],
] as const)('[AC-B3-05n#%i] ② %s → search_rules 与规则卡', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'search_rules')).toHaveLength(1);
  expect(toolCalls(h, 'search_rules')[0]?.[0].args).toEqual({ question });
  expect(h.chunks).toHaveBeenCalledExactlyOnceWith('synthetic-app');
  expect(out.cards.map((c) => c.type)).toEqual(['rule_ref']);
  expect(out.text()).toBe(copy('agent.rule.found'));
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
  expect(h.readEarnings).not.toHaveBeenCalled();
});

it.each([
  [7, '我的订单返了吗'],
  [8, '查一下我的订单'],
  [9, '我的淘宝订单返了吗'],
  [10, '订单超过 15 天还没返'],
] as const)('[AC-B3-05n#%i] ③ %s → 本人订单工具', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'list_my_orders')).toHaveLength(1);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
  expect(out.cards.some((c) => c.type === 'order_status')).toBe(true);
  expect(out.text()).toBe(copy('order_status.PAID.summary'));
  expect(h.readEarnings).not.toHaveBeenCalled();
  expect(h.chunks).not.toHaveBeenCalled();
});

it('[AC-B3-05n#11] ③ 京东订单长数字返了吗 → 单号工具，platform 仅取本句', async () => {
  const h = kit();
  const out = await h.run('京东订单 3812345678901234567 返了吗');
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'explain_order')).toHaveLength(1);
  expect(toolCalls(h, 'explain_order')[0]?.[0].args).toEqual({
    order_no: '<num_1>',
    platform: 'jd',
  });
  expect(h.orders.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.orders.findOwnByNumber.mock.calls)).toContain('3812345678901234567');
  expect(out.cards.some((c) => c.type === 'order_status')).toBe(true);
});

it.each([
  [12, '余额还有多少'],
  [13, '提现到哪了'],
] as const)('[AC-B3-05n#%i] ④ %s → get_my_earnings 与收益卡', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'get_my_earnings')).toHaveLength(1);
  expect(toolCalls(h, 'get_my_earnings')[0]?.[0].args).toEqual({});
  expect(h.readEarnings).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-app',
    userId: 'synthetic-user',
  });
  expect(out.cards.map((c) => c.type)).toEqual(['earnings_summary']);
  expect(out.text()).toBe(copy('agent.earnings.summary'));
  expect(h.orders.searchForAgent).not.toHaveBeenCalled();
});

it.each([
  [14, '转人工'],
  [15, '怎么联系客服'],
] as const)('[AC-B3-05n#%i] ⑤ %s → handoff', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  done(out);
  noSearch(h);
  expect(out.cards.map((c) => c.type)).toEqual(['handoff']);
  expect(out.cards[0]?.data).toEqual({
    entry: 'AgentChat',
    summary: copy('agent.card.handoff.desc'),
  });
});

it.each([
  [16, '京东纸巾哪个返利最高', '纸巾', ['jd'], 'rebate_desc', undefined],
  [17, '钱包多少钱', '钱包', ['taobao', 'jd', 'pdd'], 'relevance', undefined],
  [18, '哪里有卖雨伞', '雨伞', ['taobao', 'jd', 'pdd'], 'relevance', undefined],
  [19, '最多 50 元的耳机', '耳机', ['taobao', 'jd', 'pdd'], 'relevance', 5000],
  [20, '京东 纸巾 30 以内', '纸巾', ['jd'], 'relevance', 3000],
] as const)(
  '[AC-B3-05n#%i] ⑥ %s → 商品检索与明确条件',
  async (_id, question, q, platforms, sort, max) => {
    const h = kit();
    const out = await h.run(question);
    searched(h, out, q, [...platforms]);
    const args = searchArgs(h);
    expect(args).toMatchObject({ q, platforms: [...platforms], sort });
    expect(args['price_max_fen']).toBe(max);
    expect(args['price_min_fen']).toBeUndefined();
    for (const [query] of h.search.searchProducts.mock.calls) expect(query.price_max_fen).toBe(max);
    expect(out.text()).toBe(copy('agent.degraded'));
  },
);

it.each([
  [21, '哪个卖得最多'],
  [22, '这个多少钱'],
] as const)('[AC-B3-05n#%i] ⑥ %s 没有商品词，不搜索', async (_id, question) => {
  const h = kit();
  empty(h, await h.run(question), 'agent.reply.empty');
});

it('[AC-B3-05n#23] 快捷问法 1 从默认文案取字，走找货', async () => {
  const h = kit();
  searched(h, await h.run(shortcuts[0]!), '蓝牙耳机');
});
it('[AC-B3-05n#24] 快捷问法 2 从默认文案取字，走本人订单', async () => {
  const h = kit();
  const out = await h.run(shortcuts[1]!);
  noSearch(h);
  done(out);
  expect(toolCalls(h, 'list_my_orders')).toHaveLength(1);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
});
it('[AC-B3-05n#25] 快捷问法 3 从默认文案取字，出人工卡', async () => {
  const h = kit();
  const out = await h.run(shortcuts[2]!);
  noSearch(h);
  done(out);
  expect(out.cards.map((c) => c.type)).toEqual(['handoff']);
});

it('[AC-B3-05n#26] 一般规则没有命中时出人工卡，不拿问句搜商品', async () => {
  const h = kit();
  h.chunks.mockResolvedValue([]);
  const out = await h.run('提现最低多少');
  noSearch(h);
  done(out);
  expect(toolCalls(h, 'search_rules')).toHaveLength(1);
  expect(out.cards.map((c) => c.type)).toEqual(['handoff']);
});

it.each([
  [160, '提现50元手续费怎么算'],
  [161, '订单一般多久能找回'],
  [162, '邀请奖励怎么算'],
  [163, '账号规则是什么'],
] as const)('[AC-B3-05n#%i] 一般平台规则 %s，价格数字不构成找货证据', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  noSearch(h);
  done(out);
  expect(toolCalls(h, 'search_rules')[0]?.[0].args).toEqual({ question });
  expect(out.cards.map((c) => c.type)).toEqual(['rule_ref']);
});

it.each([
  [164, '人工智能耳机'],
  [165, '客服专用耳机'],
] as const)('[AC-B3-05n#%i] 商品词 %s 不是明确要求转人工', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  searched(h, out, question);
  expect(out.cards.some((c) => c.type === 'handoff')).toBe(false);
});
