// B3-08q · BR-AI-19「每个 run 都必须异步落 PG」for a run interrupted after it delivered a card
// (review r1 S1 on paths.int.test.ts): the model calls list_my_orders, the order card goes out, and
// while the model's next round is still in progress the run is ended by its time limit (fixture
// clock moved past the run's deadline → done 'timeout') or by the user (cancelRun → done
// 'cancelled'). The delivered card and its tool call are still stored under that run, and a later
// run of the same session that quotes the card_id to explain_order resolves the order (production
// createOrderCardRefs reads the stored card). The held model round answers only after the run has
// ended (as a model call cut off by the run's signal would). Production stream entry of
// [AC-B3-08g] over real PG; orders are the fixture's recording stand-ins; the model is scripted.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, gate, type Step } from '../core-reply-templates/kit.ts';
import type { OrderDetail } from '../stream-assembly-orders/kit.ts';
import {
  FakeReply,
  framesOf,
  message,
  openSession,
  retrace,
  runRow,
  stepUntil,
  until,
  usePgEach,
} from '../stream-mount/kit.ts';
import { item, selfDetail } from '../tools-orders/kit.ts';
import {
  ask,
  cardFramesOf,
  expectCardsStored,
  finishOf,
  productionRig,
  runIdOf,
  toolCallsOnce,
  type Frame,
  type ProductionRig,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ORDER_ID = '0192f3a1-7c00-7000-8000-00000000d002';
const LIST_ASK = '我最近买的牛奶返了吗';
const EXPLAIN_ASK = '刚才那一单现在怎么样了';
const LIST_ARGS = { date_from: '2026-10-01', date_to: '2026-10-06' };

type Interruption = 'timeout' | 'cancelled';

/**
 * Scripts and order stand-ins of one case: run 1 lists one order (one order_status card), then its
 * second model round waits on `held` (reached = true once it started); run 2's explain_order step
 * is filled in with the card_id once known.
 */
async function orderRig(db: Kysely<DB>) {
  const held = { reached: false, gate: gate() };
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      {
        before: async () => {
          held.reached = true;
          await held.gate.promise;
        },
        text: ORDER_MODEL_TEXT,
      },
    ],
  };
  const x = await productionRig(db, { scripts });
  x.f.searchForAgent.mockResolvedValue({
    orders: [item({ order_id: ORDER_ID, platform: 'taobao' })],
    total: 1,
  });
  const detail: OrderDetail = { ...selfDetail(), order_id: ORDER_ID };
  x.f.get.mockImplementation(async (_subject, orderId) => (orderId === ORDER_ID ? detail : null));
  return { x, scripts, held };
}

/**
 * Sends LIST_ASK on `sessionId`; once the order card went out and the model's second round is in
 * progress, ends the run by `how` (cancel: before the deadline; timeout: the fixture clock and
 * scheduler moved past the deadline). The held round answers only after the run ended. Returns the
 * reply's frames.
 */
async function interruptedAfterCard(
  db: Kysely<DB>,
  x: ProductionRig,
  held: { reached: boolean; gate: ReturnType<typeof gate> },
  sessionId: string,
  how: Interruption,
): Promise<Frame[]> {
  const reply = new FakeReply();
  let settled = false;
  let failure: unknown;
  const sending = x.r.runtime.http
    .sendMessage(retrace(x.f.caller), sessionId, message(LIST_ASK), reply)
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        failure = error;
      },
    );
  try {
    await until(
      'the order card went out and the second model round is in progress',
      () => held.reached && cardFramesOf(framesOf(reply.chunks)).length > 0,
    );
    expect(settled, 'the run is in progress').toBe(false);
    const runId = runIdOf(framesOf(reply.chunks));
    const deadlineAt = (await runRow(db, runId))['deadline_at'] as string | Date;
    const deadlineMs = new Date(deadlineAt).getTime();
    const leftMs = deadlineMs - x.f.time.clock.now().getTime();
    expect(leftMs, 'the run is before its deadline').toBeGreaterThan(0);

    if (how === 'cancelled') {
      const answer = new FakeReply();
      await x.r.runtime.http.cancelRun(retrace(x.f.caller), runId, answer);
      const call = answer.single();
      expect(call.status, JSON.stringify(call.body)).toBe(200);
      await stepUntil(x.r, db, () => settled, x.f.time.t + leftMs - 1);
      expect(settled, 'the cancelled run ended before its deadline').toBe(true);
    } else {
      await stepUntil(x.r, db, () => settled, x.f.time.t + leftMs + 5_000);
      expect(settled, 'the run ended at its time limit').toBe(true);
    }
    await sending;
    expect(failure, 'the send handler resolved').toBeUndefined();
    return framesOf(reply.chunks);
  } finally {
    // The model's held round answers now (after the run ended, or to let a failed case wind down).
    held.gate.open();
    await sending;
  }
}

async function caseOf(how: Interruption): Promise<void> {
  const { x, scripts, held } = await orderRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await interruptedAfterCard(pg.db, x, held, sessionId, how);
    expect(finishOf(first)).toBe(how);
    const orderCards = cardFramesOf(first).filter((frame) => frame.data['type'] === 'order_status');
    expect(orderCards, 'the order card was delivered before the interruption').toHaveLength(1);
    const cardId = orderCards[0]!.data['card_id'] as string;
    expect((orderCards[0]!.data['data'] as Row)['order_id']).toBe(ORDER_ID);
    const firstRun = runIdOf(first);

    // The delivered card and its tool call are stored under the interrupted run.
    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId: firstRun }, first);
    const calls = await toolCallsOnce(pg.db, firstRun, 1);
    expect(calls.map((call) => [call.seq, call.name, call.status, call.app_id])).toEqual([
      [1, 'list_my_orders', 'ok', x.appId],
    ]);
    expect(calls[0]?.args).toEqual(x.r.runtime.traceMask(LIST_ARGS, {}));

    // A later run of the same session quotes that card_id: the order is resolved from it.
    scripts[EXPLAIN_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const second = await ask(x, x.f.caller, sessionId, EXPLAIN_ASK);
    expect(finishOf(second)).toBe('stop');
    expect(x.f.get).toHaveBeenCalledTimes(1);
    expect(x.f.get).toHaveBeenCalledWith({ app_id: x.appId, user_id: x.f.caller.userId }, ORDER_ID);
    expect(x.f.findOwnByNumber).not.toHaveBeenCalled();
    const explained = cardFramesOf(second);
    expect(explained.map((frame) => frame.data['type'])).toEqual(['order_status']);
    expect((explained[0]!.data['data'] as Row)['order_id']).toBe(ORDER_ID);
  } finally {
    held.gate.open();
    await x.r.runtime.close();
  }
}

it('[AC-B3-08q#3][AC-B3-08q#2][BR-AI-19] 出订单卡后 run 超时（夹具时钟越过 run 时限 → done timeout）：已下发的卡与 list_my_orders 调用仍落 agent_cards / agent_tool_calls（该 run 名下）；同会话后一 run 用该 card_id 调 explain_order 能解析到该订单', async () => {
  await caseOf('timeout');
}, 120_000);

it('[AC-B3-08q#3][AC-B3-08q#2][BR-AI-19] 出订单卡后用户取消 run（cancelRun → done cancelled）：已下发的卡与 list_my_orders 调用仍落 agent_cards / agent_tool_calls（该 run 名下）；同会话后一 run 用该 card_id 调 explain_order 能解析到该订单', async () => {
  await caseOf('cancelled');
}, 120_000);
