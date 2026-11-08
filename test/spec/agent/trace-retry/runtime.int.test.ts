// B3-08y · BR-AI-19「TraceWriter 写入失败时进本地重试队列，最多重试 24 小时，仍失败记告警
// agent.trace_lost，不得静默丢弃」, through the production stream runtime of [AC-B3-08g] over real
// PG (./runtime-kit.ts traceRig; the real createPgAgentTraceWriter behind a switch). The runtime's
// queue runs on the fixture's ManualTime: the tests move it. Contract: ./kit.ts header.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, type Step } from '../core-reply-templates/kit.ts';
import { framesOf, message, openSession, send, until, usePgEach } from '../stream-mount/kit.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  KEYWORD,
  cardFramesOf,
  cardRowsOf,
  expectCardsStored,
  finishOf,
  runIdOf,
  shapeOf,
  toolCallRowsOf,
  type Frame,
} from '../trace-persist/kit.ts';
import { HOUR, LOST, SECOND, WRITE_FAILED, expectLost } from './kit.ts';
import { driveUntil, letTimePass, traceRig, type TraceRig } from './runtime-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** Search asks: one model round calling search_products, then a closing sentence. */
const ASKS = ['帮我找合成保温杯', '再帮我找合成保温杯', '还想看看合成保温杯'] as const;

function searchScripts(): Record<string, readonly Step[]> {
  const steps: readonly Step[] = [
    { text: LEAD, calls: [{ name: 'search_products', args: { q: KEYWORD } }] },
    { text: '好的。' },
  ];
  return Object.fromEntries(ASKS.map((text) => [text, steps]));
}

async function ask(x: TraceRig, caller: AgentCaller, sessionId: string, text: string) {
  return framesOf((await send(x.r, caller, sessionId, message(text))).chunks);
}

/** Waits (real time only) until the run's first write was refused and its warn line is there. */
async function firstFailure(x: TraceRig, runId: string): Promise<void> {
  await until(
    'the failing writer was reached for this run and warned',
    () =>
      x.writer.of(runId, 'throw').length > 0 &&
      x.logs.of(WRITE_FAILED).some((line) => line['run_id'] === runId),
  );
}

async function storedOnce(x: TraceRig, sessionId: string, frames: readonly Frame[]) {
  const runId = runIdOf(frames);
  const ids = cardFramesOf(frames).map((frame) => frame.data['card_id']);
  await driveUntil(
    x.time,
    `cards and the tool call of run ${runId} stored`,
    async () => ({
      cards: await cardRowsOf(pg.db, 'run_id', runId),
      calls: await toolCallRowsOf(pg.db, 'run_id', runId),
    }),
    (rows) =>
      ids.every((id) => rows.cards.some((row) => row.card_id === id)) && rows.calls.length >= 1,
  );
  await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
  const calls = await toolCallRowsOf(pg.db, 'run_id', runId);
  expect(calls.map((call) => [call.seq, call.name, call.status])).toEqual([
    [1, 'search_products', 'ok'],
  ]);
}

it('[AC-B3-08y#1][BR-AI-19] 写者先失败后恢复：该 run 进本地队列，约 1 秒后再写，卡片与工具调用各只落一次；全过程只一条 agent_trace_write_failed；帧序列与结局与正常写入时一致；不记 lost', async () => {
  const x = await traceRig(pg.db, { scripts: searchScripts() });
  try {
    const normalSession = await openSession(x.r, x.f.caller);
    const normal = await ask(x, x.f.caller, normalSession, ASKS[0]);
    expect(finishOf(normal)).toBe('stop');
    await storedOnce(x, normalSession, normal);

    x.writer.set('throw');
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, ASKS[1]);
    expect(shapeOf(frames)).toEqual(shapeOf(normal));
    expect(finishOf(frames)).toBe('stop');
    const runId = runIdOf(frames);
    await firstFailure(x, runId);
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);

    x.writer.set('pass');
    await storedOnce(x, sessionId, frames);
    expect(x.writer.of(runId, 'pass').length, 'written again by the queue').toBeGreaterThan(0);

    await letTimePass(x.time, HOUR);
    const rows = await cardRowsOf(pg.db, 'run_id', runId);
    for (const frame of cardFramesOf(frames)) {
      expect(rows.filter((row) => row.card_id === frame.data['card_id'])).toHaveLength(1);
    }
    expect(await toolCallRowsOf(pg.db, 'run_id', runId)).toHaveLength(1);
    expect(x.logs.of(WRITE_FAILED)).toHaveLength(1);
    expect(x.logs.of(LOST)).toEqual([]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08y#5][BR-AI-19] 停机时队列非空：runtime.close() 在 lockGraceMs 内返回，最后写一次，剩下的记一条 agent.trace_lost（reason shutdown，只带 run_id 与计数）；之后没有定时器再调写者', async () => {
  const x = await traceRig(pg.db, { scripts: searchScripts() });
  try {
    x.writer.set('throw');
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, ASKS[0]);
    const runId = runIdOf(frames);
    await firstFailure(x, runId);

    x.writer.set('hold');
    const before = x.writer.of(runId).length;
    const closing = x.r.runtime.close();
    const bound = x.time.t + x.r.runtime.timings.lockGraceMs;
    expect(await x.time.drive(closing, bound), 'close returns within lockGraceMs').toBe(true);
    expect(x.writer.of(runId, 'hold').length, 'one last attempt at close').toBeGreaterThan(0);
    expect(x.writer.of(runId).length).toBeGreaterThan(before);
    expectLost(x.logs.all(), {
      run_id: runId,
      reason: 'shutdown',
      cards: cardFramesOf(frames).length,
      tool_calls: 1,
    });

    const after = x.writer.of(runId).length;
    await letTimePass(x.time, HOUR);
    expect(x.writer.of(runId)).toHaveLength(after);
    expect(x.logs.of(LOST)).toHaveLength(1);
    expect(x.logs.of(WRITE_FAILED)).toHaveLength(1);
  } finally {
    x.writer.release();
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08y#8][BR-AI-19] 队列里的 run 正在再写（写者挂起）：新 run 的帧序列与结局与正常时一致、回复照常结束；放行后两个 run 的卡与工具调用都各落一次', async () => {
  const x = await traceRig(pg.db, { scripts: searchScripts() });
  let pending: Promise<unknown> | undefined;
  try {
    const normalSession = await openSession(x.r, x.f.caller);
    const normal = await ask(x, x.f.caller, normalSession, ASKS[0]);
    await storedOnce(x, normalSession, normal);

    x.writer.set('throw');
    const queuedSession = await openSession(x.r, x.f.caller);
    const queued = await ask(x, x.f.caller, queuedSession, ASKS[1]);
    const queuedRun = runIdOf(queued);
    await firstFailure(x, queuedRun);

    x.writer.set('hold');
    await driveUntil(
      x.time,
      'the queued run is being written again (held)',
      async () => x.writer.of(queuedRun, 'hold'),
      (calls) => calls.length > 0,
      { stepMs: 250, spanMs: 10 * SECOND },
    );

    const freshSession = await openSession(x.r, x.f.caller);
    const reply: { frames?: Frame[] } = {};
    pending = ask(x, x.f.caller, freshSession, ASKS[2]).then((frames) => {
      reply.frames = frames;
    });
    await until(
      'the new reply ended while the queued write is held',
      () => reply.frames !== undefined,
    );
    const fresh = reply.frames ?? [];
    expect(shapeOf(fresh)).toEqual(shapeOf(normal));
    expect(finishOf(fresh)).toBe('stop');

    x.writer.set('pass');
    x.writer.release();
    await storedOnce(x, queuedSession, queued);
    await storedOnce(x, freshSession, fresh);
    expect(x.logs.of(WRITE_FAILED)).toHaveLength(1);
    expect(x.logs.of(LOST)).toEqual([]);
  } finally {
    x.writer.release();
    await pending?.catch(() => undefined);
    await x.r.runtime.close();
  }
}, 120_000);
