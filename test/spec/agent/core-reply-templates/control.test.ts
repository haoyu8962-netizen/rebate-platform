// B3-08m · BR-AI-07 对照: the template rule applies only to runs that called a template tool. On
// the same core body (same deps, same offered tools including search_rules and the order tools) a
// run that called search_rules gets agent.rule.found, while a run that called no tool, or only
// search_products, delivers the model's text word for word, every delta in order, nothing added.
// Contract: orchestrator/core/reply-templates.ts.
import { expect, it } from 'vitest';
import {
  LEAD,
  MODEL_TEXT,
  OFFERED,
  coreRig,
  expectOnly,
  expectReplaced,
  fixed,
  offeredFor,
  typesOf,
  type Step,
} from './kit.ts';

const QUESTION = '提现最低多少';
const RULE_RUN: readonly Step[] = [
  { calls: [{ name: 'search_rules', args: { question: QUESTION } }] },
  { text: MODEL_TEXT },
];

it('[AC-B3-08m#4][BR-AI-07] 对照（不调工具）：同一 core 实例上，调 search_rules 的 run 出 agent.rule.found；未调任何工具的 run（search_rules 与订单工具都已下发）模型文本逐字照发、分片顺序不变，trace 不记替换', async () => {
  const plain = '返利以订单详情页显示为准';
  const deltas = ['返利以订单', '详情页显示为准，', '规则可以在帮助中心查看。', '还有别的问题吗'];
  const x = coreRig({
    scripts: { [QUESTION]: RULE_RUN, [plain]: [{ text: deltas }] },
  });

  const ruled = await x.run(QUESTION);
  expectOnly(ruled, fixed('agent.rule.found'), [MODEL_TEXT]);
  expectReplaced(ruled, true);

  const run = await x.run(plain);
  expect(offeredFor(x.complete, plain)).toEqual(OFFERED);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(run.frames).toEqual([]);
  expect(run.text).toBe(deltas.join(''));
  expect(run.text).not.toContain(fixed(''));
  expectReplaced(run, false);
});

it('[AC-B3-08m#4][BR-AI-07] 对照（只调 search_products）：同一 core 实例上，调 search_rules 的 run 出模板；只调 search_products 的 run 工具轮「我先看看。」与最终轮文本都照发、先后不变，商品卡照发', async () => {
  const shop = '帮我找个保温杯';
  const x = coreRig({
    scripts: {
      [QUESTION]: RULE_RUN,
      [shop]: [
        { text: LEAD, calls: [{ name: 'search_products', args: { q: '保温杯' } }] },
        { text: ['找到这些商品，', '价格以卡片为准。'] },
      ],
    },
  });

  const ruled = await x.run(QUESTION);
  expectOnly(ruled, fixed('agent.rule.found'), [MODEL_TEXT]);
  expectReplaced(ruled, true);

  const run = await x.run(shop);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['product_list']);
  expect(run.text).toBe(`${LEAD}找到这些商品，价格以卡片为准。`);
  expect(run.text).not.toContain(fixed(''));
  expectReplaced(run, false);
});
