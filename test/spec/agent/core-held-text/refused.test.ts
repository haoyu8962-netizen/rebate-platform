// B3-08p · FU-AGENT-RUN-CACHED-TEXT (D10-888 (b2)) · BR-AI-07 with BR-AI-14: a later round's
// provider refusal (content_refused → agent.refuse.unsafe, done safety) is a point where the run is
// certain to end. A run offered a template tool that made no template call writes the held text
// first, then agent.refuse.unsafe: the same text in the same order as a run without template tools
// offered. Unchanged: a run with a template call (only agent.refuse.unsafe), and cancellation /
// the run time limit (aborted signal: the held text is dropped, BR-AI-14「缓冲中未下发的模型文本
// 丢弃」; agent.timeout itself is the RunManager's frame, not the body's). Contract: ./kit.ts header.
import { expect, it } from 'vitest';
import {
  LEAD,
  PLAIN_OFFER,
  SAFETY,
  STOP,
  TEMPLATE_OFFER,
  UNSAFE,
  cardsOf,
  executed,
  expectNoModelText,
  expectReplaced,
  products,
  rig,
  type RigOptions,
} from './kit.ts';

type Scenario = Omit<RigOptions, 'offered'>;

/** A sentence that leaves the guard at once, then a piece without a sentence end (stays buffered). */
const OPENING = [LEAD, '稍等'];

/** Round 1: the opening and search_products (one 2-item list). Round 2: the provider refuses. */
const REFUSED: Scenario = {
  steps: [{ text: OPENING, calls: ['search_products'] }, { refused: true }],
  answers: { search_products: [products(2, 'a')] },
};

/** REFUSED without template tools offered, as delivered before this change (frame by frame). */
const REFUSED_PLAIN = [
  `text:${LEAD}`,
  'status:search_products:start',
  'status:search_products:end',
  'card:product_list:c1',
  `text:${UNSAFE}`,
];

it('[AC-B3-08p#4][AC-B3-08p#5][BR-AI-07][BR-AI-14] 提供了模板工具、没调用，第二轮供应商拒答 → 先出第一轮已成句的「我先看看。」，再出 agent.refuse.unsafe，done safety；文本顺序与卡片和不提供模板工具的同一场景完全相同（缓冲中的残句「稍等」两边都不出），后者逐帧不变', async () => {
  const plain = await rig({ offered: PLAIN_OFFER, ...REFUSED }).run();
  expect(plain.result).toEqual(SAFETY);
  expect(plain.log).toEqual(REFUSED_PLAIN);

  const x = rig({ offered: TEMPLATE_OFFER, ...REFUSED });
  const held = await x.run();
  expect(held.result).toEqual(SAFETY);
  expect(executed(x)).toEqual(['search_products']);
  expect(held.deltas).toEqual([LEAD, UNSAFE]);
  expect(held.deltas).toEqual(plain.deltas);
  expect(cardsOf(held)).toEqual(cardsOf(plain));
  expect(held.text).not.toContain('稍等');
  expectReplaced(held, false);
});

it('[AC-B3-08p#4][BR-AI-07] 拒答对照：前一轮已调 search_rules 的 run 被拒答 → 仍只出 agent.refuse.unsafe（不放行缓存文本、不加模板句），rule_ref 卡照发，done safety；未调模板工具的同一脚本放行开场白', async () => {
  const contrast = await rig({ offered: TEMPLATE_OFFER, ...REFUSED }).run();
  expect(contrast.result).toEqual(SAFETY);
  expect(contrast.deltas).toEqual([LEAD, UNSAFE]);

  const x = rig({
    offered: TEMPLATE_OFFER,
    steps: [{ text: OPENING, calls: ['search_rules'] }, { refused: true }],
  });
  const view = await x.run();
  expect(view.result).toEqual(SAFETY);
  expect(executed(x)).toEqual(['search_rules']);
  expect(view.cardTypes).toEqual(['rule_ref']);
  expect(view.deltas).toEqual([UNSAFE]);
  expectNoModelText(view, [LEAD, '稍等']);
});

it('[AC-B3-08p#6][BR-AI-14] 取消 / 超时接受现状：提供了模板工具、没调用的 run 在工具执行中被取消或到运行时限（signal 中止）→ 缓存的开场白不下发，此后不再写任何文本或卡片，done stop；对照：同一开场白在第二轮拒答时于拒答前放行', async () => {
  const contrast = await rig({ offered: TEMPLATE_OFFER, ...REFUSED }).run();
  expect(contrast.deltas).toEqual([LEAD, UNSAFE]);

  for (const reason of ['cancelled', 'timeout']) {
    const x = rig({
      offered: TEMPLATE_OFFER,
      steps: [{ text: OPENING, calls: ['search_products'] }, { text: '找到这些商品。' }],
      answers: { search_products: [products(2, 'a')] },
      onExecute: (_name, controller) => {
        controller.abort(reason);
      },
    });
    const view = await x.run();
    expect(view.result, reason).toEqual(STOP);
    expect(executed(x), reason).toEqual(['search_products']);
    expect(view.deltas, reason).toEqual([]);
    expect(view.cardTypes, reason).toEqual([]);
    expect(
      view.log.filter((entry) => !entry.startsWith('status:')),
      `${reason}: no content frame`,
    ).toEqual([]);
    expect(x.complete, reason).toHaveBeenCalledTimes(1);
  }
});
