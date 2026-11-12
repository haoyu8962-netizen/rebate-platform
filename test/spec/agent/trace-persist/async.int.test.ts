// B3-08q · BR-AI-19「每个 run 都必须异步落 PG，不阻塞 SSE」: the trace is written by
// createPgAgentTraceWriter apart from the stream. A slow writer does not hold the reply; a failing
// writer changes no frame and no finish reason and is logged as exactly one warn line (kit.ts
// TRACE_WARN, flat run_id, no card / argument / user text); a repeated write of the same card or
// call stays one row. Production stream entry of [AC-B3-08g] over real PG; the writer is the real
// one behind kit.ts controlWriter. Not here: the 24-hour local retry queue and agent.trace_lost
// (another task).
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD } from '../core-reply-templates/kit.ts';
import { LEVEL, openSession, until, usePgEach, type Frame } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  TRACE_WARN,
  ask,
  cardFramesOf,
  cardRowsOf,
  eventually,
  expectCardsStored,
  finishOf,
  pause,
  productionRig,
  runIdOf,
  shapeOf,
  toolCallRowsOf,
  toolCallsOnce,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const SEARCH_ASK = '帮我找合成保温杯';

it('[AC-B3-08q#5][BR-AI-19] trace 写者抛错：降级 run 的 SSE 帧序列与结局（fallback）与写入正常时一致；降级 run 没有工具调用，写者对该 run 不被调用、不记 warn；该 run 的卡随终态落库', async () => {
  // B3-08zc (BR-AI-19 细则「助手回复落库」, D10-1297): the cards no longer go through the writer —
  // they are committed with the run's ending, there at once whether the writer holds or throws,
  // and never handed to the writer.
  /** The card_ids of the reply's card frames (at least one). */
  const cardIdsOf = (frames: readonly Frame[]): string[] => {
    const ids = cardFramesOf(frames).map((frame) => String(frame.data['card_id']));
    expect(ids.length, 'the reply carried card frames').toBeGreaterThan(0);
    return ids;
  };
  /** The card_ids stored under the run right now (no polling), sorted. */
  const storedIdsOf = async (runId: string): Promise<string[]> =>
    (await cardRowsOf(pg.db, 'run_id', runId)).map((row) => row.card_id).sort();
  // The import list stays as on main (D10-1309, the diff stays inside the declared blocks); eventually is no longer used since the cards are committed with the ending, LEVEL since a degraded run logs no warn line.
  void eventually;
  void LEVEL;
  const x = await productionRig(pg.db);
  try {
    // The same message once with a working writer (its cards are stored) …
    const normalSession = await openSession(x.r, x.f.caller);
    const normal = await ask(x, x.f.caller, normalSession, KEYWORD);
    expect(finishOf(normal)).toBe('fallback');
    await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId: normalSession, runId: runIdOf(normal) },
      normal,
    );
    expect(x.f.logs.of(TRACE_WARN)).toEqual([]);

    // … and once with a writer that rejects every write.
    x.writer.set('throw');
    const failingSession = await openSession(x.r, x.f.caller);
    const failing = await ask(x, x.f.caller, failingSession, KEYWORD);
    const runId = runIdOf(failing);
    expect(shapeOf(failing)).toEqual(shapeOf(normal));
    expect(finishOf(failing)).toBe('fallback');
    // BR-AI-19 细则「助手回复落库」: the cards were committed with the ending, whatever the writer
    // does — there at once (no polling), once each.
    const cardIds = cardIdsOf(failing);
    expect(await storedIdsOf(runId), 'cards stored with the ending, once each').toEqual(
      [...cardIds].sort(),
    );
    await expectCardsStored(pg.db, { appId: x.appId, sessionId: failingSession, runId }, failing);

    // Whatever the failing trace would have written or logged has had its time.
    await pause(500);
    const asked = x.writer.calls.filter((call) => call.runId === runId);
    expect(
      asked.filter((call) => call.method === 'recordCards'),
      'cards never go through the trace writer',
    ).toEqual([]);
    // A degraded run makes no model tool call: the writer is never asked about it, so nothing of
    // it fails and no warn line is logged.
    expect(asked, 'the writer is not called for a degraded run').toEqual([]);
    expect(x.f.logs.of(TRACE_WARN)).toEqual([]);
    expect(await storedIdsOf(runId), 'no card written twice, none removed').toEqual(
      [...cardIds].sort(),
    );
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#5][BR-AI-19] trace 写者变慢（写入挂起）：回复照常结束，帧序列与结局与正常时一致；该 run 的卡在终态时已落库、不等写入放行，写者对该 run 不被调用', async () => {
  // B3-08zc (BR-AI-19 细则「助手回复落库」, D10-1297): the cards no longer go through the writer —
  // they are committed with the run's ending, there at once whether the writer holds or throws,
  // and never handed to the writer.
  /** The card_ids of the reply's card frames (at least one). */
  const cardIdsOf = (frames: readonly Frame[]): string[] => {
    const ids = cardFramesOf(frames).map((frame) => String(frame.data['card_id']));
    expect(ids.length, 'the reply carried card frames').toBeGreaterThan(0);
    return ids;
  };
  /** The card_ids stored under the run right now (no polling), sorted. */
  const storedIdsOf = async (runId: string): Promise<string[]> =>
    (await cardRowsOf(pg.db, 'run_id', runId)).map((row) => row.card_id).sort();
  const x = await productionRig(pg.db);
  let pending: Promise<unknown> | undefined;
  try {
    const normalSession = await openSession(x.r, x.f.caller);
    const normal = await ask(x, x.f.caller, normalSession, KEYWORD);
    await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId: normalSession, runId: runIdOf(normal) },
      normal,
    );

    x.writer.set('hold');
    const heldSession = await openSession(x.r, x.f.caller);
    const reply: { frames?: Frame[] } = {};
    pending = ask(x, x.f.caller, heldSession, KEYWORD).then((frames) => {
      reply.frames = frames;
    });
    await until('the reply ended while the trace write is held', () => reply.frames !== undefined);
    const frames = reply.frames ?? [];
    expect(shapeOf(frames)).toEqual(shapeOf(normal));
    expect(finishOf(frames)).toBe('fallback');
    const runId = runIdOf(frames);
    // The cards were committed with the ending: there at once (no polling) while every trace
    // write is held, once each, as framed.
    const cardIds = cardIdsOf(frames);
    expect(
      await storedIdsOf(runId),
      'cards stored with the ending while the writer is held',
    ).toEqual([...cardIds].sort());
    await expectCardsStored(pg.db, { appId: x.appId, sessionId: heldSession, runId }, frames);
    expect(
      x.writer.calls.filter((call) => call.runId === runId && call.method === 'recordCards'),
      'cards never go through the trace writer',
    ).toEqual([]);

    x.writer.release();
    // Whatever the held trace would have written once released has had its time.
    await pause(500);
    expect(await storedIdsOf(runId), 'no card written twice after release').toEqual(
      [...cardIds].sort(),
    );
    expect(
      x.writer.calls.filter((call) => call.runId === runId),
      'the writer is not called for a degraded run',
    ).toEqual([]);
    expect(x.f.logs.of(TRACE_WARN)).toEqual([]);
  } finally {
    x.writer.release();
    await pending?.catch(() => undefined);
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#5][BR-AI-19] 同一卡 / 同一调用重复投递（写者每次都写两遍）：按唯一键幂等，agent_cards 每个 card_id 一行、agent_tool_calls 每个 seq 一行，不记 warn', async () => {
  const x = await productionRig(pg.db, {
    scripts: {
      [SEARCH_ASK]: [
        { text: LEAD, calls: [{ name: 'search_products', args: { q: KEYWORD } }] },
        { text: '好的。' },
      ],
    },
  });
  try {
    x.writer.set('twice');
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, SEARCH_ASK);
    expect(finishOf(frames)).toBe('stop');
    const runId = runIdOf(frames);

    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    await toolCallsOnce(pg.db, runId, 1);
    expect(
      x.writer.calls.filter((call) => call.runId === runId && call.mode === 'twice').length,
    ).toBeGreaterThan(0);
    await pause(500);
    const rows = await cardRowsOf(pg.db, 'run_id', runId);
    for (const frame of cardFramesOf(frames)) {
      const id = frame.data['card_id'];
      expect(
        rows.filter((row) => row.card_id === id),
        String(id),
      ).toHaveLength(1);
    }
    const calls = await toolCallRowsOf(pg.db, 'run_id', runId);
    expect(calls.map((call) => [call.seq, call.name, call.status])).toEqual([
      [1, 'search_products', 'ok'],
    ]);
    expect(x.f.logs.of(TRACE_WARN)).toEqual([]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
