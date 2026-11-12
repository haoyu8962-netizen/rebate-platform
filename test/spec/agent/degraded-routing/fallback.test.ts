import { expect, it } from 'vitest';
import { candidate } from '../tools-search/kit.ts';
import { copy, done, empty, kit, noSearch, searched, toolCalls } from './kit.ts';

it.each([
  [100, '你好'],
  [101, '在吗'],
  [102, '谢谢'],
  [103, '你好，谢谢！'],
] as const)('[AC-B3-05n#%i] 只有问候语 %s → welcome，stop，三个快捷问法', async (_id, question) => {
  const h = kit();
  empty(h, await h.run(question, { reason: 'budget' }), 'agent.welcome');
});

it.each([
  [104, '那个怎么样'],
  [105, '它多少钱'],
  [106, '这个多少钱'],
  [107, '哪个卖得最多'],
] as const)(
  '[AC-B3-05n#%i] 指代与疑问词清空 %s → reply.empty，不伪装欢迎',
  async (_id, question) => {
    const h = kit();
    empty(h, await h.run(question, { reason: 'budget' }), 'agent.reply.empty');
  },
);

it.each([
  [108, true],
  [109, false],
] as const)(
  '[AC-B3-05n#%i] 开关 %s：检索词既无不可信定界标签也无长数字占位符',
  async (_id, enabled) => {
    const h = kit();
    h.settings.set('agent.degraded.route_intents', enabled);
    const out = await h.run('纸巾 3812345678901234567', {
      prepared: {
        modelText: '<untrusted>纸巾 <num_1></untrusted>',
        placeholders: { '<num_1>': '3812345678901234567' },
        untrustedInput: true,
      },
    });
    searched(h, out, '纸巾');
    const serialized = JSON.stringify(h.search.searchProducts.mock.calls.map(([q]) => q));
    expect(serialized).not.toMatch(/untrusted|num_1|3812345678901234567|[<>]/u);
  },
);

it.each([
  [110, true, 'fallback'],
  [111, false, 'fallback'],
  [112, true, 'budget'],
  [113, false, 'budget'],
] as const)(
  '[AC-B3-05n#%i] 开关 %s / %s：结果全被禁售类目过滤，用 prohibited',
  async (_id, enabled, finish) => {
    const h = kit();
    h.settings.set('agent.degraded.route_intents', enabled);
    h.search.categoryAllowed.mockResolvedValue(false);
    const out = await h.run('纸巾', { reason: finish === 'budget' ? 'budget' : 'models_failed' });
    done(out, finish);
    expect(h.search.searchProducts).toHaveBeenCalledTimes(3);
    expect(h.search.categoryAllowed).toHaveBeenCalled();
    expect(h.search.assemble).not.toHaveBeenCalled();
    expect(out.cards.some((c) => c.type === 'product_list')).toBe(false);
    const response = out.text() + out.cards.map((c) => c.fallback_text).join('');
    expect(response).toContain(copy('agent.refuse.prohibited'));
    expect(response).not.toContain(copy('agent.degraded.empty'));
    expect(response).not.toContain(copy('agent.degraded'));
    expect(h.text).not.toHaveBeenCalledWith('synthetic-app', 'agent.degraded.empty');
    expect(out.events.some((e) => e.kind === 'suggestions')).toBe(false);
  },
);

it('[AC-B3-05n#114] 一部分禁售但仍有商品，正常出卡，不作禁售说明', async () => {
  const h = kit();
  h.search.categoryAllowed.mockImplementation(async (_app, row) => row.item.platform === 'jd');
  const out = await h.run('纸巾');
  done(out, 'fallback');
  expect(out.cards.find((c) => c.type === 'product_list')?.data['items']).toEqual([
    expect.objectContaining({ product_key: 'jd:one' }),
  ]);
  expect(out.text()).toBe(copy('agent.degraded'));
  expect(out.cards.some((c) => c.data['text_key'] === 'agent.refuse.prohibited')).toBe(false);
});

it('[AC-B3-05n#115] 抽出的 q 命中禁售，不调联盟搜索，不放宽', async () => {
  const h = kit();
  h.search.prohibited.mockImplementation(async (_app, q) => q.includes('电子烟'));
  const out = await h.run('帮我找京东电子烟50元以内');
  done(out, 'fallback');
  expect(h.search.searchProducts).not.toHaveBeenCalled();
  expect(out.text() + out.cards.map((c) => c.fallback_text).join('')).toContain(
    copy('agent.refuse.prohibited'),
  );
  expect(out.cards.some((c) => c.type === 'product_list')).toBe(false);
});

it.each([
  [116, '钱包在哪'],
  [117, '返利一般多久结算'],
  [118, '我的订单返了吗'],
  [119, '余额还有多少'],
  [120, '转人工'],
] as const)('[AC-B3-05n#%i] 开关 off：%s 回到关键词搜索', async (_id, question) => {
  const h = kit();
  h.settings.set('agent.degraded.route_intents', false);
  searched(h, await h.run(question), question);
  expect(outgoingNames(h)).not.toContain('search_rules');
  expect(outgoingNames(h)).not.toContain('handoff_to_human');
});

function outgoingNames(h: ReturnType<typeof kit>) {
  return h.execute.mock.calls.map(([call]) => call.name);
}

it('[AC-B3-05n#121] 开关 off 不抽平台、价格、排序、排除词', async () => {
  const h = kit();
  h.settings.set('agent.degraded.route_intents', false);
  const question = '京东纸巾50元以内返利最高不要香味';
  const out = await h.run(question);
  searched(h, out, question);
  for (const [query] of h.search.searchProducts.mock.calls) {
    expect(query.sort).toBe('relevance');
    expect(query.price_min_fen).toBeUndefined();
    expect(query.price_max_fen).toBeUndefined();
  }
  for (const [call] of toolCalls(h, 'search_products')) {
    expect(call.args).not.toHaveProperty('exclude_keywords');
  }
});

it('[AC-B3-05n#122] 开关 off 仍不搜索纯问候语', async () => {
  const h = kit();
  h.settings.set('agent.degraded.route_intents', false);
  empty(h, await h.run('你好', { reason: 'budget' }), 'agent.welcome');
});

it.each([
  [123, 'absent'],
  [124, 'read_failure'],
] as const)('[AC-B3-05n#%i] 开关读不到（%s）默认 on', async (_id, mode) => {
  const h = kit();
  if (mode === 'read_failure') {
    const read = h.search.configValue.getMockImplementation()!;
    h.search.configValue.mockImplementation(async (app, key) => {
      if (key === 'agent.degraded.route_intents') throw new Error('synthetic unavailable');
      return read(app, key);
    });
  }
  const out = await h.run('查一下我的订单');
  noSearch(h);
  done(out);
  expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
});

it.each([
  [125, 'models_failed', 'fallback'],
  [126, 'model_timeout', 'fallback'],
  [127, 'route_no_model', 'fallback'],
  [128, 'budget', 'budget'],
] as const)('[AC-B3-05n#%i] ⑥ 原因 %s 出卡结束为 %s', async (_id, reason, finish) => {
  const h = kit();
  const out = await h.run('纸巾', { reason });
  done(out, finish);
  expect(out.cards.some((c) => c.type === 'product_list')).toBe(true);
  expect(out.text()).toBe(copy('agent.degraded'));
});

it.each([
  [129, '钱包在哪'],
  [130, '提现最低多少'],
  [131, '我的订单返了吗'],
  [132, '余额还有多少'],
  [133, '转人工'],
] as const)('[AC-B3-05n#%i] 预算用完时 ①–⑤ %s 仍正常 stop', async (_id, question) => {
  const h = kit();
  const out = await h.run(question, { reason: 'budget' });
  noSearch(h);
  done(out);
  expect(out.cards.length).toBeGreaterThan(0);
});

it('[AC-B3-05n#134] 所有平台失败返回50302，fallback_q为清理后关键词', async () => {
  const h = kit();
  h.search.searchProducts.mockRejectedValue(new Error('synthetic upstream unavailable'));
  const out = await h.run('帮我找京东纸巾30元以内');
  expect(out.result).toMatchObject({
    kind: 'error',
    error: { code: 50302, fallback: 'search_page', fallback_q: '纸巾' },
  });
  expect(out.cards).toEqual([]);
  expect(h.search.searchProducts).toHaveBeenCalledTimes(1);
});

it('[AC-B3-05n#135] 部分平台失败仍出卡，不返回50302', async () => {
  const h = kit();
  h.search.searchProducts.mockImplementation(async (q) => {
    if (q.platform !== 'jd') throw new Error('synthetic platform unavailable');
    return [candidate('jd:one', 1000, 'jd')];
  });
  const out = await h.run('纸巾');
  done(out, 'fallback');
  expect(out.cards.find((c) => c.type === 'product_list')?.data['items']).toEqual([
    expect.objectContaining({ product_key: 'jd:one' }),
  ]);
});

it.each([
  [136, false],
  [137, true],
] as const)(
  '[AC-B3-05n#%i] 真实核心预算 %s：无模型分流有输出，trace.model 为空',
  async (_id, budget) => {
    const h = kit();
    const out = await h.core('查一下我的订单', budget);
    expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
    noSearch(h);
    expect(h.orders.searchForAgent).toHaveBeenCalledTimes(1);
    expect(out.traces.at(-1)?.model).toBeNull();
    if (!budget) expect(out.complete).not.toHaveBeenCalled();
  },
);

it.each([
  [138, 'https://demo.invalid/taobao/synthetic-item', false],
  [139, '￥Synthetic01￥', false],
  [140, 'https://demo.invalid/taobao/synthetic-item', true],
  [141, '￥Synthetic01￥', true],
] as const)(
  '[AC-B3-05n#%i] 链接口令 %s 预算 %s：仍走确定性解析路径',
  async (_id, material, budget) => {
    const h = kit();
    const out = await h.core(material, budget);
    expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
    noSearch(h);
    expect(out.quotes).toHaveBeenCalledTimes(1);
    expect(out.complete).not.toHaveBeenCalled();
    expect(out.traces.at(-1)?.model).toBeNull();
  },
);
