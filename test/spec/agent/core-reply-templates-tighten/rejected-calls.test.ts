// B3-08n · BR-AI-07 (gate review S1-2 of B3-08m): a call of search_rules or an order tool counts
// as「调用过」whatever became of it, also when it never ran: rejected by the ToolRegistry as
// invalid_args (here: an identity argument app_id, BR-AI-03) or rejected by the core for
// arguments that are not JSON (no execute at all). Either way the model's text of that run is not
// delivered, only the template (no hit / no order: agent.rule.not_found / order_list.empty), and
// the trace records text_replaced_by_template = true.
import { expect, it } from 'vitest';
import {
  LEAD,
  MODEL_TEXT,
  expectOnly,
  expectReplaced,
  fixed,
  outcomesOf,
  realTemplateTools,
  rig,
  type Call,
} from './kit.ts';

const REJECTED = { kind: 'rejected', modelView: { error: 'invalid_args' } };

/** Lead-in plus the one call, then the model's conclusion in the final round. */
function rejectedRun(call: Call) {
  const t = realTemplateTools();
  return {
    ...t,
    ...rig({ steps: [{ text: LEAD, calls: [call] }, { text: MODEL_TEXT }], tools: t.tools }),
  };
}

it('[AC-B3-08n#2.1][BR-AI-07] search_rules 参数带 app_id 被注册表判 invalid_args（未执行检索）→ 之后的模型文本不下发，只出 agent.rule.not_found，trace 记 text_replaced_by_template=true', async () => {
  const x = rejectedRun({ name: 'search_rules', args: { question: '提现最低多少', app_id: 'x' } });
  const run = await x.run();
  expect(await outcomesOf(x.execute)).toEqual([REJECTED]);
  expect(x.rules.activeChunks).not.toHaveBeenCalled();
  expect(run.trace?.tool_calls.map((c) => [c.name, c.status])).toEqual([
    ['search_rules', 'rejected'],
  ]);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, fixed('agent.rule.not_found'), [LEAD, MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08n#2.2][BR-AI-07] search_rules 参数 JSON 无法解析（core 直接拒、不执行）→ 之后的模型文本不下发，只出 agent.rule.not_found，trace 记 text_replaced_by_template=true', async () => {
  const x = rejectedRun({ name: 'search_rules', raw: '{"question":"提现最低' });
  const run = await x.run();
  expect(x.execute).not.toHaveBeenCalled();
  expect(x.rules.activeChunks).not.toHaveBeenCalled();
  expect(run.trace?.tool_calls.map((c) => [c.name, c.status])).toEqual([
    ['search_rules', 'rejected'],
  ]);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, fixed('agent.rule.not_found'), [LEAD, MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08n#2.3][BR-AI-07] explain_order 参数带 app_id 被注册表判 invalid_args（未查订单）→ 之后的模型文本不下发，只出 order_list.empty，trace 记 text_replaced_by_template=true', async () => {
  const x = rejectedRun({ name: 'explain_order', args: { card_id: 'c1', app_id: 'x' } });
  const run = await x.run();
  expect(await outcomesOf(x.execute)).toEqual([REJECTED]);
  expect(x.orders.resolve).not.toHaveBeenCalled();
  expect(x.orders.get).not.toHaveBeenCalled();
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, fixed('order_list.empty'), [LEAD, MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08n#2.4][BR-AI-07] list_my_orders 参数 JSON 无法解析（core 直接拒、不执行）→ 之后的模型文本不下发，只出 order_list.empty，trace 记 text_replaced_by_template=true', async () => {
  const x = rejectedRun({ name: 'list_my_orders', raw: '{not json' });
  const run = await x.run();
  expect(x.execute).not.toHaveBeenCalled();
  expect(x.orders.searchForAgent).not.toHaveBeenCalled();
  expect(run.trace?.tool_calls.map((c) => [c.name, c.status])).toEqual([
    ['list_my_orders', 'rejected'],
  ]);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, fixed('order_list.empty'), [LEAD, MODEL_TEXT]);
  expectReplaced(run, true);
});
