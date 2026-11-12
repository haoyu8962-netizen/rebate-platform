import { expect, it } from 'vitest';
import { copy, done, kit, noSearch, searched, toolCalls } from './kit.ts';

it.each([
  [30, 'disabled'],
  [31, 'configuration'],
  [32, 'contract'],
  [33, 'untrusted'],
  [34, 'parameters'],
] as const)('[AC-B3-05n#%i] 页面引导校验 %s 不通过，固定不可用话术', async (_id, failure) => {
  const h = kit();
  if (failure === 'disabled') h.settings.set('agent.page_guide.enabled', false);
  if (failure === 'configuration') h.configured.splice(h.configured.indexOf('Wallet'), 1);
  if (failure === 'contract') h.deps.routes.contract = () => ({ Wallet: { agent_guide: false } });
  const out = await h.run('钱包在哪', {
    prepared: {
      untrustedInput: failure === 'untrusted',
      paramsRequested: failure === 'parameters',
    },
  });
  noSearch(h);
  done(out);
  expect(out.cards).toEqual([]);
  expect(out.text()).toBe(copy('agent.guide.unavailable'));
  expect(h.execute).not.toHaveBeenCalled();
});

it.each([
  [35, '授权管理在哪'],
  [36, '消息中心在哪'],
  [37, '邀请好友在哪'],
] as const)('[AC-B3-05n#%i] %s 不属于无模型分流的三个页面', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  done(out, 'fallback');
  expect(h.search.searchProducts).toHaveBeenCalled();
  expect(out.cards.some((c) => c.type === 'page_guide')).toBe(false);
});

it.each([
  [38, '我的订单返了吗', null, false, 'login'],
  [39, '查一下我的订单', 'synthetic-user', false, 'bind_phone'],
  [40, '余额还有多少', null, false, 'login'],
  [41, '提现到哪了', 'synthetic-user', false, 'bind_phone'],
] as const)(
  '[AC-B3-05n#%i] %s 身份校验先于已关闭的工具：%s/%s/%s',
  async (_id, question, userId, phoneBound, reason) => {
    const h = kit();
    for (const tool of ['list_my_orders', 'explain_order', 'get_my_earnings']) {
      h.settings.set(`agent.tools.${tool}.enabled`, false);
    }
    h.settings.set('agent.page_guide.enabled', false);
    const out = await h.run(question, { caller: { userId, phoneBound }, reason: 'budget' });
    noSearch(h);
    done(out, 'auth_required');
    expect(out.cards.map((c) => c.type)).toEqual(['auth_required']);
    expect(out.cards[0]?.data).toEqual({ platform: null, reason, resume_link_id: null });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.readEarnings).not.toHaveBeenCalled();
    expect(h.orders.searchForAgent).not.toHaveBeenCalled();
    expect(h.orders.findOwnByNumber).not.toHaveBeenCalled();
  },
);

it.each([
  [42, '我的订单返了吗', 'OrderList'],
  [43, '余额还有多少', 'Wallet'],
  [44, '提现到哪了', 'WithdrawRecords'],
] as const)('[AC-B3-05n#%i] 已绑手机但工具关闭：%s → %s', async (_id, question, route) => {
  const h = kit();
  for (const tool of ['list_my_orders', 'explain_order', 'get_my_earnings']) {
    h.settings.set(`agent.tools.${tool}.enabled`, false);
  }
  const out = await h.run(question);
  noSearch(h);
  done(out);
  expect(out.cards.map((c) => c.type)).toEqual(['page_guide']);
  expect(out.cards[0]?.data).toEqual({ route, text_key: `agent.guide.${route}` });
  expect(h.execute).not.toHaveBeenCalled();
});

it('[AC-B3-05n#45] 已绑手机收益工具尚未注册，也回退钱包引导', async () => {
  const h = kit();
  h.missingTools.add('get_my_earnings');
  const out = await h.run('余额还有多少');
  noSearch(h);
  done(out);
  expect(out.cards[0]?.data).toEqual({ route: 'Wallet', text_key: 'agent.guide.Wallet' });
  expect(h.readEarnings).not.toHaveBeenCalled();
});

it('[AC-B3-05n#46] 工具与引导同时关闭，不偷偷查数据或搜索', async () => {
  const h = kit();
  h.settings.set('agent.tools.get_my_earnings.enabled', false);
  h.settings.set('agent.page_guide.enabled', false);
  const out = await h.run('余额还有多少');
  noSearch(h);
  done(out);
  expect(out.cards).toEqual([]);
  expect(out.text()).toBe(copy('agent.guide.unavailable'));
  expect(h.readEarnings).not.toHaveBeenCalled();
});

it.each([
  [47, '返了吗', 'order_query', 'list_my_orders'],
  [48, '到账了吗', 'order_query', 'list_my_orders'],
  [49, '返了吗', 'earnings_query', 'get_my_earnings'],
  [50, '到账了吗', null, 'get_my_earnings'],
] as const)('[AC-B3-05n#%i] 承接问法 %s，上一轮 %s → %s', async (_id, question, previous, tool) => {
  const h = kit();
  h.previousIntent.mockResolvedValue(previous);
  const out = await h.run(question);
  noSearch(h);
  done(out);
  expect(toolCalls(h, tool)).toHaveLength(1);
  expect(h.previousIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        sessionId: 'synthetic-session',
        caller: expect.objectContaining({ appId: 'synthetic-app' }),
      }),
    }),
  );
});

it('[AC-B3-05n#51] 没点名平台的单号，不沿用上一轮平台或猜平台', async () => {
  const h = kit();
  h.previousIntent.mockResolvedValue('order_query');
  const out = await h.run('订单 3812345678901234567 返了吗');
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'explain_order')[0]?.[0].args).toEqual({ order_no: '<num_1>' });
  expect(h.orders.findOwnByNumber).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: 'synthetic-app', user_id: 'synthetic-user' }),
    { order_no: '3812345678901234567' },
  );
});

it.each([
  [52, '我的返利什么时候结算'],
  [53, '余额呢'],
] as const)('[AC-B3-05n#%i] %s 指向本人收益，不当作一般规则', async (_id, question) => {
  const h = kit();
  const out = await h.run(question);
  done(out);
  noSearch(h);
  expect(h.readEarnings).toHaveBeenCalledTimes(1);
  expect(h.chunks).not.toHaveBeenCalled();
});

it('[AC-B3-05n#54] app_id 同时用于配置、工具身份和固定文案', async () => {
  const h = kit();
  const out = await h.run('余额还有多少', {
    caller: { appId: 'synthetic-other-app', userId: 'synthetic-other-user' },
  });
  noSearch(h);
  done(out);
  expect(h.readEarnings).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-other-app',
    userId: 'synthetic-other-user',
  });
  expect(h.search.configValue).toHaveBeenCalledWith(
    'synthetic-other-app',
    'agent.degraded.route_intents',
  );
  expect(h.text.mock.calls.every(([app]) => app === 'synthetic-other-app')).toBe(true);
});

it('[AC-B3-05n#55] 排序说法优先于规则问法和平台名', async () => {
  const h = kit();
  searched(h, await h.run('京东纸巾哪个返利最高'), '纸巾', ['jd']);
  expect(h.chunks).not.toHaveBeenCalled();
});

it('[AC-B3-05n#56] 没给单号按注入时钟查最近30天，不放大本人订单范围', async () => {
  const h = kit();
  const out = await h.run('查一下我的订单');
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'list_my_orders')[0]?.[0].args).toMatchObject({
    date_from: '2026-09-23',
    date_to: '2026-10-23',
  });
  expect(h.orders.searchForAgent).toHaveBeenCalledWith(
    { app_id: 'synthetic-app', user_id: 'synthetic-user' },
    expect.objectContaining({ date_from: '2026-09-23', date_to: '2026-10-23' }),
  );
});

it('[AC-B3-05n#57] 订单日期范围读取配置并受 max_span_days 限制', async () => {
  const h = kit();
  h.settings.set('agent.orders.default_span_days', 90);
  h.settings.set('agent.orders.max_span_days', 7);
  const out = await h.run('查一下我的订单');
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'list_my_orders')[0]?.[0].args).toMatchObject({
    date_from: '2026-10-16',
    date_to: '2026-10-23',
  });
});

it('[AC-B3-05n#58] 查单保留占位符紧邻的字母与连接符，有多个取第一个', async () => {
  const h = kit();
  const out = await h.run('京东订单 AB-3812345678901234567-X 和 4823456789012345678 返了吗');
  done(out);
  noSearch(h);
  expect(toolCalls(h, 'explain_order')[0]?.[0].args).toEqual({
    order_no: 'AB-<num_1>-X',
    platform: 'jd',
  });
  expect(h.orders.findOwnByNumber).toHaveBeenCalledWith(
    { app_id: 'synthetic-app', user_id: 'synthetic-user' },
    { order_no: 'AB-3812345678901234567-X', platform: 'jd' },
  );
});
