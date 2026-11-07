// B3-08p · FU-AGENT-RUN-CACHED-TEXT (D10-888 (b2)) · BR-AI-07 with BR-AI-06: the held text released
// before the card cap is the OutputGuard's output, never the raw model deltas, and the guard is not
// flushed there (no guard.end()): an amount sentence goes out as the guard rewrote it, a piece
// without a sentence end stays in the guard and is not delivered, exactly as in the same scenario
// without template tools offered (where the guard's output was written at once and the card cap
// ended the run without a flush). Gate review r1 S2 (card-cap.test.ts). Contract: ./kit.ts header.
import { expect, it } from 'vitest';
import {
  LIMIT,
  PLAIN_OFFER,
  TEMPLATE_OFFER,
  cardsOf,
  expectReplaced,
  expectWithinCaps,
  products,
  rig,
  type RigOptions,
} from './kit.ts';

type Scenario = Omit<RigOptions, 'offered'>;

/** An amount sentence (BR-AI-06: rewritten by the guard) and a piece without a sentence end. */
const AMOUNT = '券后29元。';
const PIECE = '稍等';
const OPENING = [AMOUNT, PIECE];

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  // Round 1: an 8-item list (9 cards). Round 2 (no text): a 3-item list (4 cards) does not fit.
  over: {
    steps: [{ text: OPENING, calls: ['search_products'] }, { calls: ['search_products'] }],
    answers: { search_products: [products(8, 'a'), products(3, 'b')] },
  },
  // One round: an 8-item list (9 cards), then a 2-item list (3 cards): exactly 12, the cap.
  exact: {
    steps: [{ text: OPENING, calls: ['search_products', 'search_products'] }],
    answers: { search_products: [products(8, 'a'), products(2, 'b')] },
  },
};

it('[AC-B3-08p#1][AC-B3-08p#5][BR-AI-07][BR-AI-06] 撞卡片上限前放行的缓存文本经 OutputGuard：第 1 轮文本 [「券后29元。」, 「稍等」]（金额句 + 未完成残句），只调 search_products 的 run 撞上限（写不下 / 恰好 12 张）→ 实际下发文本与不提供模板工具的同一场景逐字一致：金额按现有守卫替换，残句不出，done limit', async () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const plain = await rig({ offered: PLAIN_OFFER, ...scenario }).run();
    expect(plain.result, name).toEqual(LIMIT);
    expect(plain.text, `${name}: guard output reached the user`).not.toBe('');
    expect(plain.text, name).toContain('见卡片');
    expect(plain.text, name).not.toContain('29');
    expect(plain.text, name).not.toContain(PIECE);

    const x = rig({ offered: TEMPLATE_OFFER, ...scenario });
    const held = await x.run();
    expect(held.result, name).toEqual(LIMIT);
    expect(held.deltas, name).toEqual(plain.deltas);
    expect(held.text, name).toBe(plain.text);
    expect(held.text, name).not.toContain(AMOUNT);
    expect(held.text, name).not.toContain(PIECE);
    expect(cardsOf(held), name).toEqual(cardsOf(plain));
    expect(held.trace?.output_filtered, name).toBe(plain.trace?.output_filtered);
    expectWithinCaps(held, x.limits);
    expectReplaced(held, false);
  }
});
