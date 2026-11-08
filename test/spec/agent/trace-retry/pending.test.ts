// B3-08y · B3-08q S2 (BR-AI-03 / BR-AI-07 / BR-AI-19): a card this process delivered whose trace is
// not yet stored (write in flight or queued) still resolves by card_id in its own app and session.
// TraceRedoQueue.pendingCard and withPendingCards (stream/mount/trace-retry.ts) over a scripted
// writer and stand-in OrderCardRefs. Contract: ./kit.ts header. No database.
import { expect, it, vi } from 'vitest';
import type { OrderCardRefs } from '../../../../apps/api/src/modules/agent/tools/orders/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import {
  withPendingCards,
  type PendingCardSource,
} from '../../../../apps/api/src/modules/agent/stream/mount/trace-retry.ts';
import type { CardInput } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import {
  APP,
  ORDER_ID,
  OTHER_APP,
  OTHER_SESSION,
  SECOND,
  SESSION,
  earningsCard,
  newRunId,
  notice,
  orderCard,
  queueRig,
  record,
  settle,
} from './kit.ts';

const INVALID = { kind: 'invalid' } as const;

function ctxOf(appId: string, sessionId: string): ToolCallContext {
  return {
    appId,
    userId: '0192f3a1-7c00-7000-8000-0000000c0001',
    deviceId: '0192f3a1-7c00-7000-8000-0000000c0002',
    phoneBound: true,
    runId: newRunId(),
    sessionId,
    signal: new AbortController().signal,
    placeholders: {},
  };
}

/** Stand-in for createOrderCardRefs(db): answers `answer` for every card_id. */
function storedRefs(answer: Awaited<ReturnType<OrderCardRefs['resolve']>> = INVALID) {
  const resolve = vi.fn<OrderCardRefs['resolve']>(async () => answer);
  const refs: OrderCardRefs = { resolve };
  return { refs, resolve };
}

/** A pending-card source holding `cards` under (app, session, card_id). */
function pendingOf(entries: readonly (readonly [string, string, CardInput])[]) {
  const pendingCard = vi.fn<PendingCardSource['pendingCard']>(
    (appId, sessionId, cardId) =>
      entries.find(
        ([app, session, card]) => app === appId && session === sessionId && card.card_id === cardId,
      )?.[2] ?? null,
  );
  const source: PendingCardSource = { pendingCard };
  return { source, pendingCard };
}

// ── TraceRedoQueue.pendingCard ──
it('[AC-B3-08y#7][BR-AI-19] 首次写入还挂着：本 app + 本会话按 card_id 取得到已下发的卡；别的会话、别的 app、不存在的 card_id 取不到；写成后清掉', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('hold');
  void queue.persist(record({ cards: [notice('c1'), orderCard('c2')] }));
  expect(queue.pendingCard(APP, SESSION, 'c2')).toEqual(orderCard('c2'));
  expect(queue.pendingCard(APP, SESSION, 'c1')).toEqual(notice('c1'));
  expect(queue.pendingCard(APP, OTHER_SESSION, 'c2')).toBeNull();
  expect(queue.pendingCard(OTHER_APP, SESSION, 'c2')).toBeNull();
  expect(queue.pendingCard(APP, SESSION, 'c3')).toBeNull();

  q.w.release();
  await settle();
  expect(queue.pendingCard(APP, SESSION, 'c2')).toBeNull();
  expect(queue.pendingCard(APP, SESSION, 'c1')).toBeNull();
});

it('[AC-B3-08y#7][BR-AI-19] 写入失败进队后照样取得到（PG 故障期间也有效）；再写成功后清掉', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  await queue.persist(record({ cards: [orderCard('c2')] }));
  expect(queue.queued()).toBe(1);
  expect(queue.pendingCard(APP, SESSION, 'c2')).toEqual(orderCard('c2'));
  await q.time.to(30 * SECOND);
  expect(queue.pendingCard(APP, SESSION, 'c2'), 'still queued').toEqual(orderCard('c2'));

  q.w.set('pass');
  await q.time.to(2 * 60 * SECOND);
  expect(queue.queued()).toBe(0);
  expect(queue.pendingCard(APP, SESSION, 'c2')).toBeNull();
});

it('[AC-B3-08y#7][BR-AI-19] 记 lost（停机）或 skipped 后也清掉', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  await queue.persist(record({ cards: [orderCard('c2')] }));
  expect(await q.time.drive(queue.close(SECOND), q.time.t + SECOND)).toBe(true);
  expect(queue.pendingCard(APP, SESSION, 'c2')).toBeNull();

  const s = queueRig();
  const skipping = s.build();
  s.w.set('skip');
  await skipping.persist(record({ cards: [orderCard('c2')] }));
  expect(skipping.pendingCard(APP, SESSION, 'c2')).toBeNull();
});

// ── withPendingCards ──
it('[AC-B3-08y#7][BR-AI-03][BR-AI-07] 本会话内存里的 order_status 卡（data.order_id 非空）→ {kind: order}；app 与会话只取自工具上下文', async () => {
  const stored = storedRefs();
  const pending = pendingOf([[APP, SESSION, orderCard('c2')]]);
  const refs = withPendingCards(stored.refs, pending.source);
  expect(await refs.resolve('c2', ctxOf(APP, SESSION))).toEqual({
    kind: 'order',
    orderId: ORDER_ID,
  });
  expect(pending.pendingCard).toHaveBeenCalledWith(APP, SESSION, 'c2');
});

it('[AC-B3-08y#7][BR-AI-03] 同一 card_id 换一个会话或 app：内存不命中，交给落库的解析（这里答 invalid）', async () => {
  const stored = storedRefs();
  const pending = pendingOf([[APP, SESSION, orderCard('c2')]]);
  const refs = withPendingCards(stored.refs, pending.source);
  const elsewhere = ctxOf(APP, OTHER_SESSION);
  expect(await refs.resolve('c2', elsewhere)).toEqual(INVALID);
  expect(stored.resolve).toHaveBeenCalledWith('c2', elsewhere);
  const otherApp = ctxOf(OTHER_APP, SESSION);
  expect(await refs.resolve('c2', otherApp)).toEqual(INVALID);
  expect(stored.resolve).toHaveBeenCalledWith('c2', otherApp);
  expect(pending.pendingCard).toHaveBeenCalledWith(OTHER_APP, SESSION, 'c2');
});

it('[AC-B3-08y#7][BR-AI-07] 收益卡、别的类型、order_id 为空或缺失的订单卡都不能经内存解析：交给落库的解析', async () => {
  const empty: CardInput = { ...orderCard('c4'), data: { order_id: '', actions: [] } };
  const missing: CardInput = { ...orderCard('c5'), data: { actions: [] } };
  const numeric: CardInput = { ...orderCard('c6'), data: { order_id: 42 } };
  const stored = storedRefs();
  const pending = pendingOf([
    [APP, SESSION, earningsCard('c1')],
    [APP, SESSION, notice('c3')],
    [APP, SESSION, empty],
    [APP, SESSION, missing],
    [APP, SESSION, numeric],
  ]);
  const refs = withPendingCards(stored.refs, pending.source);
  for (const cardId of ['c1', 'c3', 'c4', 'c5', 'c6']) {
    expect(await refs.resolve(cardId, ctxOf(APP, SESSION)), cardId).toEqual(INVALID);
  }
  expect(stored.resolve).toHaveBeenCalledTimes(5);
});

it('[AC-B3-08y#7][BR-AI-19] 内存不命中时原样返回落库解析的结果（createOrderCardRefs 的语义不变）', async () => {
  const stored = storedRefs({ kind: 'order', orderId: ORDER_ID });
  const pending = pendingOf([]);
  const refs = withPendingCards(stored.refs, pending.source);
  const ctx = ctxOf(APP, SESSION);
  expect(await refs.resolve('c9', ctx)).toEqual({ kind: 'order', orderId: ORDER_ID });
  expect(stored.resolve).toHaveBeenCalledWith('c9', ctx);
});

it('[AC-B3-08y#7][BR-AI-19] 接在队列上：写入挂起期间解析到内存里的订单卡，写成后改由落库的解析回答', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('hold');
  void queue.persist(record({ cards: [orderCard('c2')] }));
  const stored = storedRefs();
  const refs = withPendingCards(stored.refs, queue);
  expect(await refs.resolve('c2', ctxOf(APP, SESSION))).toEqual({
    kind: 'order',
    orderId: ORDER_ID,
  });
  q.w.release();
  await settle();
  expect(await refs.resolve('c2', ctxOf(APP, SESSION))).toEqual(INVALID);
  expect(stored.resolve).toHaveBeenCalledTimes(1);
});
