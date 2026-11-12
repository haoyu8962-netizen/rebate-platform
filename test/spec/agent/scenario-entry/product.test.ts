// B3-05q · BR-AI-01 细则「情境入口」context.product_key (商品详情「问问 AI」): after the input check
// the server quotes the entry product on the same deterministic path as a link message (1
// rebate_quote card, fresh catalog lookup, BR-AI-05), then handles the typed words as usual: with a
// model the model gets them, without a model the run ends at the card. BR-AI-15 细则: a quote that
// fails for a server-side reason. 编排 D10-1378: later product searches take the platform named
// in this message only, never the entry product's.
import { expect, it } from 'vitest';
import {
  ENTRY_KEY,
  GUEST,
  MEMBER,
  MISSING_KEY,
  UNBOUND,
  content,
  copy,
  intent,
  kit,
  nonNotices,
  personalReads,
  productCards,
  quotedKeys,
  says,
  serialized,
  typesOf,
} from './kit.ts';

const ENTRY = { product_key: ENTRY_KEY } as const;
const QUESTION = '这个值得买吗';
const REPLY = '可以先看看卡片里的信息再决定。';

it.each([
  ['已绑手机', MEMBER],
  ['游客', GUEST],
] as const)(
  '[AC-B3-05q#1][BR-AI-01][BR-AI-05] 有模型（%s）：带 context.product_key 的消息先过输入审核，再按 catalog 重新取数出 1 张入口商品的 rebate_quote 卡，然后文字照常交给模型；模型输入里没有 product_key 的值',
  async (_who, caller) => {
    const h = kit();
    h.say(QUESTION, [says(REPLY)]);
    const view = await h.run(QUESTION, { caller, context: ENTRY });
    expect(quotedKeys(view)).toEqual([ENTRY_KEY]);
    expect(nonNotices(view)).toEqual(['rebate_quote']);
    // The entry card comes first, before anything of the model.
    expect(content(view)[0]).toMatchObject({ kind: 'card', card: { type: 'rebate_quote' } });
    expect(h.readProduct).toHaveBeenCalledTimes(1);
    expect(h.readProduct.mock.calls[0]?.[0]).toBe(ENTRY_KEY);
    // 判定顺序第 1 步 first: the input check ran before the catalog lookup.
    expect(h.check.mock.invocationCallOrder[0]).toBeLessThan(
      h.readProduct.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
    // The words still go to the model; the context value never does.
    expect(h.complete).toHaveBeenCalled();
    expect(serialized(h.complete.mock.calls[0]?.[0].messages)).toContain(QUESTION);
    expect(serialized(h.complete.mock.calls)).not.toContain(ENTRY_KEY);
    expect(view.text).toContain(REPLY);
    expect(h.searchProducts).not.toHaveBeenCalled();
    expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  },
);

it.each([
  ['已绑手机', '钱包在哪', 'no_prompt', MEMBER],
  ['游客', '帮我找合成纸巾', 'no_prompt', GUEST],
  ['未绑手机', '我的订单返了吗', 'no_prompt', UNBOUND],
  ['已绑手机', '返利一般多久结算', 'no_prompt', MEMBER],
  ['已绑手机', '帮我找合成纸巾', 'models_failed', MEMBER],
] as const)(
  '[AC-B3-05q#2][BR-AI-01][BR-AI-14] 无模型降级（%s，「%s」，%s）：入口报价卡出完本轮即结束，不再做问法分流与关键词搜索，结束原因 stop',
  async (_who, question, mode, caller) => {
    const h = kit();
    if (mode === 'no_prompt') h.state.noModel = true;
    else h.say(question, [{ degraded: 'models_failed' }]);
    const view = await h.run(question, { caller, context: ENTRY });
    expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(typesOf(view)).toEqual(['rebate_quote']);
    expect(quotedKeys(view)).toEqual([ENTRY_KEY]);
    expect(h.readProduct).toHaveBeenCalledTimes(1);
    // No 问法分流 (page guide, rules, orders, earnings) and no keyword search after the card.
    expect(h.searchProducts).not.toHaveBeenCalled();
    expect(h.chunks).not.toHaveBeenCalled();
    expect(personalReads(h)).toBe(0);
    expect(view.text).toBe('');
    expect(view.suggestions).toEqual([]);
  },
);

it('[AC-B3-05q#3][BR-AI-05][BR-AI-04] product_key 格式不合法：不查 catalog、不出商品卡；格式合法但 catalog 查不到（已下架）：与链接消息一样不出报价卡、不拿别的商品顶替，文字照常交给模型', async () => {
  const malformed = kit();
  malformed.say(QUESTION, [says(REPLY)]);
  const bad = await malformed.run(QUESTION, { context: { product_key: 'TB::不合法 key#1' } });
  expect(malformed.readProduct).not.toHaveBeenCalled();
  expect(productCards(bad)).toEqual([]);
  expect(malformed.searchProducts).not.toHaveBeenCalled();

  const h = kit();
  h.say(QUESTION, [says(REPLY)]);
  const view = await h.run(QUESTION, { context: { product_key: MISSING_KEY } });
  expect(h.readProduct).toHaveBeenCalledTimes(1);
  expect(h.readProduct.mock.calls[0]?.[0]).toBe(MISSING_KEY);
  expect(productCards(view)).toEqual([]);
  // Only notices may tell the user about it; no substitute product, no keyword search.
  expect(nonNotices(view)).toEqual([]);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(view.text).toContain(REPLY);
});

it('[AC-B3-05q#4][BR-AI-15] 有模型时入口报价因服务端原因失败（上游超时）：出 notice agent.notice.quote_failed，接着把文字交给模型，按那一段的结果以 stop 结束', async () => {
  const h = kit();
  h.state.quoteFailure = new Error('synthetic upstream timeout');
  h.say(QUESTION, [says(REPLY)]);
  const view = await h.run(QUESTION, { context: ENTRY });
  expect(h.readProduct).toHaveBeenCalledTimes(1);
  expect(view.cards).toEqual([
    expect.objectContaining({
      type: 'notice',
      data: expect.objectContaining({ text_key: 'agent.notice.quote_failed' }),
    }),
  ]);
  expect(view.cards[0]?.fallback_text).toBe(copy('agent.notice.quote_failed'));
  expect(h.complete).toHaveBeenCalled();
  expect(view.text).toContain(REPLY);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
});

it('[AC-B3-05q#5][BR-AI-15][BR-AI-14] 无模型时入口报价因服务端原因失败：本轮到此为止，以 error 50401（retryable=false）结束、不出任何卡，不改做关键词搜索', async () => {
  const h = kit();
  h.state.noModel = true;
  h.state.quoteFailure = new Error('synthetic upstream timeout');
  const view = await h.run('帮我找合成纸巾', { context: ENTRY });
  expect(h.readProduct).toHaveBeenCalledTimes(1);
  expect(view.result).toMatchObject({ kind: 'error', error: { code: 50401, retryable: false } });
  expect(view.cards).toEqual([]);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(personalReads(h)).toBe(0);
});

it('[AC-B3-05q#6][BR-AI-01][BR-AI-14] 入口商品是淘宝的、这条文字点名京东：入口卡之后服务端代调的找货只搜京东，不带入口商品的平台', async () => {
  const h = kit();
  const question = '京东纸巾 30元以内';
  h.say(question, [says(intent('search'))]);
  const view = await h.run(question, { context: ENTRY });
  expect(quotedKeys(view)).toEqual([ENTRY_KEY]);
  expect(content(view)[0]).toMatchObject({ kind: 'card', card: { type: 'rebate_quote' } });
  expect(h.searchProducts).toHaveBeenCalled();
  expect(h.searchProducts.mock.calls.map(([query]) => query.platform)).toEqual(['jd']);
  expect(typesOf(view)).toContain('product_list');
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
});

it('[AC-B3-05q#7][BR-AI-01][BR-AI-14] 入口商品是淘宝的、这条文字没点名平台：不从入口商品推平台，找货按全部已开启平台检索', async () => {
  const h = kit();
  const question = '纸巾 30元以内';
  h.say(question, [says(intent('search'))]);
  const view = await h.run(question, { context: ENTRY });
  expect(quotedKeys(view)).toEqual([ENTRY_KEY]);
  expect(h.searchProducts.mock.calls.map(([query]) => query.platform).sort()).toEqual([
    'jd',
    'pdd',
    'taobao',
  ]);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
});
