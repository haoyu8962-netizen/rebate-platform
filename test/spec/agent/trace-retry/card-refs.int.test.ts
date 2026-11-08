// B3-08y · B3-08q S2 (BR-AI-03 / BR-AI-07 / BR-AI-19): the order card an earlier run of the same
// session delivered resolves by card_id even while its trace is not stored yet (the write still in
// flight, or failed and waiting in the local queue): the runtime's OrderCardRefs read this
// process's pending cards first (withPendingCards), then PG (createOrderCardRefs, unchanged).
// Production stream entry of [AC-B3-08g] over real PG; orders are the fixture's stand-ins; the
// model is scripted. Contract: ./kit.ts header.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import type { OrderDetail } from '../stream-assembly-orders/kit.ts';
import { framesOf, message, openSession, send, until, usePgEach } from '../stream-mount/kit.ts';
import { item, selfDetail } from '../tools-orders/kit.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { cardFramesOf, cardRowsOf, finishOf, runIdOf, type Row } from '../trace-persist/kit.ts';
import { ORDER_ID, WRITE_FAILED } from './kit.ts';
import { traceRig, type TraceRig, type WriterMode } from './runtime-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const LIST_ASK = '我最近买的牛奶返了吗';
const EXPLAIN_ASK = '刚才那一单现在怎么样了';
const ELSEWHERE_ASK = '那一单到底怎么样了';

function listScripts(): Record<string, readonly Step[]> {
  return {
    [LIST_ASK]: [
      {
        text: LEAD,
        calls: [
          { name: 'list_my_orders', args: { date_from: '2026-10-01', date_to: '2026-10-06' } },
        ],
      },
      { text: ORDER_MODEL_TEXT },
    ],
  };
}

function explainSteps(cardId: string): readonly Step[] {
  return [
    { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
    { text: ORDER_MODEL_TEXT },
  ];
}

async function ask(x: TraceRig, caller: AgentCaller, sessionId: string, text: string) {
  return framesOf((await send(x.r, caller, sessionId, message(text))).chunks);
}

/**
 * Run 1 of `sessionId` lists one order (one order_status card) with the writer in `mode`; returns
 * the card_id. Its card is not stored when this returns.
 */
async function deliverOrderCard(x: TraceRig, sessionId: string, mode: WriterMode) {
  x.f.searchForAgent.mockResolvedValue({
    orders: [item({ order_id: ORDER_ID, platform: 'taobao' })],
    total: 1,
  });
  const detail: OrderDetail = { ...selfDetail(), order_id: ORDER_ID };
  x.f.get.mockImplementation(async (_subject, orderId) => (orderId === ORDER_ID ? detail : null));
  x.writer.set(mode);
  const first = await ask(x, x.f.caller, sessionId, LIST_ASK);
  expect(finishOf(first)).toBe('stop');
  const orderCards = cardFramesOf(first).filter((frame) => frame.data['type'] === 'order_status');
  expect(orderCards).toHaveLength(1);
  const cardId = orderCards[0]?.data['card_id'];
  expect(cardId).toBeTypeOf('string');
  expect((orderCards[0]?.data['data'] as Row | undefined)?.['order_id']).toBe(ORDER_ID);
  const runId = runIdOf(first);
  if (mode === 'throw') {
    await until(
      'run 1 trace write refused and warned',
      () =>
        x.writer.of(runId, 'throw').length > 0 &&
        x.logs.of(WRITE_FAILED).some((line) => line['run_id'] === runId),
    );
  } else {
    await until('run 1 trace write reached the writer', () => x.writer.of(runId).length > 0);
  }
  expect(await cardRowsOf(pg.db, 'run_id', runId), 'run 1 card not stored yet').toEqual([]);
  return cardId as string;
}

/** The explain run resolved the card: orders.get got the order id; no order-number lookup. */
function expectResolved(x: TraceRig, frames: ReturnType<typeof framesOf>) {
  expect(finishOf(frames)).toBe('stop');
  expect(x.f.get).toHaveBeenCalledTimes(1);
  expect(x.f.get).toHaveBeenCalledWith({ app_id: x.appId, user_id: x.f.caller.userId }, ORDER_ID);
  expect(x.f.findOwnByNumber).not.toHaveBeenCalled();
  expect(x.f.daily.incr).not.toHaveBeenCalled();
  const explained = cardFramesOf(frames);
  expect(explained.map((frame) => frame.data['type'])).toEqual(['order_status']);
  expect((explained[0]?.data['data'] as Row | undefined)?.['order_id']).toBe(ORDER_ID);
}

it('[AC-B3-08y#7][BR-AI-07][BR-AI-19] 上一个 run 的订单卡还在写（写者挂起、未落库）：同一会话下一个 run 用 explain_order 按 card_id 解析到该订单', async () => {
  const scripts = listScripts();
  const x = await traceRig(pg.db, { scripts });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const cardId = await deliverOrderCard(x, sessionId, 'hold');
    scripts[EXPLAIN_ASK] = explainSteps(cardId);
    x.writer.set('pass');
    const second = await ask(x, x.f.caller, sessionId, EXPLAIN_ASK);
    expectResolved(x, second);
  } finally {
    x.writer.release();
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08y#7][BR-AI-07][BR-AI-19] 上一个 run 的订单卡写入失败、在本地队列里等再写（PG 故障）：同一会话下一个 run 照样按 card_id 解析到', async () => {
  const scripts = listScripts();
  const x = await traceRig(pg.db, { scripts });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const cardId = await deliverOrderCard(x, sessionId, 'throw');
    scripts[EXPLAIN_ASK] = explainSteps(cardId);
    const second = await ask(x, x.f.caller, sessionId, EXPLAIN_ASK);
    expectResolved(x, second);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08y#7][BR-AI-03][BR-AI-07] 未落库的订单卡只在出卡的会话里有效：别的会话引用同一 card_id 不解析（orders.get 不被调用、不出订单卡），出卡的会话随后照常解析', async () => {
  const scripts = listScripts();
  const x = await traceRig(pg.db, { scripts });
  try {
    const owner = await openSession(x.r, x.f.caller);
    const cardId = await deliverOrderCard(x, owner, 'hold');

    const elsewhere = await openSession(x.r, x.f.caller);
    scripts[ELSEWHERE_ASK] = explainSteps(cardId);
    const foreign = await ask(x, x.f.caller, elsewhere, ELSEWHERE_ASK);
    expect(x.f.get).not.toHaveBeenCalled();
    expect(cardFramesOf(foreign).filter((frame) => frame.data['type'] === 'order_status')).toEqual(
      [],
    );

    scripts[EXPLAIN_ASK] = explainSteps(cardId);
    const own = await ask(x, x.f.caller, owner, EXPLAIN_ASK);
    expectResolved(x, own);
  } finally {
    x.writer.release();
    await x.r.runtime.close();
  }
}, 120_000);
