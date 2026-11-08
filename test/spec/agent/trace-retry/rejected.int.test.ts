// B3-08y · BR-AI-19 (24-hour local queue) with permanent errors from the real writer: the queue
// (stream/mount/trace-retry.ts createTraceRedoQueue) over agent/store/results
// createPgAgentTraceWriter on real PG, on manual time. Errors that writing again cannot cure — the
// writer's own checks (run not found in this app / session, invalid card_id) and SQLSTATE class
// 22 / 23 / 42 (here agent_cards_earnings_no_amount_check, 23514) — are lost at once (reason
// 'rejected') and never written again. Contract: ./kit.ts header.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createPgAgentTraceWriter } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import {
  createTraceRedoQueue,
  type RedoTraceWriter,
  type TraceLostReason,
} from '../../../../apps/api/src/modules/agent/stream/mount/trace-retry.ts';
import { insertRun, sessionOf } from '../stream-assembly-orders/kit.ts';
import { newMember, openAgent, usePgEach } from '../stream-mount/kit.ts';
import { cardRowsOf, toolCallRowsOf } from '../trace-persist/kit.ts';
import {
  HOUR,
  LOST,
  Lines,
  ManualTime,
  advanceTo,
  earningsCard,
  expectLost,
  notice,
  toolCall,
} from './kit.ts';
import { uuid } from './runtime-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** A member's real session with one finished run. */
async function realRun() {
  await openAgent(pg.db);
  const member = await newMember(pg.db);
  const sessionId = await sessionOf(pg.db, member);
  const runId = await insertRun(pg.db, sessionId);
  return { appId: member.appId, sessionId, runId };
}

/** The queue over the real writer, counting the writer's calls per method and run. */
function realQueue() {
  const time = new ManualTime();
  const logs = new Lines();
  const onLost = vi.fn<(reason: TraceLostReason) => void>();
  const real = createPgAgentTraceWriter({ db: pg.db, newId: uuid });
  const calls: { method: string; runId: string }[] = [];
  const writer: RedoTraceWriter = {
    recordCards(appId, sessionId, runId, cards) {
      calls.push({ method: 'recordCards', runId });
      return real.recordCards(appId, sessionId, runId, cards);
    },
    recordToolCalls(appId, runId, toolCalls) {
      calls.push({ method: 'recordToolCalls', runId });
      return real.recordToolCalls(appId, runId, toolCalls);
    },
  };
  const queue = createTraceRedoQueue({
    writer,
    clock: time.clock,
    scheduler: time.scheduler,
    logger: logs.logger,
    onLost,
  });
  function count(method: string, runId: string): number {
    return calls.filter((call) => call.method === method && call.runId === runId).length;
  }
  return { time, logs, onLost, queue, count };
}

it('[AC-B3-08y#3][BR-AI-19] 收益卡带金额（agent_cards_earnings_no_amount_check，SQLSTATE 23514）：不再写，立即记 lost（reason rejected），onLost(rejected)；工具调用一半照常落库', async () => {
  const run = await realRun();
  const q = realQueue();
  await q.queue.persist({ ...run, cards: [earningsCard('c1')], toolCalls: [toolCall(1)] });
  expectLost(q.logs.all(), { run_id: run.runId, reason: 'rejected', cards: 1, tool_calls: 0 });
  expect(q.onLost.mock.calls).toEqual([['rejected']]);
  expect(q.queue.queued()).toBe(0);

  await advanceTo(q.time, HOUR);
  expect(q.count('recordCards', run.runId)).toBe(1);
  expect(q.count('recordToolCalls', run.runId)).toBe(1);
  expect(await cardRowsOf(pg.db, 'run_id', run.runId)).toEqual([]);
  expect((await toolCallRowsOf(pg.db, 'run_id', run.runId)).map((row) => row.seq)).toEqual([1]);
  expect(q.logs.of(LOST)).toHaveLength(1);
}, 120_000);

it('[AC-B3-08y#3][BR-AI-19] run 不在本 app / 会话（写者自己的校验 run not found）：两路都不再写，立即记一条 lost（reason rejected，cards 与 tool_calls 计数）', async () => {
  const run = await realRun();
  const q = realQueue();
  const missing = uuid();
  await q.queue.persist({
    appId: run.appId,
    sessionId: run.sessionId,
    runId: missing,
    cards: [notice('c1'), notice('c2')],
    toolCalls: [toolCall(1), toolCall(2)],
  });
  expectLost(q.logs.all(), { run_id: missing, reason: 'rejected', cards: 2, tool_calls: 2 });
  expect(q.onLost).toHaveBeenCalledTimes(1);
  await advanceTo(q.time, HOUR);
  expect(q.count('recordCards', missing)).toBe(1);
  expect(q.count('recordToolCalls', missing)).toBe(1);
  expect(q.queue.queued()).toBe(0);
}, 120_000);

it('[AC-B3-08y#3][BR-AI-19] 卡号不合 c1, c2…（写者自己的校验 invalid card_id）：不再写，立即记 lost（reason rejected）；同一队列里正常的 run 照常落库、不记 lost', async () => {
  const run = await realRun();
  const other = await realRun();
  const q = realQueue();
  await q.queue.persist({ ...run, cards: [notice('x1')], toolCalls: [] });
  expectLost(q.logs.all(), { run_id: run.runId, reason: 'rejected', cards: 1, tool_calls: 0 });

  await q.queue.persist({ ...other, cards: [notice('c1')], toolCalls: [toolCall(1)] });
  await advanceTo(q.time, HOUR);
  expect(q.count('recordCards', run.runId)).toBe(1);
  expect((await cardRowsOf(pg.db, 'run_id', other.runId)).map((row) => row.card_id)).toEqual([
    'c1',
  ]);
  expect((await toolCallRowsOf(pg.db, 'run_id', other.runId)).map((row) => row.seq)).toEqual([1]);
  expect(q.logs.of(LOST)).toHaveLength(1);
  expect(q.onLost).toHaveBeenCalledTimes(1);
}, 120_000);
