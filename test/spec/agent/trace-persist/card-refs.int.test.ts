// B3-08q · BR-AI-19 / BR-AI-07: with the run trace persisted, createOrderCardRefs (stream/mount/
// orders.ts, reading app.agent_cards) resolves in production a card_id the model quotes from an
// order card an earlier run of the same session delivered. Production stream entry of [AC-B3-08g]
// over real PG; orders are the fixture's recording stand-ins; the model is scripted.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import type { OrderDetail } from '../stream-assembly-orders/kit.ts';
import { openSession, usePgEach } from '../stream-mount/kit.ts';
import { item, selfDetail } from '../tools-orders/kit.ts';
import {
  ask,
  cardFramesOf,
  cardRowsOf,
  eventually,
  expectCardsStored,
  finishOf,
  productionRig,
  runIdOf,
  toolCallsOnce,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ORDER_ID = '0192f3a1-7c00-7000-8000-00000000d001';
const LIST_ASK = '我最近买的牛奶返了吗';
const EXPLAIN_ASK = '刚才那一单现在怎么样了';

it('[AC-B3-08q#2][BR-AI-19][BR-AI-07] 同一会话先 list_my_orders 出订单卡（落库），后一 run 用该 card_id 调 explain_order → 生产 createOrderCardRefs 解析到该订单：orders.get 收到 order_id，出 order_status 卡，不扣按单号次数', async () => {
  // The second run's arguments name the card the first run delivered (filled in after it).
  const scripts: Record<string, readonly Step[]> = {
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
  const x = await productionRig(pg.db, { scripts });
  try {
    x.f.searchForAgent.mockResolvedValue({
      orders: [item({ order_id: ORDER_ID, platform: 'taobao' })],
      total: 1,
    });
    const detail: OrderDetail = { ...selfDetail(), order_id: ORDER_ID };
    x.f.get.mockImplementation(async (_subject, orderId) => (orderId === ORDER_ID ? detail : null));
    const sessionId = await openSession(x.r, x.f.caller);

    // Run 1: one order card, stored under this session.
    const first = await ask(x, x.f.caller, sessionId, LIST_ASK);
    expect(finishOf(first)).toBe('stop');
    const orderCards = cardFramesOf(first).filter((frame) => frame.data['type'] === 'order_status');
    expect(orderCards).toHaveLength(1);
    const cardId = orderCards[0]!.data['card_id'] as string;
    expect((orderCards[0]!.data['data'] as Row)['order_id']).toBe(ORDER_ID);
    const firstRun = runIdOf(first);
    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId: firstRun }, first);

    // Run 2: the model quotes that card_id.
    scripts[EXPLAIN_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const second = await ask(x, x.f.caller, sessionId, EXPLAIN_ASK);
    expect(finishOf(second)).toBe('stop');
    expect(x.f.get).toHaveBeenCalledTimes(1);
    expect(x.f.get).toHaveBeenCalledWith({ app_id: x.appId, user_id: x.f.caller.userId }, ORDER_ID);
    expect(x.f.findOwnByNumber).not.toHaveBeenCalled();
    expect(x.f.daily.incr).not.toHaveBeenCalled();
    const explained = cardFramesOf(second);
    expect(explained.map((frame) => frame.data['type'])).toEqual(['order_status']);
    expect((explained[0]!.data['data'] as Row)['order_id']).toBe(ORDER_ID);

    const secondRun = runIdOf(second);
    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId: secondRun }, second);
    const calls = await toolCallsOnce(pg.db, secondRun, 1);
    expect(calls.map((call) => [call.seq, call.name, call.status])).toEqual([
      [1, 'explain_order', 'ok'],
    ]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#2][BR-AI-03][BR-AI-19] 别的会话引用这张已落库订单卡的 card_id → explain_order 被拒（invalid_args），orders.get 不被调用；卡只落在出卡的会话下', async () => {
  const scripts: Record<string, readonly Step[]> = {
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
  const x = await productionRig(pg.db, { scripts });
  try {
    x.f.searchForAgent.mockResolvedValue({
      orders: [item({ order_id: ORDER_ID, platform: 'taobao' })],
      total: 1,
    });
    const owner = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, owner, LIST_ASK);
    const cardId = cardFramesOf(first)[0]?.data['card_id'] as string;
    expect(cardId).toBeTypeOf('string');
    await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId: owner, runId: runIdOf(first) },
      first,
    );

    const elsewhere = await openSession(x.r, x.f.caller);
    scripts[EXPLAIN_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const second = await ask(x, x.f.caller, elsewhere, EXPLAIN_ASK);
    expect(x.f.get).not.toHaveBeenCalled();
    const calls = await toolCallsOnce(pg.db, runIdOf(second), 1);
    expect(calls.map((call) => [call.seq, call.name, call.status])).toEqual([
      [1, 'explain_order', 'rejected'],
    ]);
    // The order card stays the owner session's only.
    const stored = await eventually(
      'the owner session card rows',
      () => cardRowsOf(pg.db, 'session_id', owner),
      (rows) => rows.some((row) => row.card_id === cardId),
    );
    expect(stored.every((row) => row.session_id === owner)).toBe(true);
    const foreign = await cardRowsOf(pg.db, 'session_id', elsewhere);
    expect(foreign.filter((row) => row.type === 'order_status')).toEqual([]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
