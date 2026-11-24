import { expect, it } from 'vitest';
import { createRebateQuoteHandler } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { content, kit, LINK, NOW, says, type RunView } from '../scenario-entry/kit.ts';
import { fileText } from '../stream-mount/kit.ts';
import { context, fixture as quoteFixture } from '../tools-quote/kit.ts';
import { candidate } from '../tools-search/kit.ts';

const NOTICE_KEY = 'no_rebate.notice';
const PRODUCT_KEY = 'tb:link';
const ENTRY = { product_key: PRODUCT_KEY };
const QUESTION = '这个值得买吗';
const ANSWER = '可以先看看商品说明再决定。';
const STOP = { kind: 'done', finishReason: 'stop' };

function scenario() {
  const h = kit();
  const quote = quoteFixture();
  quote.clock.set(NOW);
  quote.setQuote({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
  // 粘贴 LINK 时，淘宝按 synthetic-link 的最后一段生成 tb:link。
  const rawItemId = 'synthetic-link';
  const row = candidate(PRODUCT_KEY);
  h.state.catalog.push({
    ...row,
    item: { ...row.item, item_id: rawItemId },
    ref: { ...row.ref, rawItemId },
  });
  h.cards.mockImplementation(quote.deps.catalog.cards);
  return { h, quote };
}

function expectNotice(view: RunView) {
  expect(view.cards).toHaveLength(1);
  const [notice] = view.cards;
  expect(notice).toMatchObject({
    type: 'notice',
    data: { text_key: NOTICE_KEY },
    fallback_text: fileText(NOTICE_KEY),
  });
  expect(notice?.fallback_text).not.toMatch(/[{}]/u);
}

it('[AC-B3-05w#1][BR-PRICE-08][BR-AI-15][BR-TEXT-22] 无模型的商品情境入口与粘贴同一商品链接都只提示暂无返利，模型工具仍返回 no_card', async () => {
  const { h, quote } = scenario();
  h.state.noModel = true;
  const handler = createRebateQuoteHandler({
    ...quote.deps,
    catalog: { ...quote.deps.catalog, readProduct: h.readProduct },
  });
  const toolResult = await handler.run(ENTRY, context({ context: ENTRY }));
  expect(toolResult.modelView).toEqual({ error: 'no_card' });
  expect(quote.commits).not.toHaveBeenCalled();

  const pasted = await h.run(LINK);
  const entry = await h.run(QUESTION, { context: ENTRY });
  expect(h.readProduct.mock.calls.map(([key]) => key)).toEqual([PRODUCT_KEY, PRODUCT_KEY]);
  expect(quote.assemble.mock.calls.map(([input]) => input.ref.productKey)).toEqual([
    PRODUCT_KEY,
    PRODUCT_KEY,
    PRODUCT_KEY,
  ]);
  expect(quote.commits).not.toHaveBeenCalled();
  expect(quote.register).not.toHaveBeenCalled();
  expect(pasted.result).toEqual(STOP);
  expect(entry.result).toEqual(STOP);
  expect(entry.text).toBe('');
  expectNotice(pasted);
  expectNotice(entry);
  expect(entry.cards[0]?.fallback_text).toBe(pasted.cards[0]?.fallback_text);
  expect(entry.cards[0]?.data['text_key']).toBe(pasted.cards[0]?.data['text_key']);
});

it('[AC-B3-05w#2][BR-PRICE-08][BR-TEXT-22] 有模型的商品情境入口先提示暂无返利，再答复用户输入并以 stop 结束', async () => {
  const { h, quote } = scenario();
  h.say(QUESTION, [says(ANSWER)]);

  const view = await h.run(QUESTION, { context: ENTRY });

  expect(quote.assemble.mock.calls.map(([input]) => input.ref.productKey)).toEqual([PRODUCT_KEY]);
  expect(quote.commits).not.toHaveBeenCalled();
  expect(quote.register).not.toHaveBeenCalled();
  expect(h.complete).toHaveBeenCalled();
  expect(JSON.stringify(h.complete.mock.calls[0]?.[0].messages)).toContain(QUESTION);
  expect(view.text).toBe(ANSWER);
  expect(view.result).toEqual(STOP);
  expectNotice(view);
  expect(content(view)[0]).toEqual({ kind: 'card', card: view.cards[0] });
});
