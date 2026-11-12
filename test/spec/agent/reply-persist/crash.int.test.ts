// B3-08zc · BR-AI-19 细则「助手回复落库」: a run whose process dies before its terminal state and that
// another request finalizes (BR-AI-23 细则: a later message of the session once the run lock has
// expired, or the same client_msg_id sent again) cannot get its text and cards back — they were
// only in the dead process. Its assistant row keeps no text and no card ids, the order card it had
// already framed is not written afterwards, and the history shows text '', no cards and the finish
// reason that finalization stored. Process A is the production stream entry of [AC-B3-08g] whose
// held model round never answers and whose clock never moves again; process B is another stream
// runtime (../stream-mount/kit.ts rig) with a clock of its own; contract in ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import {
  PassInputCheck,
  framesOf,
  message,
  openSession,
  rig,
  runRow,
  send,
  sessionRow,
  usePgEach,
} from '../stream-mount/kit.ts';
import { cardRowsOf, cardTypesOf, productionRig, runIdOf } from '../trace-persist/kit.ts';
import {
  EXPLAIN_ASK,
  LIST_ARGS,
  LIST_ASK,
  anotherProcess,
  cardIdsOf,
  carded,
  dyingRun,
  expectReplyStored,
  expectHistory,
  held,
  historySide,
  isTerminal,
  listHistory,
  messageIdOf,
  messageRowOf,
  userItemOf,
  waitAt,
  withOrder,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Finisher = 'later_message' | 'repeated_message';

async function caseOf(by: Finisher): Promise<void> {
  const h = held();
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { before: waitAt(h), text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('throw');
  withOrder(x);
  const sessionId = await openSession(x.r, x.f.caller);
  const body = message(LIST_ASK);
  const framed = await dyingRun(x, h, sessionId, body, (frames) => cardTypesOf(frames).length > 0);
  expect(cardTypesOf(framed), 'the order card reached the client').toEqual(['order_status']);
  const runId = runIdOf(framed);
  // Process A is dead from here on: never driven again, never closed.

  const b = await rig(pg.db, { inputCheck: new PassInputCheck() });
  try {
    const lockEnd = new Date(
      (await sessionRow(pg.db, sessionId))['run_lock_expires_at'] as string | Date,
    ).getTime();
    const waitMs = lockEnd - b.time.clock.now().getTime() + 1_000;
    await b.time.to(b.time.t + Math.max(0, waitMs));

    if (by === 'later_message') {
      const later = await send(b, x.f.caller, sessionId, message('提现记录在哪看'));
      expect(later.jsons, 'the later message was accepted').toEqual([]);
    } else {
      const again = framesOf((await send(b, x.f.caller, sessionId, body)).chunks);
      expect(again).toHaveLength(2);
      expect(again[0]?.event).toBe('meta');
      expect(again[0]?.data['duplicate']).toBe(true);
      expect(isTerminal(again[1]!), 'the finalized terminal frame').toBe(true);
    }

    const run = await runRow(pg.db, runId);
    expect(run['final_event'], 'finalized by the other request').not.toBeNull();
    expect(run['finish_reason'], 'a finish reason was stored').toBeTypeOf('string');
    const assistant = await messageRowOf(pg.db, runId, 'assistant');
    expect([null, ''], 'no reply text').toContain(assistant.text);
    expect(assistant.card_ids, 'no card ids').toEqual([]);
    expect(await cardRowsOf(pg.db, 'run_id', runId), 'the framed card is not written').toEqual([]);

    const history = await historySide(pg.pool(), b.time.clock);
    const { reply, caller } = await listHistory(history, x.f.caller, sessionId);
    const data = await expectHistory(reply, caller);
    const [user, answer] = data.items;
    expect(user, 'the user message of the dead run').toEqual({
      ...(await userItemOf(pg.db, runId)),
      created_at: expect.any(String),
    });
    expect(answer, 'the reply of the dead run').toEqual({
      message_id: messageIdOf(framed),
      role: 'assistant',
      created_at: expect.any(String),
      text: '',
      cards: [],
      finish_reason: run['finish_reason'],
    });
    expect(data.items, 'items of the session').toHaveLength(by === 'later_message' ? 4 : 2);
  } finally {
    await b.runtime.close();
  }
}

it('[AC-B3-08zc#5][BR-AI-19][BR-AI-23] 崩溃收尾（后续请求收尾旧 run）：进程在终态前消失，同会话下一条消息在 run 锁过期后由别的进程受理并收尾旧 run——旧 run 的 assistant 文字为空、card_ids 空、已下发的卡不补写，历史里该条 text 为空串、cards 为空、finish_reason 照收尾结果', async () => {
  await caseOf('later_message');
}, 120_000);

it('[AC-B3-08zc#5][BR-AI-19][BR-AI-23] 崩溃收尾（重复 client_msg_id 收尾）：进程在终态前消失，同一 client_msg_id 在 run 锁过期后发到别的进程——重复应答两帧，旧 run 的文字为空、card_ids 空、已下发的卡不补写，历史里该条 text 为空串、cards 为空、finish_reason 照收尾结果', async () => {
  await caseOf('repeated_message');
}, 120_000);

it('[AC-B3-08zc#5][BR-AI-19][BR-AI-05] 崩溃收尾后下一轮引用那张卡：进程 A 下发订单卡后在终态前消失；另一生产进程 B 在 run 锁过期后受理同会话下一条消息（收尾旧 run），这一轮用旧卡的 card_id 调 explain_order——该卡没有落库，按 createOrderCardRefs 对不存在的卡的语义无效：orders.get 不被调用、不出订单卡、该编号不被复用；本轮回复照常落库', async () => {
  const h = held();
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { before: waitAt(h), text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('throw');
  withOrder(x);
  const sessionId = await openSession(x.r, x.f.caller);
  const framed = await dyingRun(x, h, sessionId, message(LIST_ASK), carded);
  expect(cardTypesOf(framed), 'the order card reached the client').toEqual(['order_status']);
  const deadCard = cardIdsOf(framed)[0]!;
  const deadRun = runIdOf(framed);
  // Process A is dead from here on: never driven again, never closed.

  const b = await anotherProcess(pg.db, x);
  try {
    const lockEnd = new Date(
      (await sessionRow(pg.db, sessionId))['run_lock_expires_at'] as string | Date,
    ).getTime();
    await b.time.to(b.time.t + Math.max(0, lockEnd - b.time.clock.now().getTime() + 1_000));
    scripts[EXPLAIN_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: deadCard } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const frames = framesOf((await send(b, x.f.caller, sessionId, message(EXPLAIN_ASK))).chunks);
    expect(frames.some(isTerminal), 'the next turn ended').toBe(true);

    const dead = await runRow(pg.db, deadRun);
    expect(dead['final_event'], 'the dead run was finalized by that request').not.toBeNull();
    expect(await cardRowsOf(pg.db, 'run_id', deadRun), 'its card was never stored').toEqual([]);
    expect(x.f.get, 'the card did not resolve to the order').not.toHaveBeenCalled();
    expect(cardTypesOf(frames), 'no order card from an unresolved card_id').not.toContain(
      'order_status',
    );
    expect(cardIdsOf(frames), 'card ids are never reused').not.toContain(deadCard);
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId: runIdOf(frames) }, frames);
  } finally {
    await b.runtime.close();
  }
}, 120_000);
