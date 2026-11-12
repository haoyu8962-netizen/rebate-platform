// B3-08zc · BR-AI-19 细则「助手回复落库」: the reply's text, card ids and cards are written in the SAME
// transaction as the run's terminal state. The runtime's database handle fails the first statement
// that inserts into agent_cards (./kit.ts failFirstCardInsert): the terminal state is then never
// committed without the reply — both are there, or neither (and no terminal frame went out). With
// the reply written by the asynchronous trace after the terminal state (the trunk before this task),
// the run ends with its terminal state committed and no reply. A fault met once can be hidden by a
// retry, so two more tests look from outside while the reply write waits on a lock another
// connection holds (the card row it is about to store, or its assistant row): nothing of the ending
// may be committed at that moment and no terminal frame may have gone out — which a terminal state
// committed first and a reply written (and retried) in a later transaction cannot meet. Production
// stream entry of [AC-B3-08g] over real PG; contract in ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import { openSession, until, usePgEach } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  ask,
  cardTypesOf,
  finishOf,
  productionRig,
  runIdOf,
} from '../trace-persist/kit.ts';
import {
  LIST_ARGS,
  LIST_ASK,
  blockCardInsert,
  cardIdsOf,
  carded,
  expectAllOrNothing,
  expectNothingCommitted,
  expectReplyStored,
  failFirstCardInsert,
  held,
  heldRun,
  lockAssistantRow,
  lockWaiters,
  messageIdOf,
  waitAt,
  withOrder,
  type Blocker,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08zc#2][BR-AI-19] 同事务：运行时的库句柄让第一条 INSERT agent_cards 失败（无模型降级找商品）——故障确被命中；终态（final_event）已提交则文字、card_ids、agent_cards 全在，未提交则三者全无且没有写出终止帧，不留半截', async () => {
  const fault = failFirstCardInsert(pg.db);
  const x = await productionRig(fault.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, KEYWORD);
    expect(cardTypesOf(frames), 'the run delivered its card').toEqual(['product_list']);
    const runId = runIdOf(frames);
    expect(fault.failed(), 'the reply write met the fault').toBe(1);
    await expectAllOrNothing(pg.db, { appId: x.appId, sessionId, runId }, frames);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08zc#2][BR-AI-19] 同事务（模型路径，订单卡）：第一条 INSERT agent_cards 失败——故障确被命中；终态与回复要么都已提交（文字、card_ids、agent_cards 与下发一致），要么都没有', async () => {
  const fault = failFirstCardInsert(pg.db);
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(fault.db, { scripts });
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, LIST_ASK);
    expect(cardTypesOf(frames), 'the run delivered its card').toEqual(['order_status']);
    const runId = runIdOf(frames);
    expect(fault.failed(), 'the reply write met the fault').toBe(1);
    await expectAllOrNothing(pg.db, { appId: x.appId, sessionId, runId }, frames);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

/** A second ask of the same session that lists the order again (its own script). */
const AGAIN_ASK = '再看看我最近买的牛奶返了吗';

it('[AC-B3-08zc#2][BR-AI-19] 同事务（写卡被挡住时从外面看）：另一连接持有与本轮订单卡同 card_id 的未提交行，回复写入等在这把锁上时——第三个连接看不到终态（final_event NULL）、assistant 行未动（text NULL、card_ids 空）、无本轮卡片行，客户端也没收到终止帧；放开后文字、card_ids、卡片与下发一致', async () => {
  const h = held();
  const lead: Step = { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] };
  const conclusion: Step = { text: ORDER_MODEL_TEXT };
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [lead, conclusion],
    [AGAIN_ASK]: [lead, { ...conclusion, before: waitAt(h) }],
  };
  const x = await productionRig(pg.db, { scripts });
  const outside = pg.pool();
  let blocker: Blocker | undefined;
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, LIST_ASK);
    expect(finishOf(first)).toBe('stop');
    const earlier = { appId: x.appId, sessionId, runId: runIdOf(first) };

    const run = await heldRun(x, h, sessionId, AGAIN_ASK, carded);
    const framed = run.frames();
    expect(cardTypesOf(framed), 'the order card of this turn went out').toEqual(['order_status']);
    const cardId = cardIdsOf(framed)[0]!;
    expect(cardIdsOf(first), 'a card_id of its own').not.toContain(cardId);
    const at = { appId: x.appId, sessionId, runId: runIdOf(framed) };

    blocker = await blockCardInsert(outside, earlier, cardId);
    h.gate.open();
    await until(
      'the reply write waits on the held card row',
      async () => (await lockWaiters(outside)) > 0,
    );
    await expectNothingCommitted(outside, at, run.frames());

    await blocker.release();
    blocker = undefined;
    const frames = await run.finish();
    expect(finishOf(frames)).toBe('stop');
    await expectReplyStored(pg.db, at, frames);
  } finally {
    h.gate.open();
    await blocker?.release();
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08zc#2][BR-AI-19] 同事务（写文字被挡住时从外面看）：另一连接锁住本轮 assistant 行（FOR UPDATE），回复写入等在这把锁上时——第三个连接看不到终态、看不到本轮卡片行，assistant 行未动，客户端没收到终止帧；放开后回复完整落库', async () => {
  const h = held();
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { before: waitAt(h), text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  const outside = pg.pool();
  let blocker: Blocker | undefined;
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);
    const run = await heldRun(x, h, sessionId, LIST_ASK, carded);
    const framed = run.frames();
    expect(cardTypesOf(framed), 'the order card went out').toEqual(['order_status']);
    const at = { appId: x.appId, sessionId, runId: runIdOf(framed) };

    blocker = await lockAssistantRow(outside, messageIdOf(framed));
    h.gate.open();
    await until(
      'the reply write waits on the locked assistant row',
      async () => (await lockWaiters(outside)) > 0,
    );
    await expectNothingCommitted(outside, at, run.frames());

    await blocker.release();
    blocker = undefined;
    const frames = await run.finish();
    expect(finishOf(frames)).toBe('stop');
    await expectReplyStored(pg.db, at, frames);
  } finally {
    h.gate.open();
    await blocker?.release();
    await x.r.runtime.close();
  }
}, 120_000);
