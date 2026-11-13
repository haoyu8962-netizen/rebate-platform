// B3-05q · BR-AI-01 细则「情境入口」context.product_key (商品详情「问问 AI」): after the input check
// the server quotes the entry product on the same deterministic path as a link message (1
// rebate_quote card, fresh catalog lookup, BR-AI-05), then handles the typed words as usual: with a
// model the model gets them, without a model the run ends at the card. BR-AI-15 细则: a quote that
// fails for a server-side reason. 编排 D10-1378: later product searches take the platform named
// in this message only, never the entry product's.
// Attempt 2 (spec review r1): the entry card is the session's card (BR-AI-05: the model quotes it
// again by its product's own card_id; in the same run that gives back the same id, no second
// card), and a delisted entry product is handled as a delisted link is (the deterministic link
// path's notice, done stop; with and without a model).
import { expect, it } from 'vitest';
import { OFF_SHELF } from '../../../../apps/api/src/modules/parsing/index.ts';
import { DemoUnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  ENTRY_KEY,
  GUEST,
  LINK,
  MEMBER,
  MISSING_KEY,
  UNBOUND,
  comparable,
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
  type Kit,
  type RunView,
} from './kit.ts';

const ENTRY = { product_key: ENTRY_KEY } as const;
const QUESTION = '这个值得买吗';
const REPLY = '可以先看看卡片里的信息再决定。';
/** The entry card is the session's first frame (c1); its product takes the next number (04 §8.2
 * numberCard): the product's own card_id, the one the model may quote again (BR-AI-05). */
const ENTRY_FRAME_CARD = 'c1';
const ENTRY_PRODUCT_CARD = 'c2';

/** The tool results handed back to the model in the last model call (role tool, parsed). */
function toolResults(h: Kit): unknown[] {
  const last = h.complete.mock.calls.at(-1)?.[0];
  return (last?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(message.content ?? 'null') as unknown);
}

/** Every value under a `card_id` key, depth first. */
function cardIdsIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((inner: unknown) => cardIdsIn(inner));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, inner]) =>
      key === 'card_id' ? [inner] : cardIdsIn(inner),
    );
  }
  return [];
}

/** The product card_id of the run's first rebate_quote card. */
function quotedProductCard(view: RunView): unknown {
  const quote = view.cards.find((c) => c.type === 'rebate_quote');
  return (quote?.data['product'] as Readonly<Record<string, unknown>> | undefined)?.['card_id'];
}

/** Notice frames as the user sees them (no card numbers), in order. */
function noticeFrames(view: RunView): unknown[] {
  return comparable(view.events.filter((e) => e.kind === 'card' && e.card.type === 'notice'));
}

/**
 * A message carrying its own link whose product the union reports delisted (the demo adapter's
 * delisted answer: 30141, a business answer about the product, not a server fault), through the
 * real deterministic link path. Anchors what "handled like a link message" means here.
 */
async function delistedLink(noModel: boolean): Promise<RunView> {
  const link = kit();
  link.state.noModel = noModel;
  link.resolveLink.mockRejectedValue(
    new DemoUnionError('demo_delisted', 'synthetic: delisted at the union', 'taobao'),
  );
  const view = await link.run(`${QUESTION} ${LINK}`, { caller: MEMBER });
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(productCards(view)).toEqual([]);
  expect(view.cards.map((c) => [c.type, c.data['text_key']])).toEqual([
    ['notice', `error.${String(OFF_SHELF)}`],
  ]);
  return view;
}

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

it('[AC-B3-05q#3][BR-AI-05][BR-AI-04] product_key 格式不合法：不查 catalog、不出商品卡；格式合法但 catalog 查不到（已下架）：与链接消息一样不出报价卡、不拿别的商品顶替，出与已下架链接同一张 notice，文字照常交给模型', async () => {
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
  // Handled like a link message whose product is delisted (deterministic path quoteLink): exactly
  // that one notice, the same text_key and fallback text, and it comes before the model's words
  // (the entry is handled first); the product is never silently dropped.
  expect(noticeFrames(view)).toEqual(noticeFrames(await delistedLink(false)));
  expect(content(view)[0]).toMatchObject({ kind: 'card', card: { type: 'notice' } });
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

it('[AC-B3-05q#19][BR-AI-01][BR-AI-05] 有模型：入口卡出过之后，模型在本轮用入口商品自己的 card_id 再调 get_rebate_quote → 不重复出卡，返回给模型的就是这个编号（不按 invalid_args 拒绝）', async () => {
  const h = kit();
  h.say(QUESTION, [
    { calls: [{ name: 'get_rebate_quote', args: { card_id: ENTRY_PRODUCT_CARD } }] },
    says(REPLY),
  ]);
  const view = await h.run(QUESTION, { caller: MEMBER, context: ENTRY });
  // The entry card is the first frame of the session; the model quotes its product's own id.
  expect(content(view)[0]).toMatchObject({
    kind: 'card',
    card: {
      type: 'rebate_quote',
      card_id: ENTRY_FRAME_CARD,
      data: { product: { card_id: ENTRY_PRODUCT_CARD, product_key: ENTRY_KEY } },
    },
  });
  // 不重复出卡: one rebate_quote card for the entry product in this run.
  expect(quotedKeys(view)).toEqual([ENTRY_KEY]);
  // 返回已有的这个编号: the get_rebate_quote result the model got names the entry product's card
  // and no other card (not a rejection, not a new number).
  const results = toolResults(h);
  expect(results).toHaveLength(1);
  expect(serialized(results)).not.toContain('invalid_args');
  expect(cardIdsIn(results)).toEqual([ENTRY_PRODUCT_CARD]);
  expect(view.text).toContain(REPLY);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
});

it('[AC-B3-05q#20][BR-AI-05][BR-AI-01] 入口卡记进会话结果：下一条消息里模型用入口商品的 card_id 调 get_rebate_quote，照常从 catalog 重新取数报价，不按 invalid_args 拒绝', async () => {
  const h = kit();
  h.say(QUESTION, [says(REPLY)]);
  const first = await h.run(QUESTION, { caller: MEMBER, context: ENTRY });
  expect(quotedKeys(first)).toEqual([ENTRY_KEY]);
  const entryProduct = quotedProductCard(first);
  expect(entryProduct).toBe(ENTRY_PRODUCT_CARD);

  const followUp = '刚才那个再帮我看看';
  h.say(followUp, [
    { calls: [{ name: 'get_rebate_quote', args: { card_id: entryProduct } }] },
    says(REPLY),
  ]);
  const view = await h.run(followUp, { caller: MEMBER });
  const results = toolResults(h);
  expect(results).toHaveLength(1);
  expect(serialized(results)).not.toContain('invalid_args');
  expect(cardIdsIn(results)).toHaveLength(1);
  // A later round quotes afresh (BR-AI-04): the entry product again, from a new catalog lookup.
  expect(quotedKeys(view)).toEqual([ENTRY_KEY]);
  expect(h.readProduct.mock.calls.map(([key]) => key)).toEqual([ENTRY_KEY, ENTRY_KEY]);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
});

it('[AC-B3-05q#21][BR-AI-15][BR-AI-14][BR-AI-04] 无模型时入口商品已下架（上游明确答复，归商品本身，不是服务端原因）：与已下架链接消息同样处理——同一张 notice、以 stop 结束，不以 error 50401 结束，也不改做问法分流与关键词搜索', async () => {
  const h = kit();
  h.state.noModel = true;
  const view = await h.run('帮我找合成纸巾', {
    caller: MEMBER,
    context: { product_key: MISSING_KEY },
  });
  expect(h.readProduct).toHaveBeenCalledTimes(1);
  expect(h.readProduct.mock.calls[0]?.[0]).toBe(MISSING_KEY);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(productCards(view)).toEqual([]);
  const link = await delistedLink(true);
  expect(noticeFrames(view)).toEqual(noticeFrames(link));
  // The notice is the answer (不空回复 does not apply): nothing else goes out, as for the link.
  expect(comparable(content(view))).toEqual(comparable(content(link)));
  expect(view.text).toBe('');
  expect(view.suggestions).toEqual([]);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(h.chunks).not.toHaveBeenCalled();
  expect(personalReads(h)).toBe(0);
});

// Attempt 3 (spec review r2, 编排 D10-1457): the catalog has the entry product but the quote's card
// entry answers price_unavailable — an upstream's explicit answer about the product (BR-AI-15 细则:
// 取不到价格 归商品本身, 照常以 stop 结束), handled as a link message is (BR-AI-01 细则「情境入口」:
// 取不到价格等情形与链接消息同样处理). Business result: done stop, no error frame (the 50401 / quota
// refund boundary for server-side failures belongs to B3-05r and is not asserted here).

/**
 * A message carrying its own link whose product the card entry answers price_unavailable, through
 * the real deterministic link path: the reference for "handled like a link message".
 */
async function priceUnavailableLink(noModel: boolean): Promise<RunView> {
  const link = kit();
  link.state.noModel = noModel;
  link.assemble.mockResolvedValue({ kind: 'price_unavailable' });
  const view = await link.run(`${QUESTION} ${LINK}`, { caller: MEMBER });
  expect(link.assemble).toHaveBeenCalledTimes(1);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(productCards(view)).toEqual([]);
  expect(nonNotices(view)).toEqual([]);
  expect(noticeFrames(view)).toHaveLength(1);
  return view;
}

it('[AC-B3-05q#24][BR-AI-15][BR-AI-14][BR-AI-04] 无模型时入口商品 catalog 查得到、报价结果是 price_unavailable（上游明确答复的业务结果，不是服务端原因）：与取不到价格的链接消息同样处理——同一张 notice、无报价卡、以 stop 结束、不出 error 帧，也不改做问法分流与关键词搜索', async () => {
  const h = kit();
  h.state.noModel = true;
  h.assemble.mockResolvedValue({ kind: 'price_unavailable' });
  const view = await h.run('帮我找合成纸巾', { caller: MEMBER, context: ENTRY });
  expect(h.readProduct).toHaveBeenCalledTimes(1);
  expect(h.readProduct.mock.calls[0]?.[0]).toBe(ENTRY_KEY);
  expect(h.assemble.mock.calls.map(([input]) => input.ref.productKey)).toEqual([ENTRY_KEY]);
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(productCards(view)).toEqual([]);
  const link = await priceUnavailableLink(true);
  expect(noticeFrames(view)).toEqual(noticeFrames(link));
  expect(serialized(noticeFrames(view))).not.toContain('agent.notice.quote_failed');
  // The notice is the answer: nothing else goes out, as for the link.
  expect(comparable(content(view))).toEqual(comparable(content(link)));
  expect(view.text).toBe('');
  expect(view.suggestions).toEqual([]);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(h.chunks).not.toHaveBeenCalled();
  expect(personalReads(h)).toBe(0);
});

it('[AC-B3-05q#25][BR-AI-15][BR-AI-01][BR-AI-04] 有模型时入口商品报价结果是 price_unavailable：与取不到价格的链接消息同一张 notice（不是 agent.notice.quote_failed）、无报价卡，接着把文字交给模型，以 stop 结束', async () => {
  const h = kit();
  h.assemble.mockResolvedValue({ kind: 'price_unavailable' });
  h.say(QUESTION, [says(REPLY)]);
  const view = await h.run(QUESTION, { caller: MEMBER, context: ENTRY });
  expect(h.readProduct).toHaveBeenCalledTimes(1);
  expect(h.readProduct.mock.calls[0]?.[0]).toBe(ENTRY_KEY);
  expect(h.assemble.mock.calls.map(([input]) => input.ref.productKey)).toEqual([ENTRY_KEY]);
  expect(productCards(view)).toEqual([]);
  expect(nonNotices(view)).toEqual([]);
  const link = await priceUnavailableLink(false);
  expect(noticeFrames(view)).toEqual(noticeFrames(link));
  expect(serialized(noticeFrames(view))).not.toContain('agent.notice.quote_failed');
  // The entry is handled first; then the typed words go to the model as usual.
  expect(content(view)[0]).toMatchObject({ kind: 'card', card: { type: 'notice' } });
  expect(h.complete).toHaveBeenCalled();
  expect(serialized(h.complete.mock.calls[0]?.[0].messages)).toContain(QUESTION);
  expect(view.text).toContain(REPLY);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(view.result).toEqual({ kind: 'done', finishReason: 'stop' });
});
