// B3-08m · BR-AI-07「本 run 调用过 … search_rules 时，模型生成的文本一律不下发，由服务端输出模板文本」, at
// every text exit of orchestrator/core's run (contract: orchestrator/core/reply-templates.ts):
// the three leaks found in review of B3-08l (tool-round text; text of rounds before the first
// search_rules; an unfinished sentence flushed by guard.end() after an empty final round), then
// each end that goes through finishText (round limit, tool call budget, router degradation after
// delivery, invalid format in a tool round and in the final round), an intent object in the final
// round, an IntentPort that would answer itself, and a failed search_rules call.
import { expect, it, vi } from 'vitest';
import type { IntentPort } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  LEAD,
  LEAD_OPEN,
  MODEL_TEXT,
  coreRig,
  expectOnly,
  expectReplaced,
  failedTool,
  fixed,
  typesOf,
} from './kit.ts';

const QUESTION = '提现最低多少';
const RULES = { name: 'search_rules', args: { question: QUESTION } } as const;
const PRODUCTS = { name: 'search_products', args: { q: '保温杯' } } as const;
const FOUND = fixed('agent.rule.found');
const LIMITS = {
  toolCalls: 4,
  modelRounds: 3,
  textCodePoints: 20_000,
  cards: 12,
  contentFrames: 400,
};

it('[AC-B3-08m#1][BR-AI-07] 漏法 1：工具轮里模型文本与 search_rules 同轮（文本先于工具调用）→ 用户只收到 agent.rule.found，工具轮与最终轮的模型文本都不下发；rule_ref 卡照发', async () => {
  const x = coreRig({
    scripts: {
      [QUESTION]: [{ text: '提现最低10元。', calls: [RULES] }, { text: MODEL_TEXT }],
    },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, ['提现最低10元', MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] 漏法 2：第一轮「我先看看。」+ search_products，第二轮才调 search_rules，第三轮写结论 → 首次 search_rules 之前的轮次文本也不下发，用户只收到 agent.rule.found', async () => {
  const x = coreRig({
    scripts: {
      [QUESTION]: [{ text: LEAD, calls: [PRODUCTS] }, { calls: [RULES] }, { text: MODEL_TEXT }],
    },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.execute.mock.calls.map(([call]) => call.name)).toEqual([
    'search_products',
    'search_rules',
  ]);
  expect(typesOf(run.frames)).toEqual(['product_list', 'rule_ref']);
  expectOnly(run, FOUND, [LEAD, MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] 漏法 3：第一轮无句末标点「我先看看」+ search_rules（残句留在 OutputGuard 缓冲），第二轮模型空文本、无工具调用 → 残句不被 guard.end() 冲出，用户只收到 agent.rule.found', async () => {
  const x = coreRig({
    scripts: { [QUESTION]: [{ text: LEAD_OPEN, calls: [RULES] }, {}] },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.complete).toHaveBeenCalledTimes(2);
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, [LEAD_OPEN]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] 出口：调过 search_rules 后最后一轮仍要工具（轮数用尽，finishText limit）→ 两轮模型文本都不下发，只出 agent.rule.found，done limit', async () => {
  const x = coreRig({
    scripts: {
      [QUESTION]: [
        { text: LEAD, calls: [RULES] },
        { text: '再查一下商品。', calls: [PRODUCTS] },
      ],
    },
    patch: { limits: { ...LIMITS, modelRounds: 2 } },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.execute.mock.calls.map(([call]) => call.name)).toEqual(['search_rules']);
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, [LEAD, '再查一下商品']);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] 出口：调过 search_rules 后工具调用次数用尽（同轮下一个调用不执行，finishText limit）→ 模型文本不下发，只出 agent.rule.found，done limit', async () => {
  const x = coreRig({
    scripts: { [QUESTION]: [{ text: LEAD, calls: [RULES, PRODUCTS] }] },
    patch: { limits: { ...LIMITS, toolCalls: 1 } },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'limit' });
  expect(x.execute.mock.calls.map(([call]) => call.name)).toEqual(['search_rules']);
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, [LEAD]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] 出口：调过 search_rules（卡已下发）后路由降级（finishText stop，不走降级路径）→ 模型文本不下发，只出 agent.rule.found，done stop', async () => {
  const degraded = vi.fn(async () => ({
    kind: 'done' as const,
    finishReason: 'fallback' as const,
  }));
  const x = coreRig({
    scripts: {
      [QUESTION]: [{ text: LEAD, calls: [RULES] }, { degraded: 'models_failed' }],
    },
    patch: { degraded: { run: degraded } },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(degraded).not.toHaveBeenCalled();
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, [LEAD]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07][BR-AI-06] 出口：调过 search_rules 后工具轮答成结构化文本（格式不合规，finishText stop）→ 前一轮与该轮模型文本都不下发，只出 agent.rule.found', async () => {
  const x = coreRig({
    scripts: {
      [QUESTION]: [
        { text: LEAD, calls: [RULES] },
        { text: '[{"type":"rule_ref"}]', calls: [PRODUCTS] },
      ],
    },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.execute.mock.calls.map(([call]) => call.name)).toEqual(['search_rules']);
  expectOnly(run, FOUND, [LEAD, 'rule_ref']);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07][BR-AI-06] 出口：调过 search_rules 后最终轮答成卡片 JSON（格式不合规，finishText stop）→ 模型文本不下发，只出 agent.rule.found', async () => {
  const x = coreRig({
    scripts: {
      [QUESTION]: [
        { text: LEAD, calls: [RULES] },
        { text: '{"type":"rule_ref","data":{"title":"提现规则"}}' },
      ],
    },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, [LEAD, 'rule_ref']);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] 出口：调过 search_rules 后最终轮答成意图对象（无 IntentPort 时原本出 out_of_scope）→ 只出 agent.rule.found，不出 agent.refuse.out_of_scope', async () => {
  const x = coreRig({
    scripts: {
      [QUESTION]: [{ calls: [RULES] }, { text: '{"agent_intent":"rule_qa"}' }],
    },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, ['agent_intent', fixed('agent.refuse.out_of_scope')]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] 出口：装了 IntentPort（它对最终文本会自己写一句并结束）时，调过 search_rules 后最终用户文本仍只有 agent.rule.found，不含意图端口或模型的文本', async () => {
  const handle = vi.fn<IntentPort['handle']>(async (_request, ctx) => {
    ctx.text('意图端口自己的答复。');
    return { kind: 'done', finishReason: 'stop' };
  });
  const x = coreRig({
    scripts: { [QUESTION]: [{ text: LEAD, calls: [RULES] }, { text: MODEL_TEXT }] },
    patch: { intents: { handle } },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['rule_ref']);
  expectOnly(run, FOUND, [LEAD, MODEL_TEXT, '意图端口自己的答复']);
  expectReplaced(run, true);
});

it('[AC-B3-08m#1][BR-AI-07] search_rules 调用失败（failed，无卡）也算调用过：模型文本不下发，按无命中出 agent.rule.not_found', async () => {
  const x = coreRig({
    scripts: { [QUESTION]: [{ text: LEAD, calls: [RULES] }, { text: MODEL_TEXT }] },
    answers: { search_rules: async () => failedTool() },
  });
  const run = await x.run(QUESTION);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual([]);
  expectOnly(run, fixed('agent.rule.not_found'), [LEAD, MODEL_TEXT]);
  expectReplaced(run, true);
});
