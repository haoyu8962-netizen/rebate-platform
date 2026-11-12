// B3-05p ② · BR-AI-18 细则「比较与适用性的提示」: the notice agent.notice.title_based follows the
// model's delivered explanation (no tool call, no intent object) when the context has product
// cards — the session's current result set, OR a rebate_quote card in the recent conversation
// (「或最近对话里的报价卡」). Here the session has no product result set at all; an earlier run of
// the same session delivered one rebate_quote card, which the core records as that run's quoted
// receipt (DeliveryReceiptPort.recordQuoted, scope = app, session and run of that run, the product
// embedded in the quote; ../intent-fallback/kit.ts shares one result store between the composition
// and `h.store`). A quote of another session does not count. Production composition
// (createStreamAgentBody over createAgentStreamAssembly) as in ../intent-fallback/kit.ts.
import { expect, it } from 'vitest';
import type { DeliveredProduct } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { candidate, card } from '../tools-search/kit.ts';
import {
  APP,
  content,
  copy,
  done,
  kit,
  says,
  titleNotices,
  type Kit,
  type RunView,
} from '../intent-fallback/kit.ts';

const ANSWER = '标题显示这件是儿童款。';
const QUESTION = '这个适合宝宝吗';

/** The quoted product an earlier rebate_quote card (frame c1) embedded (as c2). */
function quotedReceipt(): DeliveredProduct {
  const product = card(candidate('tb:synthetic-quoted-cup'));
  const quote: UnnumberedCard = {
    type: 'rebate_quote',
    schema_version: 1,
    data: { product: { ...product }, material: null, tlj_kind: 'unknown' },
    fallback_text: '合成报价卡',
  };
  return {
    card_id: 'c2',
    product_key: product.product_key as string,
    platform: product.platform,
    final_price_fen: product.final_price_fen as number,
    card: quote,
  };
}

/** An earlier run of `sessionId` delivered one rebate_quote card and no product list. */
async function quotedEarlier(h: Kit, sessionId: string): Promise<void> {
  const scope = { appId: APP, sessionId, runId: `synthetic-quote-run-${sessionId}` };
  await h.store.recordQuoted(scope, [quotedReceipt()]);
  // No product result set in that session: only the quote is in context.
  expect(await h.store.latestWithProducts(APP, sessionId)).toBeNull();
}

function expectTitleNoticeAfterText(view: RunView): void {
  done(view);
  expect(view.text).toBe(ANSWER);
  expect(titleNotices(view)).toEqual([
    expect.objectContaining({
      type: 'notice',
      data: expect.objectContaining({ text_key: 'agent.notice.title_based' }),
      fallback_text: copy('agent.notice.title_based'),
    }),
  ]);
  // The notice follows the text and is the only card of the run.
  const events = content(view);
  const at = events.findIndex((e) => e.kind === 'card');
  expect(at).toBeGreaterThan(0);
  expect(events.slice(0, at).every((e) => e.kind === 'text')).toBe(true);
  expect(view.cards).toHaveLength(1);
  expect(view.suggestions).toEqual([]);
}

it('[AC-B3-05p#7][BR-AI-18] 本会话没有商品结果集、最近对话只出过一张报价卡，模型只给说明文字（未调工具、无意图）：文字之后附 agent.notice.title_based', async () => {
  const h = kit();
  await quotedEarlier(h, h.defaultSession);
  h.say(QUESTION, [says(ANSWER)]);
  const view = await h.run(QUESTION);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expectTitleNoticeAfterText(view);
});

it('[AC-B3-05p#8][BR-AI-18] 另一个会话的报价卡不算：那个会话里不附 title_based，出过报价卡的本会话照附', async () => {
  const h = kit();
  const other = 'synthetic-quoted-other-session';
  await quotedEarlier(h, other);
  h.say(QUESTION, [says(ANSWER), says(ANSWER)]);

  const elsewhere = await h.run(QUESTION);
  done(elsewhere);
  expect(elsewhere.text).toBe(ANSWER);
  expect(titleNotices(elsewhere)).toEqual([]);
  expect(elsewhere.cards).toEqual([]);

  const quoted = await h.run(QUESTION, { sessionId: other });
  expectTitleNoticeAfterText(quoted);
});
