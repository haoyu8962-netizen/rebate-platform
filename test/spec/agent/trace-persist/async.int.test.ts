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

it('[AC-B3-08q#5][BR-AI-19] trace 写者抛错：降级 run 的 SSE 帧序列与结局（fallback）与写入正常时一致；只记一条 warn（agent_trace_write_failed，带 run_id，不含卡片与用户文本），该 run 不落卡', async () => {
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

    await eventually(
      'the failing writer was reached for this run',
      async () => x.writer.calls.filter((call) => call.runId === runId && call.mode === 'throw'),
      (calls) => calls.length > 0,
    );
    await eventually(
      'the trace warn line',
      async () => x.f.logs.of(TRACE_WARN),
      (lines) => lines.length > 0,
    );
    // Whatever else the failing trace would have written has had its time.
    await pause(500);
    const lines = x.f.logs.of(TRACE_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: LEVEL.warn, run_id: runId });
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain(KEYWORD);
    for (const field of ['card', 'cards', 'data', 'args', 'items', 'user_text', 'text']) {
      expect(lines[0], field).not.toHaveProperty(field);
    }
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#5][BR-AI-19] trace 写者变慢（写入挂起）：回复照常结束，帧序列与结局与正常时一致；写入放行后该 run 的卡才落库', async () => {
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

    await eventually(
      'the held writer was reached for this run',
      async () => x.writer.calls.filter((call) => call.runId === runId && call.mode === 'hold'),
      (calls) => calls.length > 0,
    );
    expect(await cardRowsOf(pg.db, 'run_id', runId), 'nothing written while held').toEqual([]);

    x.writer.release();
    await expectCardsStored(pg.db, { appId: x.appId, sessionId: heldSession, runId }, frames);
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
