// B3-08n · BR-AI-07 (gate review S1-1 of B3-08m): once this run called search_rules or an order
// tool, the model's text is never delivered, also when that call failed and returned no card
// (nothing reached the user yet). A later router degradation (models_failed), structured text in a
// tool round, or structured text in the final round must not take the degraded path (whose
// keyword search / copy would answer instead of the template); the user gets exactly the template
// text: agent.rule.not_found for a failed search_rules, agent.order.lookup_limited for an
// explain_order by number over the daily limit ({error:'rate_limited'}, no card).
// The template tools are the real tools/rules and tools/orders handlers behind the real registry.
import { expect, it } from 'vitest';
import type { InputCheckPort } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { proceedOf } from '../stream-model-prereq/kit.ts';
import {
  LEAD,
  MODEL_TEXT,
  STRUCTURED,
  expectOnly,
  expectReplaced,
  fixed,
  outcomesOf,
  realTemplateTools,
  rig,
  typesOf,
  type Step,
} from './kit.ts';

const ORDER_NO = '990000000001';
const RULES = { name: 'search_rules', args: { question: '提现最低多少' } } as const;
const BY_NUMBER = { name: 'explain_order', args: { order_no: '<num_1>', platform: 'jd' } } as const;
const PRODUCTS = { name: 'search_products', args: { q: '保温杯' } } as const;
const NOT_FOUND = fixed('agent.rule.not_found');
const LIMITED = fixed('agent.order.lookup_limited');

/** The number behind <num_1> (as the input redaction does, BR-AI-14). */
function numberCheck(): InputCheckPort {
  return {
    check: async (value) => ({ ...proceedOf(value.text), placeholders: { '<num_1>': ORDER_NO } }),
  };
}

/** search_rules whose rule store fails (repository error): failed, no card. */
function failingRules(steps: readonly Step[]) {
  const t = realTemplateTools();
  t.rules.activeChunks.mockRejectedValue(new Error('synthetic repository error'));
  return { ...t, ...rig({ steps, tools: t.tools }) };
}

/** explain_order by number after the daily by-number limit is spent: rate_limited, no card. */
function limitedExplain(steps: readonly Step[]) {
  const t = realTemplateTools();
  t.orders.take.mockResolvedValue(false);
  return { ...t, ...rig({ steps, tools: t.tools, patch: { inputCheck: numberCheck() } }) };
}

it('[AC-B3-08n#1.1][BR-AI-07] search_rules 仓储出错（failed、无卡）后下一轮路由降级 models_failed → 不走降级路径，用户只收到 agent.rule.not_found，无任何模型文本，done stop', async () => {
  const x = failingRules([{ text: LEAD, calls: [RULES] }, { degraded: 'models_failed' }]);
  const run = await x.run();
  expect(await outcomesOf(x.execute)).toEqual([
    { kind: 'failed', modelView: { error: 'tool_failed' } },
  ]);
  expect(x.degraded).not.toHaveBeenCalled();
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual([]);
  expectOnly(run, NOT_FOUND, [LEAD, MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08n#1.2][BR-AI-07] search_rules 仓储出错（failed、无卡）后下一轮工具轮是结构化文本（格式不合规）→ 不走降级路径，只出 agent.rule.not_found，done stop', async () => {
  const x = failingRules([{ calls: [RULES] }, { text: STRUCTURED, calls: [PRODUCTS] }]);
  const run = await x.run();
  expect(x.execute).toHaveBeenCalledTimes(1);
  expect(x.degraded).not.toHaveBeenCalled();
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual([]);
  expectOnly(run, NOT_FOUND, [STRUCTURED, '"type"']);
  expectReplaced(run, true);
  expect(run.trace?.model_format_invalid).toBe(true);
});

it('[AC-B3-08n#1.3][BR-AI-07] search_rules 仓储出错（failed、无卡）后最终轮是结构化文本（格式不合规）→ 不走降级路径，只出 agent.rule.not_found，done stop', async () => {
  const x = failingRules([{ text: LEAD, calls: [RULES] }, { text: STRUCTURED }]);
  const run = await x.run();
  expect(x.degraded).not.toHaveBeenCalled();
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, NOT_FOUND, [LEAD, STRUCTURED, '"type"']);
  expectReplaced(run, true);
});

it('[AC-B3-08n#1.4][BR-AI-07] explain_order 按单号超当日上限（{error:"rate_limited"}、无卡）后下一轮路由降级 models_failed → 不走降级路径，只出 agent.order.lookup_limited，无任何模型文本，done stop', async () => {
  const x = limitedExplain([{ text: LEAD, calls: [BY_NUMBER] }, { degraded: 'models_failed' }]);
  const run = await x.run();
  const [outcome] = await outcomesOf(x.execute);
  expect(outcome?.kind).toBe('ok');
  expect(outcome?.modelView).toEqual({ error: 'rate_limited' });
  expect(x.orders.findOwnByNumber).not.toHaveBeenCalled();
  expect(x.degraded).not.toHaveBeenCalled();
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual([]);
  expectOnly(run, LIMITED, [LEAD, MODEL_TEXT, fixed('order_list.empty')]);
  expectReplaced(run, true);
});

it('[AC-B3-08n#1.5][BR-AI-07] explain_order 按单号超当日上限（rate_limited、无卡）后下一轮工具轮是结构化文本 → 不走降级路径，只出 agent.order.lookup_limited，done stop', async () => {
  const x = limitedExplain([{ calls: [BY_NUMBER] }, { text: STRUCTURED, calls: [PRODUCTS] }]);
  const run = await x.run();
  expect(x.execute).toHaveBeenCalledTimes(1);
  expect(x.degraded).not.toHaveBeenCalled();
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual([]);
  expectOnly(run, LIMITED, [STRUCTURED, '"type"', fixed('order_list.empty')]);
  expectReplaced(run, true);
  expect(run.trace?.model_format_invalid).toBe(true);
});

it('[AC-B3-08n#1.6][BR-AI-07] explain_order 按单号超当日上限（rate_limited、无卡）后最终轮是结构化文本 → 不走降级路径，只出 agent.order.lookup_limited，done stop', async () => {
  const x = limitedExplain([{ text: LEAD, calls: [BY_NUMBER] }, { text: STRUCTURED }]);
  const run = await x.run();
  expect(x.degraded).not.toHaveBeenCalled();
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, LIMITED, [LEAD, STRUCTURED, '"type"']);
  expectReplaced(run, true);
});
