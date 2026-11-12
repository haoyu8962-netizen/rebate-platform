// B3-08zc · BR-AI-19 细则「助手回复落库」(2026-11-12): when a run ends, the assistant message's text
// (the text.delta frames the stream wrote, after OutputGuard) and the ids of the cards of the run
// are written to app.agent_messages, and the cards to app.agent_cards, with the terminal state —
// so right after the terminal frame was written (sendMessage resolved) the reply is there, without
// waiting for the asynchronous run trace (its writer is made to fail here). Production stream entry
// of [AC-B3-08g] over real PG; contract in ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import { openSession, usePgEach } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  ask,
  cardTypesOf,
  demoUrl,
  finishOf,
  productionRig,
  runIdOf,
} from '../trace-persist/kit.ts';
import {
  LIST_ARGS,
  LIST_ASK,
  cardIdsOf,
  deltasOf,
  expectReplyStored,
  held,
  interruptedRun,
  messageRowOf,
  replyTextOf,
  waitAt,
  withOrder,
  type Interruption,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08zc#1][BR-AI-19] 无模型降级找商品（done fallback）与确定性报价（done stop）同一会话两轮：终止帧写出后立即读库，各自 assistant 行 text = 本轮 text.delta 拼接、card_ids = 本轮卡片编号（下发顺序），agent_cards 恰为本轮卡片、内容同帧；留痕写入器一直失败也不影响', async () => {
  const x = await productionRig(pg.db);
  x.writer.set('throw');
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const searched = await ask(x, x.f.caller, sessionId, KEYWORD);
    expect(finishOf(searched)).toBe('fallback');
    expect(cardTypesOf(searched)).toEqual(['product_list']);
    await expectReplyStored(
      pg.db,
      { appId: x.appId, sessionId, runId: runIdOf(searched) },
      searched,
    );

    const quoted = await ask(x, x.f.caller, sessionId, await demoUrl(x));
    expect(finishOf(quoted)).toBe('stop');
    expect(cardTypesOf(quoted)).toEqual(['rebate_quote']);
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId: runIdOf(quoted) }, quoted);
    // The session's card ids go on across the two replies.
    expect(cardIdsOf(quoted)).not.toEqual(cardIdsOf(searched));
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08zc#1][BR-AI-19] 模型路径：先导语 + list_my_orders 出订单卡，再出结论（模板替换后的文字）：终止帧写出后立即读库，assistant 行 text 与下发的 text.delta 拼接逐字相同（过滤后的形式），card_ids 为订单卡编号，agent_cards 存该卡', async () => {
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('throw');
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, LIST_ASK);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['order_status']);
    expect(replyTextOf(frames), 'the reply has text').not.toBe('');
    const runId = runIdOf(frames);
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    // The user's row is untouched by the reply (its text stays the stored form of the message).
    const user = await messageRowOf(pg.db, runId, 'user');
    expect(user.card_ids).toEqual([]);
    expect(user.text).toBe(LIST_ASK);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

async function interruptedCase(how: Interruption): Promise<void> {
  const h = held();
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { before: waitAt(h), text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('throw');
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await interruptedRun(
      pg.db,
      x,
      h,
      sessionId,
      LIST_ASK,
      how,
      (written) => cardTypesOf(written).length > 0,
    );
    expect(finishOf(frames)).toBe(how);
    expect(cardTypesOf(frames), 'the order card went out before the end').toEqual(['order_status']);
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId: runIdOf(frames) }, frames);
  } finally {
    h.gate.open();
    await x.r.runtime.close();
  }
}

it('[AC-B3-08zc#1][BR-AI-19] 出订单卡后用户取消（done cancelled）：终止帧写出后立即读库，已下发的文字与订单卡随终态落库（text = 已下发 text.delta 拼接，card_ids 含该卡，agent_cards 存该卡）', async () => {
  await interruptedCase('cancelled');
}, 120_000);

it('[AC-B3-08zc#1][BR-AI-19] 出订单卡后 run 超时（done timeout）：终止帧写出后立即读库，text = 全部已下发 text.delta 拼接（含超时提示那一段），card_ids 与 agent_cards 含已下发的订单卡', async () => {
  await interruptedCase('timeout');
}, 120_000);

it('[AC-B3-08zc#1][BR-AI-19] 无文字的轮次（第一轮模型调用前就被取消，没有任何 text.delta 与卡片）：assistant 行 text 落空串（不是 NULL），card_ids 为空，agent_cards 无该 run 的行', async () => {
  const h = held();
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [{ before: waitAt(h), text: LEAD }],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('throw');
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await interruptedRun(pg.db, x, h, sessionId, LIST_ASK, 'cancelled', () => true);
    expect(finishOf(frames)).toBe('cancelled');
    expect(deltasOf(frames), 'precondition: no text was written').toEqual([]);
    expect(cardTypesOf(frames), 'precondition: no card was written').toEqual([]);
    const runId = runIdOf(frames);
    const assistant = await messageRowOf(pg.db, runId, 'assistant');
    expect(assistant.text).toBe('');
    expect(assistant.card_ids).toEqual([]);
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
  } finally {
    h.gate.open();
    await x.r.runtime.close();
  }
}, 120_000);
