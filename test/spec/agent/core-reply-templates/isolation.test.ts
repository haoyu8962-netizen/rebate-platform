// B3-08m · BR-AI-07 per run: what a run called belongs to that run only. One core body (same
// app, same deps): run A calls search_rules, run B (new runId) calls no tool. B's text goes out
// as is whether it runs after A or interleaved with A in either order; A still gets its template.
// After A ends (normally or cancelled), a run reusing A's runId starts clean.
// Contract: orchestrator/core/reply-templates.ts.
import { expect, it } from 'vitest';
import { until } from '../stream-recovery/kit.ts';
import {
  LEAD,
  MODEL_TEXT,
  coreRig,
  expectOnly,
  expectReplaced,
  fixed,
  gate,
  rulesHit,
  typesOf,
  type Step,
} from './kit.ts';

const A = '提现最低多少';
const B = '返利以什么为准';
const C = '规则在哪里看';
const PLAIN_B = '返利以订单详情页显示为准，规则可以在帮助中心查看。';
const PLAIN_C = '帮助中心里有完整的规则说明。';
const FOUND = fixed('agent.rule.found');
const A_RUN: readonly Step[] = [
  { text: LEAD, calls: [{ name: 'search_rules', args: { question: A } }] },
  { text: MODEL_TEXT },
];

it('[AC-B3-08m#5][BR-AI-07] 先后两 run：A 调过 search_rules 出 agent.rule.found；随后同 app、新 runId 的 B 不调工具 → B 文本照发，trace 不记替换', async () => {
  const x = coreRig({ scripts: { [A]: A_RUN, [B]: [{ text: PLAIN_B }] } });
  const a = await x.run(A);
  expectOnly(a, FOUND, [LEAD, MODEL_TEXT]);
  expectReplaced(a, true);

  const b = await x.run(B);
  expect(b.runId).not.toBe(a.runId);
  expect(b.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(b.frames).toEqual([]);
  expect(b.text).toBe(PLAIN_B);
  expectReplaced(b, false);
});

it('[AC-B3-08m#5][BR-AI-07] 交错（A 先开始）：A 停在 search_rules 执行中，B 从头跑完 → B 照发；放行 A 后 A 只出 agent.rule.found', async () => {
  const rules = gate();
  const x = coreRig({
    scripts: { [A]: A_RUN, [B]: [{ text: PLAIN_B }] },
    answers: {
      search_rules: async () => {
        await rules.promise;
        return rulesHit();
      },
    },
  });
  const a = x.start(A);
  await until('A is inside search_rules', () => x.execute.mock.calls.length === 1);

  const b = await x.run(B);
  expect(b.text).toBe(PLAIN_B);
  expectReplaced(b, false);

  rules.open();
  const done = await a.done;
  expect(done.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(done.frames)).toEqual(['rule_ref']);
  expectOnly(done, FOUND, [LEAD, MODEL_TEXT, PLAIN_B]);
  expectReplaced(done, true);
});

it('[AC-B3-08m#5][BR-AI-07] 交错（B 先开始）：B 的模型轮挂起，A 从头跑完出 agent.rule.found；放行 B 后 B 照发，不带 A 的模板', async () => {
  const model = gate();
  let waiting = false;
  const x = coreRig({
    scripts: {
      [A]: A_RUN,
      [B]: [
        {
          text: PLAIN_B,
          before: async () => {
            waiting = true;
            await model.promise;
          },
        },
      ],
    },
  });
  const b = x.start(B);
  await until('B waits for its model round', () => waiting);

  const a = await x.run(A);
  expectOnly(a, FOUND, [LEAD, MODEL_TEXT, PLAIN_B]);
  expectReplaced(a, true);

  model.open();
  const done = await b.done;
  expect(done.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(done.text).toBe(PLAIN_B);
  expectReplaced(done, false);
});

it('[AC-B3-08m#5][BR-AI-07] run 结束即清：A（调过 search_rules）结束后，再起一个复用 A 的 runId、不调工具的 run → 文本照发，不受 A 影响', async () => {
  const x = coreRig({ scripts: { [A]: A_RUN, [C]: [{ text: PLAIN_C }] } });
  const a = await x.run(A);
  expectOnly(a, FOUND, [LEAD, MODEL_TEXT]);

  const again = await x.run(C, a.runId);
  expect(again.runId).toBe(a.runId);
  expect(again.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(again.text).toBe(PLAIN_C);
  expectReplaced(again, false);
});

it('[AC-B3-08m#5][BR-AI-07] 取消也不残留：A 在 search_rules 执行中被取消 → A 不下发任何模型文本；之后复用 A 的 runId、不调工具的 run 文本照发', async () => {
  const rules = gate();
  const x = coreRig({
    scripts: { [A]: A_RUN, [C]: [{ text: PLAIN_C }] },
    answers: {
      search_rules: async () => {
        await rules.promise;
        return rulesHit();
      },
    },
  });
  const a = x.start(A);
  await until('A is inside search_rules', () => x.execute.mock.calls.length === 1);
  a.controller.abort('cancelled');
  rules.open();
  const cancelled = await a.done;
  expect(cancelled.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(cancelled.text, 'a cancelled run that called search_rules sends no model text').toBe('');

  const again = await x.run(C, a.runId);
  expect(again.text).toBe(PLAIN_C);
  expectReplaced(again, false);
});
