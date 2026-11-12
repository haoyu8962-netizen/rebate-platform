// B3-08zc · BR-AI-19 细则「助手回复落库」: the stream may run as several processes and is released
// blue-green, so nothing of a reply may live only in a process. The first runtime answers with an
// order card and is closed (the run trace's writer failing throughout, so nothing reaches PG by the
// trace and no in-process pending card is left); a runtime built afterwards on the same database
// (new assembly, new runtime) resolves that card for explain_order, and a history read side on
// another pool sees both replies. With the trace writer held (nothing of the trace written), the
// order card is resolved from committed agent_cards only: in its own session, never in another
// (BR-AI-03; successor of trace-retry/card-refs.int.test.ts, see ./kit.ts). Production stream entry
// of [AC-B3-08g] over real PG; contract in ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import { framesOf, message, openSession, send, usePgEach, type Rig } from '../stream-mount/kit.ts';
import {
  cardFramesOf,
  cardTypesOf,
  finishOf,
  productionRig,
  runIdOf,
  type ProductionRig,
} from '../trace-persist/kit.ts';
import {
  EXPLAIN_ASK,
  LIST_ARGS,
  LIST_ASK,
  ORDER_ID,
  assistantItemOf,
  expectHistory,
  expectReplyStored,
  historySide,
  listHistory,
  timelessItems,
  userItemOf,
  withOrder,
  type Frame,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** One message of the fixture's caller through `r`; the reply's frames once it ended. */
async function askOn(r: Rig, x: ProductionRig, sessionId: string, text: string): Promise<Frame[]> {
  return framesOf((await send(r, x.f.caller, sessionId, message(text))).chunks);
}

it('[AC-B3-08zc#3][BR-AI-19][BR-AI-20] 跨进程：运行时 A 出订单卡后关闭（留痕写入器一直失败）；同库新建的运行时 B 里下一轮用该 card_id 调 explain_order 能解析到订单（不靠进程内待写卡）；另一连接池上的历史读侧看到两轮的文字与卡片', async () => {
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('throw');
  const other: { rig: Rig | null } = { rig: null };
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);

    // Process A: the order card, stored with the reply; then A is gone.
    const first = await askOn(x.r, x, sessionId, LIST_ASK);
    expect(finishOf(first)).toBe('stop');
    const orders = cardFramesOf(first).filter((frame) => frame.data['type'] === 'order_status');
    expect(orders).toHaveLength(1);
    const cardId = orders[0]!.data['card_id'] as string;
    expect((orders[0]!.data['data'] as Row)['order_id']).toBe(ORDER_ID);
    const firstRun = runIdOf(first);
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId: firstRun }, first);
    await x.r.runtime.close();

    // Process B: built afterwards over the same database, with nothing of A in memory.
    await x.f.time.to(x.f.time.t + 1_000);
    scripts[EXPLAIN_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const b = x.f.mount(x.f.build());
    other.rig = b;
    const second = await askOn(b, x, sessionId, EXPLAIN_ASK);
    expect(finishOf(second)).toBe('stop');
    expect(x.f.get).toHaveBeenCalledTimes(1);
    expect(x.f.get).toHaveBeenCalledWith({ app_id: x.appId, user_id: x.f.caller.userId }, ORDER_ID);
    expect(cardTypesOf(second)).toEqual(['order_status']);
    const secondRun = runIdOf(second);
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId: secondRun }, second);

    // A read side of its own, on another pool.
    const history = await historySide(pg.pool(), x.f.time.clock);
    const { reply, caller } = await listHistory(history, x.f.caller, sessionId);
    const data = await expectHistory(reply, caller);
    expect(data.expired).toBe(false);
    expect(data.next_cursor).toBeNull();
    expect(timelessItems(data.items)).toEqual([
      await userItemOf(pg.db, firstRun),
      await assistantItemOf(pg.db, first),
      await userItemOf(pg.db, secondRun),
      await assistantItemOf(pg.db, second),
    ]);
  } finally {
    await x.r.runtime.close();
    await other.rig?.runtime.close();
  }
}, 120_000);

const ELSEWHERE_ASK = '那一单到底怎么样了';

it('[AC-B3-08zc#3][BR-AI-19][BR-AI-03] 留痕写者挂起（留痕一行未写）：上一轮订单卡已随终态落库；别的会话引用同一 card_id 不解析（orders.get 不被调用、不出订单卡），出卡的会话下一轮照常解析到该订单——都只读已提交的 agent_cards', async () => {
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('hold');
  try {
    withOrder(x);
    const owner = await openSession(x.r, x.f.caller);
    const first = await askOn(x.r, x, owner, LIST_ASK);
    expect(finishOf(first)).toBe('stop');
    const cardId = cardFramesOf(first)[0]?.data['card_id'] as string;
    expect(cardTypesOf(first)).toEqual(['order_status']);
    const at = { appId: x.appId, sessionId: owner, runId: runIdOf(first) };
    await expectReplyStored(pg.db, at, first);

    const elsewhere = await openSession(x.r, x.f.caller);
    scripts[ELSEWHERE_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const foreign = await askOn(x.r, x, elsewhere, ELSEWHERE_ASK);
    expect(
      foreign.some((frame) => frame.event === 'meta'),
      'the foreign turn ran',
    ).toBe(true);
    expect(x.f.get, 'another session never resolves the card').not.toHaveBeenCalled();
    expect(cardTypesOf(foreign)).not.toContain('order_status');

    scripts[EXPLAIN_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const own = await askOn(x.r, x, owner, EXPLAIN_ASK);
    expect(finishOf(own)).toBe('stop');
    expect(x.f.get).toHaveBeenCalledTimes(1);
    expect(x.f.get).toHaveBeenCalledWith({ app_id: x.appId, user_id: x.f.caller.userId }, ORDER_ID);
    expect(cardTypesOf(own)).toEqual(['order_status']);
  } finally {
    x.writer.release();
    await x.r.runtime.close();
  }
}, 120_000);
