// B3-08m · BR-AI-07 T5: after list_my_orders / explain_order the model's text is never delivered;
// the core writes order_list.summary (more than one order), order_status.<display_status>.summary
// (one order, reason_code empty; display_status per BR-FUND-17's table, e.g. PAID / WAITING),
// order_reason.<reason_code>.summary (one order with a reason) or order_list.empty (none). The
// template inputs are the tools/orders trace members (orders: reason_code, display_status).
// Contract: orchestrator/core/reply-templates.ts.
import { expect, it } from 'vitest';
import {
  LEAD,
  ORDER_MODEL_TEXT,
  PAID,
  PART_REFUND,
  WAITING,
  coreRig,
  expectOnly,
  expectReplaced,
  fixed,
  ordersFound,
  typesOf,
} from './kit.ts';

const ASK = '我昨天买的牛奶返了吗';
const LIST = {
  name: 'list_my_orders',
  args: { date_from: '2026-11-06', date_to: '2026-11-06' },
} as const;
const EXPLAIN = { name: 'explain_order', args: { card_id: 'c1' } } as const;
const RULES = { name: 'search_rules', args: { question: '返利什么时候到账' } } as const;

it('[AC-B3-08m#3][BR-AI-07] list_my_orders 查到 2 笔 → 只出 order_list.summary，工具轮与最终轮模型文本都不下发；2 张 order_status 卡照发', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ text: LEAD, calls: [LIST] }, { text: ORDER_MODEL_TEXT }] },
    answers: { list_my_orders: async () => ordersFound([PAID, WAITING]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['order_status', 'order_status']);
  expectOnly(run, fixed('order_list.summary'), [LEAD, ORDER_MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] explain_order 得 (PAID, reason_code 空) → 只出 order_status.PAID.summary，模型「已返利到账」结论不下发', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ calls: [EXPLAIN] }, { text: ORDER_MODEL_TEXT }] },
    answers: { explain_order: async () => ordersFound([PAID]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['order_status']);
  expectOnly(run, fixed('order_status.PAID.summary'), [ORDER_MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] explain_order 得 (WAITING, reason_code 空) → 只出 order_status.WAITING.summary；工具轮文本无句末标点也不被冲出', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ text: '我查一下这笔', calls: [EXPLAIN] }, { text: ORDER_MODEL_TEXT }] },
    answers: { explain_order: async () => ordersFound([WAITING]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['order_status']);
  expectOnly(run, fixed('order_status.WAITING.summary'), ['我查一下这笔', ORDER_MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] explain_order 得 reason_code 非空（PART_REFUND）→ 只出 order_reason.PART_REFUND.summary，不用 order_status.*', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ calls: [EXPLAIN] }, { text: ORDER_MODEL_TEXT }] },
    answers: { explain_order: async () => ordersFound([PART_REFUND]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, fixed('order_reason.PART_REFUND.summary'), [ORDER_MODEL_TEXT, 'order_status.']);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] list_my_orders 查到 0 笔 → 只出 order_list.empty（handoff 卡照发），模型文本不下发', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ calls: [LIST] }, { text: ORDER_MODEL_TEXT }] },
    answers: { list_my_orders: async () => ordersFound([]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['handoff']);
  expectOnly(run, fixed('order_list.empty'), [ORDER_MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] 调过 explain_order（PAID）后最终轮模型空文本 → 仍出 order_status.PAID.summary', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ calls: [EXPLAIN] }, {}] },
    answers: { explain_order: async () => ordersFound([PAID]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(x.complete).toHaveBeenCalledTimes(2);
  expect(typesOf(run.frames)).toEqual(['order_status']);
  expectOnly(run, fixed('order_status.PAID.summary'), []);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] 调过 list_my_orders（2 笔）后最终轮模型空文本 → 仍出 order_list.summary', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ calls: [LIST] }, {}] },
    answers: { list_my_orders: async () => ordersFound([PAID, WAITING]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, fixed('order_list.summary'), []);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] 一个 run 先 list_my_orders（1 笔）再 explain_order（1 笔）→ 全 run 合计 2 笔，出 order_list.summary（不是只看最后一次调用）', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ calls: [LIST] }, { calls: [EXPLAIN] }, { text: ORDER_MODEL_TEXT }] },
    answers: {
      list_my_orders: async () => ordersFound([WAITING]),
      explain_order: async () => ordersFound([PAID]),
    },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['order_status', 'order_status']);
  expectOnly(run, fixed('order_list.summary'), [ORDER_MODEL_TEXT]);
  expectReplaced(run, true);
});

it('[AC-B3-08m#3][BR-AI-07] 同一 run 既调 explain_order（PAID）又调 search_rules（命中）→ 依次出 order_status.PAID.summary 与 agent.rule.found，模型文本不下发', async () => {
  const x = coreRig({
    scripts: { [ASK]: [{ text: LEAD, calls: [RULES, EXPLAIN] }, { text: ORDER_MODEL_TEXT }] },
    answers: { explain_order: async () => ordersFound([PAID]) },
  });
  const run = await x.run(ASK);
  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(typesOf(run.frames)).toEqual(['rule_ref', 'order_status']);
  expectOnly(run, fixed('order_status.PAID.summary') + fixed('agent.rule.found'), [
    LEAD,
    ORDER_MODEL_TEXT,
  ]);
  expectReplaced(run, true);
});
