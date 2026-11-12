import { expect, it } from 'vitest';
import { allPlatforms, copy, done, kit, noSearch, searchArgs, toolCalls } from './kit.ts';

// BR-AI-08: literal expectations distinguish floor/ceil from round on both bounds.
it.each([
  [166, '耳机 9.94左右', 894, 1094],
  [167, '耳机 9.91左右', 891, 1091],
] as const)('[AC-B3-05n#%i] %s 的下限向下、上限向上取整到分', async (_id, question, min, max) => {
  const h = kit();
  const out = await h.run(question);
  done(out, 'fallback');
  expect(searchArgs(h)).toMatchObject({
    q: '耳机',
    platforms: allPlatforms,
    sort: 'relevance',
    price_min_fen: min,
    price_max_fen: max,
  });
  expect(h.search.searchProducts.mock.calls.map(([query]) => query.platform).sort()).toEqual(
    [...allPlatforms].sort(),
  );
  for (const [query] of h.search.searchProducts.mock.calls) {
    expect(query.q).toBe('耳机');
    expect(query.price_min_fen).toBe(min);
    expect(query.price_max_fen).toBe(max);
  }
});

it('[AC-B3-05n#168] 只有长数字与返了吗也按单号查单，不查收益、不猜平台', async () => {
  const h = kit();
  const out = await h.run('3812345678901234567 返了吗', {
    caller: { phoneBound: true },
  });
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'explain_order')).toHaveLength(1);
  expect(toolCalls(h, 'explain_order')[0]?.[0].args).toEqual({ order_no: '<num_1>' });
  expect(h.orders.findOwnByNumber).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ app_id: 'synthetic-app', user_id: 'synthetic-user' }),
    { order_no: '3812345678901234567' },
  );
  expect(out.cards.map((c) => c.type)).toEqual(['order_status']);
  expect(toolCalls(h, 'get_my_earnings')).toHaveLength(0);
  expect(h.readEarnings).not.toHaveBeenCalled();
});

it.each([
  [169, '那单返了吗'],
  [170, '昨天买的纸巾返了吗'],
] as const)('[AC-B3-05n#%i] %s 没有订单二字仍查本人订单，不查收益', async (_id, question) => {
  const h = kit();
  const out = await h.run(question, { caller: { phoneBound: true } });
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'list_my_orders')).toHaveLength(1);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
  expect(out.cards.map((c) => c.type)).toEqual(['order_status']);
  expect(out.text()).toBe(copy('order_status.PAID.summary'));
  expect(toolCalls(h, 'get_my_earnings')).toHaveLength(0);
  expect(h.readEarnings).not.toHaveBeenCalled();
});

it.each([
  [171, '怎么进钱包', 'Wallet'],
  [172, '提现记录怎么打开', 'WithdrawRecords'],
] as const)('[AC-B3-05n#%i] %s → %s 引导卡，不搜索、不查收益', async (_id, question, route) => {
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
  expect(toolCalls(h, 'get_my_earnings')).toHaveLength(0);
  expect(h.readEarnings).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
});
