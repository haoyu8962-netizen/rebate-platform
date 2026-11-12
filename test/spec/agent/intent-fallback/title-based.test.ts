// BR-AI-18 细则「比较与适用性的提示」: no tool call, no intent object, explanation text actually
// delivered, and the session has product cards in context (its current result set) → the server
// adds the notice agent.notice.title_based after the text. The model never writes it.
import { expect, it } from 'vitest';
import { content, copy, done, intent, kit, says, titleNotices, type Kit } from './kit.ts';

const ANSWER = '标题显示第一个是儿童款。';

/** A first run of the session in which the model's search delivered a product list. */
async function showProducts(h: Kit): Promise<void> {
  const question = '合成保温杯';
  h.say(question, [{ calls: [{ name: 'search_products', args: { q: '合成保温杯' } }] }, says('')]);
  const shown = await h.run(question);
  expect(shown.cards.some((c) => c.type === 'product_list')).toBe(true);
  expect(titleNotices(shown)).toEqual([]);
}

it('[AC-B3-05o#41] 会话里有当前结果集，模型只给说明文字（未调工具、无意图）：文字之后附 notice agent.notice.title_based', async () => {
  const h = kit();
  await showProducts(h);
  const question = '这几个哪个适合宝宝';
  h.say(question, [says(ANSWER)]);
  const view = await h.run(question);
  done(view);
  expect(view.text).toBe(ANSWER);
  expect(titleNotices(view)).toEqual([
    expect.objectContaining({
      type: 'notice',
      data: expect.objectContaining({ text_key: 'agent.notice.title_based' }),
      fallback_text: copy('agent.notice.title_based'),
    }),
  ]);
  // The notice follows the text.
  const events = content(view);
  const at = events.findIndex((e) => e.kind === 'card');
  expect(at).toBeGreaterThan(0);
  expect(events.slice(0, at).every((e) => e.kind === 'text')).toBe(true);
  expect(view.cards).toHaveLength(1);
  expect(view.suggestions).toEqual([]);
});

it('[AC-B3-05o#42] 会话里没有商品卡时不附 title_based', async () => {
  const h = kit();
  const question = '这几个哪个适合宝宝';
  h.say(question, [says(ANSWER)]);
  const view = await h.run(question);
  done(view);
  expect(view.text).toBe(ANSWER);
  expect(titleNotices(view)).toEqual([]);
  expect(view.cards).toEqual([]);
});

it('[AC-B3-05o#43] 本轮模型调用了工具：不附 title_based', async () => {
  const h = kit();
  await showProducts(h);
  const question = '再找找有没有儿童款';
  h.say(question, [
    { calls: [{ name: 'search_products', args: { q: '儿童保温杯' } }] },
    says(ANSWER),
  ]);
  const view = await h.run(question);
  done(view);
  expect(view.cards.some((c) => c.type === 'product_list')).toBe(true);
  expect(titleNotices(view)).toEqual([]);
});

it('[AC-B3-05o#44] 本轮模型输出了意图对象：不附 title_based', async () => {
  const h = kit();
  await showProducts(h);
  const question = '帮我转人工';
  h.say(question, [says(intent('handoff'))]);
  const view = await h.run(question);
  expect(titleNotices(view)).toEqual([]);
});

it('[AC-B3-05o#45] 说明文字没能下发（输出审核拦截）：不附 title_based', async () => {
  const h = kit();
  await showProducts(h);
  h.state.review = 'block';
  const question = '这几个哪个适合宝宝';
  h.say(question, [says(ANSWER)]);
  const view = await h.run(question);
  done(view, 'safety');
  expect(view.text).not.toContain(ANSWER);
  expect(titleNotices(view)).toEqual([]);
});

it('[AC-B3-05o#46] 模型返回空白：不附 title_based，按不空回复处理', async () => {
  const h = kit();
  await showProducts(h);
  const question = '这几个哪个适合宝宝';
  h.say(question, [says('   ')]);
  const view = await h.run(question);
  expect(titleNotices(view)).toEqual([]);
  expect(view.text.trim()).toBe(copy('agent.reply.empty'));
});

it('[AC-B3-05o#47] 另一个会话的结果集不算本会话的商品卡', async () => {
  const h = kit();
  await showProducts(h);
  const question = '这几个哪个适合宝宝';
  h.say(question, [says(ANSWER)]);
  const view = await h.run(question, { sessionId: 'synthetic-other-session' });
  done(view);
  expect(view.text).toBe(ANSWER);
  expect(titleNotices(view)).toEqual([]);
});
