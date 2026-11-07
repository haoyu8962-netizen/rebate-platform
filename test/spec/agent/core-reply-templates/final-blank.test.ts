// B3-08m · BR-AI-07 T6: after search_rules the model's final round is empty (no text, no tool
// call). The template still goes out: agent.rule.found on a hit, agent.rule.not_found (with the
// handoff card the tool returned) without one. Contract: orchestrator/core/reply-templates.ts.
import { expect, it } from 'vitest';
import { coreRig, expectOnly, expectReplaced, fixed, rulesMiss, typesOf } from './kit.ts';

const QUESTION = '提现最低多少';
const UNRELATED = '你们和别家比怎么样';

it('[AC-B3-08m#2][BR-AI-07] 调过 search_rules（命中）后最终轮模型空文本 → 仍下发 agent.rule.found，rule_ref 卡照发', async () => {
  const x = coreRig({
    scripts: {
      [QUESTION]: [{ calls: [{ name: 'search_rules', args: { question: QUESTION } }] }, {}],
    },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.complete).toHaveBeenCalledTimes(2);
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, fixed('agent.rule.found'), []);
  expectReplaced(run, true);
});

it('[AC-B3-08m#2][BR-AI-07] 调过 search_rules（无命中）后最终轮模型空文本 → 仍下发 agent.rule.not_found，handoff 卡照发', async () => {
  const x = coreRig({
    scripts: {
      [UNRELATED]: [{ calls: [{ name: 'search_rules', args: { question: UNRELATED } }] }, {}],
    },
    answers: { search_rules: async () => rulesMiss() },
  });
  const run = await x.run(UNRELATED);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.complete).toHaveBeenCalledTimes(2);
  expect(typesOf(run.frames)).toEqual(['handoff']);
  expectOnly(run, fixed('agent.rule.not_found'), []);
  expectReplaced(run, true);
});

it('[AC-B3-08m#2][BR-AI-07] 调过 search_rules（无命中）后最终轮只有空白字符 → 空白不下发，只出 agent.rule.not_found', async () => {
  const x = coreRig({
    scripts: {
      [UNRELATED]: [
        { calls: [{ name: 'search_rules', args: { question: UNRELATED } }] },
        { text: ['  ', '\n'] },
      ],
    },
    answers: { search_rules: async () => rulesMiss() },
  });
  const run = await x.run(UNRELATED);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['handoff']);
  expectOnly(run, fixed('agent.rule.not_found'), []);
  expectReplaced(run, true);
});
