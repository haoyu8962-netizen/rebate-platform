// B3-08n · BR-AI-07 T5 (gate review S2-b of B3-08m): 「多笔订单用 order_list.summary」 counts
// orders, not order tool results. list_my_orders (valid arguments, really run by the real
// handler behind the real registry) finds one order (WAITING) and its order_status card is
// delivered as c1; explain_order then quotes c1 and reaches that same order. Card references are
// the core's real ones (orchestrator/core/card-references.ts), and refs.resolve knows only the
// order_status cards actually delivered in this run. One order: order_status.WAITING.summary,
// never order_list.summary; the model's text does not go out.
import { expect, it } from 'vitest';
import { cardReference } from '../../../../apps/api/src/modules/agent/orchestrator/core/card-references.ts';
import type { OrderCardRefs } from '../../../../apps/api/src/modules/agent/tools/orders/index.ts';
import { item, selfDetail } from '../tools-orders/kit.ts';
import {
  LEAD,
  MODEL_TEXT,
  expectOnly,
  expectReplaced,
  fixed,
  outcomesOf,
  realTemplateTools,
  rig,
  typesOf,
} from './kit.ts';

const ORDER_ID = '0192f3a1-7c00-7000-8000-00000000e001';
/** A valid list_my_orders window (schema: date_from / date_to required; fixture clock 2026-10-23). */
const WINDOW = { date_from: '2026-10-20', date_to: '2026-10-23' };

it('[AC-B3-08n#4][BR-AI-07] list_my_orders（合法参数、真实执行）返回一笔 WAITING 订单并投递卡 c1，再 explain_order 引用 c1 指向同一单 → 按订单只算一笔：只出 order_status.WAITING.summary，不是 order_list.summary', async () => {
  const t = realTemplateTools();
  const waiting = item({ order_id: ORDER_ID, display_status: 'WAITING', reason: null });
  t.orders.searchForAgent.mockResolvedValue({ orders: [waiting], total: 1 });
  t.orders.get.mockResolvedValue({
    ...selfDetail(),
    order_id: ORDER_ID,
    display_status: 'WAITING',
    reason: null,
  });
  const x = rig({
    tools: t.tools,
    steps: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: WINDOW }] },
      { calls: [{ name: 'explain_order', args: { card_id: 'c1' } }] },
      { text: MODEL_TEXT },
    ],
  });
  // The orders tools issue the core's real card references (resolved to delivered card ids).
  t.orders.cardReference.mockImplementation(cardReference);
  // Only an order_status card actually delivered in this run resolves, to its own order.
  t.orders.resolve.mockImplementation(async (cardId): ReturnType<OrderCardRefs['resolve']> => {
    const frame = x.delivered.find((f) => f.card_id === cardId && f.type === 'order_status');
    const orderId = frame?.data['order_id'];
    return typeof orderId === 'string' ? { kind: 'order', orderId } : { kind: 'invalid' };
  });

  const run = await x.run();

  const outcomes = await outcomesOf(t.execute);
  expect(t.execute.mock.calls.map(([call]) => call.name)).toEqual([
    'list_my_orders',
    'explain_order',
  ]);
  expect(outcomes.map((o) => o.kind)).toEqual(['ok', 'ok']);
  expect(t.orders.searchForAgent).toHaveBeenCalledTimes(1);
  // list_my_orders delivered the order's card as c1, and the model saw c1 for it.
  expect(run.frames[0]?.type).toBe('order_status');
  expect(run.frames[0]?.card_id).toBe('c1');
  expect(run.frames[0]?.data['order_id']).toBe(ORDER_ID);
  const second = x.complete.mock.calls[1]?.[0].messages ?? [];
  expect(second.some((m) => m.role === 'tool' && String(m.content).includes('"c1"'))).toBe(true);
  // explain_order resolved c1 to that same order.
  expect(t.orders.resolve.mock.calls[0]?.[0]).toBe('c1');
  expect(await t.orders.resolve.mock.results[0]?.value).toEqual({
    kind: 'order',
    orderId: ORDER_ID,
  });
  expect(t.orders.get.mock.calls[0]?.[1]).toBe(ORDER_ID);
  expect(new Set(typesOf(run.frames))).toEqual(new Set(['order_status']));
  expect(new Set(run.frames.map((f) => f.data['order_id']))).toEqual(new Set([ORDER_ID]));

  expect(run.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expectOnly(run, fixed('order_status.WAITING.summary'), [
    LEAD,
    MODEL_TEXT,
    fixed('order_list.summary'),
  ]);
  expectReplaced(run, true);
});
