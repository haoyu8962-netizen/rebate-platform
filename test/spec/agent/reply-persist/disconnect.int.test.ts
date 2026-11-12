// B3-08zc · BR-AI-19 细则「助手回复落库」with 02 §9.2「取消与断线」: a client that goes away does not
// stop the run within the disconnect grace; the run goes on as usual, its later text and cards are
// no longer framed but are stored all the same (the client reloads the history afterwards). The
// stored reply equals that of the same script on a connected client (a reference run in a session
// of its own). Production stream entry of [AC-B3-08g] over real PG, model scripted; the manual clock
// is never moved, so the grace never runs out; contract in ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import { openSession, runRow, usePgEach } from '../stream-mount/kit.ts';
import {
  ask,
  cardFramesOf,
  cardRowsOf,
  cardTypesOf,
  finishOf,
  productionRig,
  runIdOf,
} from '../trace-persist/kit.ts';
import {
  LIST_ARGS,
  LIST_ASK,
  cardIdsOf,
  disconnectedRun,
  expectReplyStored,
  held,
  isTerminal,
  messageRowOf,
  replyTextOf,
  waitAt,
  withOrder,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Gone = 'before_card' | 'after_card';

async function caseOf(gone: Gone): Promise<void> {
  const h = held();
  const lead: Step = { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] };
  const conclusion: Step = { text: ORDER_MODEL_TEXT };
  const scripts: Record<string, readonly Step[]> = {
    // Run 1 (reference, connected), then run 2 (the client goes away at the held round).
    [LIST_ASK]: [
      lead,
      conclusion,
      ...(gone === 'before_card'
        ? [{ ...lead, before: waitAt(h) }, conclusion]
        : [lead, { ...conclusion, before: waitAt(h) }]),
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  x.writer.set('throw');
  try {
    withOrder(x);
    const referenceSession = await openSession(x.r, x.f.caller);
    const reference = await ask(x, x.f.caller, referenceSession, LIST_ASK);
    expect(finishOf(reference)).toBe('stop');
    expect(cardTypesOf(reference)).toEqual(['order_status']);
    await expectReplyStored(
      pg.db,
      { appId: x.appId, sessionId: referenceSession, runId: runIdOf(reference) },
      reference,
    );

    const sessionId = await openSession(x.r, x.f.caller);
    expect(sessionId, 'a session of its own').not.toBe(referenceSession);
    const { frames } = await disconnectedRun(x, h, sessionId, LIST_ASK);
    expect(frames.some(isTerminal), 'no terminal frame reached the client').toBe(false);
    expect(cardFramesOf(frames).length, 'cards that reached the client').toBe(
      gone === 'before_card' ? 0 : 1,
    );
    const runId = runIdOf(frames);
    const run = await runRow(pg.db, runId);
    expect(run['final_event'], 'the run ended').not.toBeNull();
    expect(run['finish_reason'], 'it ran to its end as usual').toBe('stop');

    // The whole reply is stored, as the connected reference's.
    const assistant = await messageRowOf(pg.db, runId, 'assistant');
    expect(assistant.text, 'the stored text').toBe(replyTextOf(reference));
    expect(assistant.card_ids, 'the stored card ids').toEqual(cardIdsOf(reference));
    const rows = await cardRowsOf(pg.db, 'run_id', runId);
    expect(
      rows.map((row) => [
        row.app_id,
        row.session_id,
        row.card_id,
        row.type,
        row.schema_version,
        row.fallback_text,
        (row.data as Row)['order_id'],
      ]),
    ).toEqual(
      cardFramesOf(reference).map((frame) => [
        x.appId,
        sessionId,
        frame.data['card_id'],
        frame.data['type'],
        frame.data['schema_version'],
        frame.data['fallback_text'],
        (frame.data['data'] as Row)['order_id'],
      ]),
    );
    // A card that did reach the client is stored as it was framed.
    for (const frame of cardFramesOf(frames)) {
      const row = rows.find((found) => found.card_id === frame.data['card_id']);
      expect(row?.data, `stored ${String(frame.data['card_id'])}`).toEqual(frame.data['data']);
    }
  } finally {
    h.gate.open();
    await x.r.runtime.close();
  }
}

it('[AC-B3-08zc#4][BR-AI-19] 断线（模型第一轮前客户端断开，宽限期内跑完）：run 照常跑到 done stop，之后的文字与订单卡不再写帧但照样编号落库——assistant 行 text、card_ids、agent_cards 与同脚本连线时的回复一致', async () => {
  await caseOf('before_card');
}, 120_000);

it('[AC-B3-08zc#4][BR-AI-19] 断线（订单卡已下发、结论那一轮前客户端断开）：run 照常跑到 done stop，断线前后的文字都落库（与同脚本连线时一致），已下发的卡按帧内容落库', async () => {
  await caseOf('after_card');
}, 120_000);
