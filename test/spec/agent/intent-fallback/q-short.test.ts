// BR-TEXT-22 agent.suggest.no_result.1–3 (BR-AI-08 无结果): {q_short} is the first 8 characters
// (Unicode code points) of this search's q, in text and send_text alike; with no search term the
// second suggestion is left out. Expectations use the production dictionary copy.
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { done, intent, kit, noResultSuggestions, says, type RunView } from './kit.ts';

async function searchNothing(q: string, extra: Readonly<Record<string, unknown>> = {}) {
  const h = kit();
  h.state.rows = [];
  const question = '合成检索';
  h.say(question, [{ calls: [{ name: 'search_products', args: { q, ...extra } }] }, says('')]);
  const view = await h.run(question);
  return { h, view };
}

function noBraces(view: RunView): void {
  const shown = view.events.flatMap((e) =>
    e.kind === 'text'
      ? [e.text]
      : e.kind === 'suggestions'
        ? e.items.flatMap((i) => [i.text, i.send_text])
        : e.kind === 'card'
          ? [JSON.stringify(e.card)]
          : [],
  );
  for (const piece of shown) {
    expect(piece).not.toContain('{q_short}');
    expect(piece).not.toMatch(/\{[a-z_]+\}/u);
  }
}

it('[AC-B3-05o#48] 无结果建议第 2 条：{q_short} 取检索词前 8 个字符（按 Unicode 字符计，含扩展区汉字）', async () => {
  const { view } = await searchNothing('𠮷野家牛肉饭套餐双人份');
  done(view);
  expect(view.suggestions).toEqual([noResultSuggestions('𠮷野家牛肉饭套餐')]);
  expect(view.suggestions[0]?.[1]).toEqual({
    text: '只搜𠮷野家牛肉饭套餐',
    send_text: '只搜𠮷野家牛肉饭套餐',
  });
  noBraces(view);
});

it('[AC-B3-05o#49] 检索词不足 8 个字符时整词带上', async () => {
  const { view } = await searchNothing('耳机');
  expect(view.suggestions).toEqual([noResultSuggestions('耳机')]);
  noBraces(view);
});

it('[AC-B3-05o#50] 检索词正好 9 个字符时只取前 8 个', async () => {
  const { view } = await searchNothing('abcdefghi');
  expect(view.suggestions).toEqual([noResultSuggestions('abcdefgh')]);
  noBraces(view);
});

it('[AC-B3-05o#51] 放宽价格后仍无结果：建议照样按本次检索词替换 {q_short}', async () => {
  const { h, view } = await searchNothing('耳机', { price_max_fen: 5000 });
  expect(h.searchProducts.mock.calls.length).toBeGreaterThan(3);
  expect(view.cards.filter((c) => c.type === 'notice').map((c) => c.data['text_key'])).toEqual([
    'agent.notice.relaxed_price',
    'agent.notice.no_result',
  ]);
  expect(view.suggestions).toEqual([noResultSuggestions('耳机')]);
  noBraces(view);
});

it('[AC-B3-05o#52] 没有检索词（会话里没搜过就要「换一批」）：无结果建议不出第 2 条', async () => {
  const h = kit();
  const question = '换一批';
  h.say(question, [says(intent('refine', { conditions: { next_batch: true } }))]);
  const view = await h.run(question);
  done(view);
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect(view.suggestions).toEqual([noResultSuggestions(null)]);
  noBraces(view);
});

it('[AC-B3-05o#53] 任意检索词：第 2 条恰为「只搜」+ 前 8 个 Unicode 字符，文字与发送文字相同、无花括号', async () => {
  const chars = ['耳', '机', '保', '温', '杯', '纸', '巾', 'a', 'Z', '𠮷', '𩸽', 'é'];
  // Reach the composition outside fast-check first: its first red is the original error.
  const probe = await searchNothing('𩸽𩸽𩸽𩸽𩸽𩸽𩸽𩸽𩸽');
  expect(probe.view.suggestions).toEqual([noResultSuggestions('𩸽𩸽𩸽𩸽𩸽𩸽𩸽𩸽')]);
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 16 }),
      async (letters) => {
        const q = letters.join('');
        const { view } = await searchNothing(q);
        const expected = letters.slice(0, 8).join('');
        expect(view.suggestions).toEqual([noResultSuggestions(expected)]);
        noBraces(view);
        return true;
      },
    ),
    // Each sample builds the whole composition: PROP_RUNS scaled by 1/500 with a floor of 20
    // (default 10 000 → 20); the seed is PROP_SEED as it is.
    { numRuns: Math.max(20, Math.floor(propRuns() / 500)), seed: propSeed() },
  );
});
