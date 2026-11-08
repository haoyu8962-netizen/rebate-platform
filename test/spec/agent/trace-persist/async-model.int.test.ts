// B3-08q · BR-AI-19「每个 run 都必须异步落 PG，不阻塞 SSE」on the MODEL path (review r1 S1 on
// async.int.test.ts: its slow / failing writer only met degraded runs, which have no tool calls, so
// recordToolCalls was never held or failed). A scripted model calls search_products and the run
// delivers a product_list; with the writer held, the reply still ends (done 'stop') before anything
// is written and both the card and the tool call land once released; with the writer throwing, the
// frames and the finish reason are those of a normal run, the run row is not an error, exactly one
// warn line (kit.ts TRACE_WARN, flat run_id) is logged, no promise rejection is left unhandled and
// the runtime goes on serving. Production stream entry of [AC-B3-08g] over real PG; the writer is
// the real one behind kit.ts controlWriter. Not here: the 24-hour local retry queue and
// agent.trace_lost (another task).
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, type Step } from '../core-reply-templates/kit.ts';
import { LEVEL, openSession, runRow, until, usePgEach, type Frame } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  TRACE_WARN,
  ask,
  cardRowsOf,
  cardTypesOf,
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

// The scripted model answers by user text (n-th round of that text = n-th step), so every run of
// a case asks with its own text; the model's answer is the same for all of them.
const NORMAL_ASK = '帮我找合成保温杯';
const AFFECTED_ASK = '再帮我找一次合成保温杯';
const LATER_ASK = '还是帮我找合成保温杯';
const SEARCH_ARGS = { q: KEYWORD };

function searchSteps(): readonly Step[] {
  return [
    { text: LEAD, calls: [{ name: 'search_products', args: SEARCH_ARGS }] },
    { text: '好的。' },
  ];
}

function scripts(): Record<string, readonly Step[]> {
  return {
    [NORMAL_ASK]: searchSteps(),
    [AFFECTED_ASK]: searchSteps(),
    [LATER_ASK]: searchSteps(),
  };
}

it('[AC-B3-08q#5][BR-AI-19] 模型路径·trace 写者抛错：search_products 出卡的 run，写者的 recordToolCalls 与 recordCards 都被调用且都失败；帧序列与 finish stop 与正常 run 一致，run 不变成 error；只记一条 warn agent_trace_write_failed（带 run_id），无未处理的拒绝，之后的 run 照常落库', async () => {
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  const x = await productionRig(pg.db, { scripts: scripts() });
  try {
    // A normal run of the model path: card and tool call stored, no warn.
    const normalSession = await openSession(x.r, x.f.caller);
    const normal = await ask(x, x.f.caller, normalSession, NORMAL_ASK);
    expect(finishOf(normal)).toBe('stop');
    expect(cardTypesOf(normal)).toEqual(['product_list']);
    const normalRun = runIdOf(normal);
    await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId: normalSession, runId: normalRun },
      normal,
    );
    await toolCallsOnce(pg.db, normalRun, 1);
    expect(x.f.logs.of(TRACE_WARN)).toEqual([]);

    // The same model answer while every write rejects.
    x.writer.set('throw');
    const failingSession = await openSession(x.r, x.f.caller);
    const failing = await ask(x, x.f.caller, failingSession, AFFECTED_ASK);
    const runId = runIdOf(failing);
    expect(shapeOf(failing)).toEqual(shapeOf(normal));
    expect(finishOf(failing)).toBe('stop');

    const reached = await eventually(
      'the failing writer was asked for both the tool calls and the cards of this run',
      async () =>
        new Set(
          x.writer.calls
            .filter((call) => call.runId === runId && call.mode === 'throw')
            .map((call) => call.method),
        ),
      (methods) => methods.has('recordToolCalls') && methods.has('recordCards'),
    );
    expect([...reached].sort()).toEqual(['recordCards', 'recordToolCalls']);
    await eventually(
      'the trace warn line',
      async () => x.f.logs.of(TRACE_WARN),
      (lines) => lines.length > 0,
    );
    // Whatever else the failing trace would have logged or rejected has had its time.
    await pause(500);
    const lines = x.f.logs.of(TRACE_WARN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: LEVEL.warn, run_id: runId });
    expect(JSON.stringify(lines[0])).not.toContain(KEYWORD);
    for (const field of ['card', 'cards', 'data', 'args', 'items', 'user_text', 'text']) {
      expect(lines[0], field).not.toHaveProperty(field);
    }
    expect(unhandled, 'no unhandled rejection').toEqual([]);

    // The run itself ended as a normal stop; the failed writes left no rows behind.
    const row = await runRow(pg.db, runId);
    expect(row['finish_reason']).toBe('stop');
    expect(row['end_reason']).not.toBe('server_error');
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);
    expect(await toolCallRowsOf(pg.db, 'run_id', runId)).toEqual([]);

    // The runtime goes on: a later run with a working writer is stored as usual.
    x.writer.set('pass');
    const laterSession = await openSession(x.r, x.f.caller);
    const later = await ask(x, x.f.caller, laterSession, LATER_ASK);
    expect(shapeOf(later)).toEqual(shapeOf(normal));
    const laterRun = runIdOf(later);
    await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId: laterSession, runId: laterRun },
      later,
    );
    const laterCalls = await toolCallsOnce(pg.db, laterRun, 1);
    expect(laterCalls.map((call) => [call.seq, call.name, call.status])).toEqual([
      [1, 'search_products', 'ok'],
    ]);
    expect(x.f.logs.of(TRACE_WARN)).toHaveLength(1);
    expect(unhandled, 'no unhandled rejection').toEqual([]);
  } finally {
    process.off('unhandledRejection', onRejection);
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#5][BR-AI-19] 模型路径·trace 写者变慢（写入挂起）：search_products 出卡的 run，回复照常结束（done stop 不等写入完成），帧序列与正常 run 一致；写者的 recordToolCalls 与 recordCards 都在挂起中、此时该 run 无卡无调用行；放行后卡与调用（seq 1、search_products、ok、traceMask 参数）落库，不记 warn', async () => {
  const x = await productionRig(pg.db, { scripts: scripts() });
  let pending: Promise<unknown> | undefined;
  try {
    const normalSession = await openSession(x.r, x.f.caller);
    const normal = await ask(x, x.f.caller, normalSession, NORMAL_ASK);
    expect(finishOf(normal)).toBe('stop');
    const normalRun = runIdOf(normal);
    await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId: normalSession, runId: normalRun },
      normal,
    );
    // Both writes of the normal run are done before the writer is switched.
    await toolCallsOnce(pg.db, normalRun, 1);

    x.writer.set('hold');
    const heldSession = await openSession(x.r, x.f.caller);
    const reply: { frames?: Frame[] } = {};
    pending = ask(x, x.f.caller, heldSession, AFFECTED_ASK).then((frames) => {
      reply.frames = frames;
    });
    await until('the reply ended while the trace write is held', () => reply.frames !== undefined);
    const frames = reply.frames ?? [];
    expect(shapeOf(frames)).toEqual(shapeOf(normal));
    expect(finishOf(frames)).toBe('stop');
    const runId = runIdOf(frames);

    await eventually(
      'the held writer was asked for both the tool calls and the cards of this run',
      async () =>
        new Set(
          x.writer.calls
            .filter((call) => call.runId === runId && call.mode === 'hold')
            .map((call) => call.method),
        ),
      (methods) => methods.has('recordToolCalls') && methods.has('recordCards'),
    );
    expect(await cardRowsOf(pg.db, 'run_id', runId), 'no card written while held').toEqual([]);
    expect(await toolCallRowsOf(pg.db, 'run_id', runId), 'no call written while held').toEqual([]);

    x.writer.release();
    await expectCardsStored(pg.db, { appId: x.appId, sessionId: heldSession, runId }, frames);
    const calls = await toolCallsOnce(pg.db, runId, 1);
    expect(calls.map((call) => [call.seq, call.name, call.status, call.app_id])).toEqual([
      [1, 'search_products', 'ok', x.appId],
    ]);
    expect(calls[0]?.args).toEqual(x.r.runtime.traceMask(SEARCH_ARGS, {}));
    expect(x.f.logs.of(TRACE_WARN)).toEqual([]);
  } finally {
    x.writer.release();
    await pending?.catch(() => undefined);
    await x.r.runtime.close();
  }
}, 120_000);
