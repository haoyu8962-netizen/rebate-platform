// B3-08m · BR-AI-07 订单类判定 3 / 4 through the core: explain_order by order_no.
//   3. 按 order_no 在名下查不到 → 文本 order_reason.NOT_TRACKED.summary，出 claim_draft 卡;
//   4. 当天按 order_no 已达 agent.explain_order.order_no_daily_max（默认 20）→ 该次不查，
//      {error:"rate_limited"} 给模型，文本 agent.order.lookup_limited.
// The core runs the real explain_order handler behind the real ToolRegistry (tools/orders and the
// tools-orders kit's fixture, unchanged), so the template input is whatever tools/orders really
// returns: a miss is not order_list.empty, and an over-limit call is neither an empty list nor a
// reason to let the model's text through. Contract: orchestrator/core/reply-templates.ts.
import { expect, it, vi } from 'vitest';
import type { InputCheckPort } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createExplainOrderHandler,
  type OrderNoQuota,
} from '../../../../apps/api/src/modules/agent/tools/orders/index.ts';
import { createToolRegistry } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { proceedOf } from '../stream-model-prereq/kit.ts';
import { fixture } from '../tools-orders/kit.ts';
import {
  LEAD,
  ORDER_MODEL_TEXT,
  coreRig,
  expectOnly,
  expectReplaced,
  fixed,
  typesOf,
  type Step,
} from './kit.ts';

const ORDER_NO = '990000000001';
const ASK = `我的订单 ${ORDER_NO} 返了吗`;
/** BR-AI-14: the model quotes the number through this run's placeholder. */
const BY_NUMBER = { name: 'explain_order', args: { order_no: '<num_1>', platform: 'jd' } } as const;

/** Lets the message through, the number behind <num_1> (as the input redaction does). */
function numberCheck(): InputCheckPort {
  return {
    check: async (value) => ({
      ...proceedOf(value.text),
      placeholders: { '<num_1>': ORDER_NO },
    }),
  };
}

/** BR-AI-07 判定 4: this user already looked up the default 20 order numbers today. */
function spentQuota() {
  let used = 20;
  return vi.fn<OrderNoQuota['take']>(async () => {
    used += 1;
    return used <= 20;
  });
}

/** One core body whose only tool is the real explain_order behind the real ToolRegistry. */
function explainRig(steps: readonly Step[], quota?: ReturnType<typeof spentQuota>) {
  const f = fixture(quota === undefined ? {} : { quota: { take: quota } });
  const tools = createToolRegistry({
    handlers: [createExplainOrderHandler(f.deps)],
    switches: { get: async () => true },
    logger: { warn: vi.fn() },
  });
  const calls = vi.spyOn(tools, 'execute');
  const x = coreRig({ scripts: { [ASK]: steps }, patch: { tools, inputCheck: numberCheck() } });
  return { ...x, f, calls };
}

it('[AC-B3-08m#3][BR-AI-07] explain_order 按单号在名下查不到（真实工具：claim_draft、无订单）→ 只出 order_reason.NOT_TRACKED.summary，不是 order_list.empty；claim_draft 卡照发，模型文本不下发', async () => {
  const x = explainRig([{ text: LEAD, calls: [BY_NUMBER] }, { text: ORDER_MODEL_TEXT }]);
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.calls).toHaveBeenCalledTimes(1);
  expect(x.f.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(x.f.findOwnByNumber.mock.calls[0]?.[1]).toEqual({ order_no: ORDER_NO, platform: 'jd' });
  expect(typesOf(run.frames)).toEqual(['claim_draft']);
  expect(run.frames[0]?.data).toMatchObject({ platform: 'jd', order_no: ORDER_NO });
  expectOnly(run, fixed('order_reason.NOT_TRACKED.summary'), [
    LEAD,
    ORDER_MODEL_TEXT,
    fixed('order_list.empty'),
  ]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] explain_order 按单号查不到后最终轮模型空文本 → 仍出 order_reason.NOT_TRACKED.summary（claim_draft 卡照发）', async () => {
  const x = explainRig([{ calls: [BY_NUMBER] }, {}]);
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.complete).toHaveBeenCalledTimes(2);
  expect(x.f.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(typesOf(run.frames)).toEqual(['claim_draft']);
  expectOnly(run, fixed('order_reason.NOT_TRACKED.summary'), [fixed('order_list.empty')]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] 当天按单号已查满默认 20 次后再调 explain_order（真实工具：rate_limited、无卡）→ 只出 agent.order.lookup_limited，不当空订单、不查单号，模型文本不下发', async () => {
  const take = spentQuota();
  const x = explainRig([{ text: LEAD, calls: [BY_NUMBER] }, { text: ORDER_MODEL_TEXT }], take);
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.calls).toHaveBeenCalledTimes(1);
  expect(take).toHaveBeenCalledTimes(1);
  expect(x.f.findOwnByNumber).not.toHaveBeenCalled();
  expect(x.f.read).not.toHaveBeenCalled();
  expect(typesOf(run.frames)).toEqual([]);
  expectOnly(run, fixed('agent.order.lookup_limited'), [
    LEAD,
    ORDER_MODEL_TEXT,
    fixed('order_list.empty'),
    fixed('order_reason.NOT_TRACKED.summary'),
  ]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] 按单号查询超限后最终轮模型空文本 → 仍出 agent.order.lookup_limited，无卡、不查单号', async () => {
  const take = spentQuota();
  const x = explainRig([{ calls: [BY_NUMBER] }, {}], take);
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.complete).toHaveBeenCalledTimes(2);
  expect(take).toHaveBeenCalledTimes(1);
  expect(x.f.findOwnByNumber).not.toHaveBeenCalled();
  expect(typesOf(run.frames)).toEqual([]);
  expectOnly(run, fixed('agent.order.lookup_limited'), [fixed('order_list.empty')]);
  expectReplaced(run, true);
});
