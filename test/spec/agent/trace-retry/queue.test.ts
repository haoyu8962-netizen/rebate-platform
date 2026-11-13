// B3-08y · BR-AI-19「TraceWriter 写入失败时进本地重试队列，最多重试 24 小时，仍失败记告警
// agent.trace_lost，不得静默丢弃」: the queue itself (stream/mount/trace-retry.ts
// createTraceRedoQueue) over a scripted writer, on manual time (one Clock and one Scheduler moved
// together). Contract: ./kit.ts header. No database, no listening, no network.
import { expect, it } from 'vitest';
import { traceRedoDefaults } from '../../../../apps/api/src/modules/agent/stream/mount/trace-retry.ts';
import {
  DAY,
  DEFAULTS,
  HOUR,
  LEVEL,
  LOST,
  MINUTE,
  SECOND,
  SKIPPED,
  WRITE_FAILED,
  advanceTo,
  expectLost,
  orderCard,
  pgError,
  queueRig,
  record,
  settle,
} from './kit.ts';

function callsOf(q: ReturnType<typeof queueRig>, runId: string) {
  return q.w.calls.filter((call) => call.runId === runId);
}

// ── createTraceRedoQueue · 失败后再写 ──
it('[AC-B3-08y#1][BR-AI-19] 卡片一半写入失败、工具调用一半成功：run 进队，1 秒后（不早于）只再写卡片一半，写成后出队；全过程只一条 warn agent_trace_write_failed（run_id、error_name），无 lost', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.setTools('pass');
  q.w.setCards('fail');
  const run = record();
  await queue.persist(run);

  expect(q.w.writtenOf('recordToolCalls', run.runId)).toHaveLength(1);
  expect(q.w.of('recordCards', run.runId)).toHaveLength(1);
  expect(queue.queued()).toBe(1);
  expect(q.logs.of(WRITE_FAILED)).toHaveLength(1);

  q.w.setCards('pass');
  await q.time.to(999);
  expect(q.w.of('recordCards', run.runId), 'not before 1 s').toHaveLength(1);
  await q.time.to(SECOND);
  await settle();
  expect(q.w.of('recordCards', run.runId).map((call) => [call.at, call.count])).toEqual([
    [0, 2],
    [SECOND, 2],
  ]);
  expect(q.w.writtenOf('recordCards', run.runId)).toHaveLength(1);
  expect(
    q.w.of('recordToolCalls', run.runId),
    'the written half is not written again',
  ).toHaveLength(1);
  expect(queue.queued()).toBe(0);

  await advanceTo(q.time, HOUR);
  expect(callsOf(q, run.runId)).toHaveLength(3);
  const warns = q.logs.of(WRITE_FAILED);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatchObject({ level: LEVEL.warn, run_id: run.runId, error_name: 'Error' });
  expect(q.logs.of(LOST)).toEqual([]);
  expect(q.onLost).not.toHaveBeenCalled();
});

it('[AC-B3-08y#1][BR-AI-19] 两路都失败（工具调用一路同步抛错）：persist 不抛、照常返回；恢复后两路各写成一次；只一条 warn；之后不再调写者', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.setTools('sync');
  q.w.setCards('fail');
  const run = record();
  await expect(queue.persist(run)).resolves.toBeUndefined();
  expect(queue.queued()).toBe(1);

  q.w.set('pass');
  await advanceTo(q.time, 10 * SECOND, SECOND);
  expect(q.w.writtenOf('recordCards', run.runId)).toHaveLength(1);
  expect(q.w.writtenOf('recordToolCalls', run.runId)).toHaveLength(1);
  expect(q.w.of('recordCards', run.runId).map((call) => call.at)).toEqual([0, SECOND]);
  expect(q.w.of('recordToolCalls', run.runId).map((call) => call.at)).toEqual([0, SECOND]);
  await advanceTo(q.time, HOUR);
  expect(callsOf(q, run.runId)).toHaveLength(4);
  expect(q.logs.of(WRITE_FAILED)).toHaveLength(1);
  expect(q.logs.of(LOST)).toEqual([]);
  expect(queue.queued()).toBe(0);
});

it('[AC-B3-08y#1][BR-AI-19] 写入正常：每路只写一次，不进队，不记 warn / lost', async () => {
  const q = queueRig();
  const queue = q.build();
  const run = record();
  await queue.persist(run);
  expect(q.w.writtenOf('recordCards', run.runId)).toHaveLength(1);
  expect(q.w.writtenOf('recordToolCalls', run.runId)).toHaveLength(1);
  expect(queue.queued()).toBe(0);
  await advanceTo(q.time, HOUR);
  expect(callsOf(q, run.runId)).toHaveLength(2);
  expect(q.logs.of(WRITE_FAILED)).toEqual([]);
  expect(q.logs.of(LOST)).toEqual([]);
});

// ── createTraceRedoQueue · 退避与 24 小时截止 ──
it('[AC-B3-08y#2][BR-AI-19] 写者一直失败：退避 1s→2s→4s… 封顶 5 分钟，同一 run 两路同一节奏；截止前不记 lost；24h 后恰好一条 agent.trace_lost（reason expired，只带 run_id 与计数）、onLost 一次；之后不再调写者', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  const run = record();
  await queue.persist(run);

  await advanceTo(q.time, DAY - 300_001);
  expect(q.logs.of(LOST), 'no lost before the window ends').toEqual([]);
  const times = q.w.of('recordCards', run.runId).map((call) => call.at);
  const gaps = times.slice(1).map((at, index) => at - (times[index] ?? 0));
  expect(gaps.slice(0, 11)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
  ]);
  expect(gaps.slice(9).every((gap) => gap === 300_000)).toBe(true);
  expect(q.w.of('recordToolCalls', run.runId).map((call) => call.at)).toEqual(times);

  await advanceTo(q.time, DAY + 301_000);
  expectLost(q.logs.all(), { run_id: run.runId, reason: 'expired', cards: 2, tool_calls: 1 });
  expect(q.onLost).toHaveBeenCalledTimes(1);
  expect(q.onLost).toHaveBeenCalledWith('expired');
  const all = callsOf(q, run.runId);
  const last = Math.max(...all.map((call) => call.at));
  expect(last, 'written again until the window ends').toBeGreaterThanOrEqual(DAY - 300_000);
  expect(last, 'never after the window').toBeLessThanOrEqual(DAY);
  expect(queue.queued()).toBe(0);
  expect('pendingCard' in queue).toBe(false);

  await advanceTo(q.time, 2 * DAY + HOUR, 10 * MINUTE);
  expect(callsOf(q, run.runId)).toHaveLength(all.length);
  expect(q.logs.of(LOST)).toHaveLength(1);
  expect(q.onLost).toHaveBeenCalledTimes(1);
  // Only the first failure warns; the later ones are debug lines.
  expect(q.logs.atLevel(LEVEL.warn)).toHaveLength(1);
  expect(q.logs.atLevel(LEVEL.error)).toHaveLength(1);
});

it('[AC-B3-08y#2][BR-AI-19] 截止从该 run 首次失败起算：两个 run 先后失败，各自在自己的 24h 到期时记 lost', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  const early = record({ sessionId: '0192f3a1-7c00-7000-8000-0000000a0101' });
  await queue.persist(early);
  await advanceTo(q.time, 6 * HOUR);
  const late = record({ sessionId: '0192f3a1-7c00-7000-8000-0000000a0102' });
  await queue.persist(late);

  await advanceTo(q.time, DAY + 301_000);
  expectLost(q.logs.of(LOST), {
    run_id: early.runId,
    reason: 'expired',
    cards: 2,
    tool_calls: 1,
  });
  expect(q.logs.of(LOST).filter((line) => line['run_id'] === late.runId)).toEqual([]);
  expect(queue.queued()).toBe(1);

  await advanceTo(q.time, 6 * HOUR + DAY + 301_000);
  expectLost(q.logs.of(LOST), { run_id: late.runId, reason: 'expired', cards: 2, tool_calls: 1 });
  expect(queue.queued()).toBe(0);
  expect(q.onLost.mock.calls).toEqual([['expired'], ['expired']]);
});

it('[AC-B3-08y#2] traceRedoDefaults()：队列上限 5000 个 run、退避 1 秒起翻倍、上限 5 分钟、截止 24 小时', () => {
  expect(traceRedoDefaults()).toEqual(DEFAULTS);
  expect(traceRedoDefaults()).not.toBe(traceRedoDefaults());
});

// ── createTraceRedoQueue · 永久性错误 ──
it('[AC-B3-08y#3][BR-AI-19] SQLSTATE 22 / 23 / 42 类（如 23514 CHECK）：不再写，立即记 lost（reason rejected，已写成的一半计 0），onLost(rejected)', async () => {
  for (const code of ['22P02', '22001', '23514', '23505', '42703', '42501']) {
    const q = queueRig();
    const queue = q.build();
    q.w.setTools('pass');
    q.w.setCards(pgError(code));
    const run = record();
    await queue.persist(run);
    expectLost(q.logs.all(), { run_id: run.runId, reason: 'rejected', cards: 2, tool_calls: 0 });
    expect(q.onLost.mock.calls, code).toEqual([['rejected']]);
    expect(queue.queued(), code).toBe(0);
    expect('pendingCard' in queue, code).toBe(false);
    q.w.set('pass');
    await advanceTo(q.time, HOUR);
    expect(q.w.of('recordCards', run.runId), code).toHaveLength(1);
    expect(q.logs.of(LOST), code).toHaveLength(1);
    expect(q.logs.of(WRITE_FAILED).length, code).toBeLessThanOrEqual(1);
  }
});

it('[AC-B3-08y#3][BR-AI-19] 工具调用一路永久失败、卡片一路成功：lost 计 cards 0、tool_calls 为该 run 的调用数', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.setTools(pgError('23514'));
  const run = record();
  await queue.persist(run);
  expectLost(q.logs.all(), { run_id: run.runId, reason: 'rejected', cards: 0, tool_calls: 1 });
  await advanceTo(q.time, HOUR);
  expect(callsOf(q, run.runId)).toHaveLength(2);
});

it('[AC-B3-08y#3][BR-AI-19] 其余错误（连接断开 08、并发 40、停机 57、资源 53、不带 SQLSTATE 的错误）都是暂时性的：进队、1 秒后再写，不记 lost', async () => {
  for (const failure of [
    pgError('08006'),
    pgError('40001'),
    pgError('57P01'),
    pgError('53300'),
    new Error('合成连接超时'),
  ]) {
    const q = queueRig();
    const queue = q.build();
    q.w.set(failure);
    const run = record();
    await queue.persist(run);
    const what = failure.message;
    expect(queue.queued(), what).toBe(1);
    expect(q.logs.of(LOST), what).toEqual([]);
    q.w.set('pass');
    await advanceTo(q.time, 5 * SECOND, SECOND);
    expect(q.w.writtenOf('recordCards', run.runId), what).toHaveLength(1);
    expect(q.w.writtenOf('recordToolCalls', run.runId), what).toHaveLength(1);
    expect(q.logs.of(LOST), what).toEqual([]);
    expect(q.onLost, what).not.toHaveBeenCalled();
  }
});

// ── createTraceRedoQueue · 队列上限 ──
it('[AC-B3-08y#4][BR-AI-19] 队列满（上限 2）：再进一个 run 时丢最旧的一项并记 lost（reason overflow），新的照常进队；恢复后只写留下的两个', async () => {
  const q = queueRig({ params: { ...DEFAULTS, maxRuns: 2 } });
  const queue = q.build();
  q.w.set('fail');
  const oldest = record({ sessionId: '0192f3a1-7c00-7000-8000-0000000a0201' });
  const second = record({ sessionId: '0192f3a1-7c00-7000-8000-0000000a0202' });
  const third = record({ sessionId: '0192f3a1-7c00-7000-8000-0000000a0203' });
  for (const run of [oldest, second, third]) await queue.persist(run);

  expectLost(q.logs.of(LOST), {
    run_id: oldest.runId,
    reason: 'overflow',
    cards: 2,
    tool_calls: 1,
  });
  expect(q.logs.of(LOST)).toHaveLength(1);
  expect(q.onLost.mock.calls).toEqual([['overflow']]);
  expect(queue.queued()).toBe(2);
  expect('pendingCard' in queue).toBe(false);
  expect('pendingCard' in queue).toBe(false);

  q.w.set('pass');
  await advanceTo(q.time, 10 * SECOND, SECOND);
  for (const run of [second, third]) {
    expect(q.w.writtenOf('recordCards', run.runId)).toHaveLength(1);
    expect(q.w.writtenOf('recordToolCalls', run.runId)).toHaveLength(1);
  }
  expect(callsOf(q, oldest.runId), 'the dropped run is never written again').toHaveLength(2);
  expect(queue.queued()).toBe(0);
  expect(q.logs.of(LOST)).toHaveLength(1);
});

it('[AC-B3-08y#4][BR-AI-19] 默认上限 5000：第 5001 个失败的 run 进队时只丢最早的一个', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  const first = record({ sessionId: '0192f3a1-7c00-7000-8000-0000000a0301' });
  await queue.persist(first);
  expect(queue.queued()).toBe(1);
  for (let i = 1; i < 5_000; i += 1) await queue.persist(record({ cards: [orderCard('c1')] }));
  expect(queue.queued()).toBe(5_000);
  expect(q.logs.of(LOST)).toEqual([]);
  await queue.persist(record({ cards: [orderCard('c1')] }));
  expect(queue.queued()).toBe(5_000);
  const lost = q.logs.of(LOST);
  expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({ run_id: first.runId, reason: 'overflow' });
});

// ── createTraceRedoQueue · 停机 ──
it('[AC-B3-08y#5][BR-AI-19] close 时队列非空、写者挂起：立刻做最后一次写入，在时限内返回，剩下的记 lost（reason shutdown）；之后没有定时器再调写者', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  const run = record();
  await queue.persist(run);
  await q.time.to(500);
  q.w.set('hold');
  const before = callsOf(q, run.runId).length;
  const start = q.time.t;
  const closing = queue.close(5_000);
  expect(await q.time.drive(closing, start + 5_000), 'close returns within its bound').toBe(true);
  expect(q.time.t).toBeLessThanOrEqual(start + 5_000);
  const last = q.w.of('recordCards', run.runId).at(-1);
  expect(callsOf(q, run.runId).length, 'one last attempt').toBeGreaterThan(before);
  expect(last?.at, 'the last attempt is made at once').toBe(start);
  expectLost(q.logs.all(), { run_id: run.runId, reason: 'shutdown', cards: 2, tool_calls: 1 });
  expect(q.onLost.mock.calls).toEqual([['shutdown']]);
  expect(queue.queued()).toBe(0);

  const after = callsOf(q, run.runId).length;
  await advanceTo(q.time, start + DAY + HOUR, 10 * MINUTE);
  expect(callsOf(q, run.runId)).toHaveLength(after);
  expect(q.logs.of(LOST)).toHaveLength(1);
  q.w.release();
});

it('[AC-B3-08y#5][BR-AI-19] close 时写者已恢复：最后一次写入写成，不记 lost，close 不等时钟即返回', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  const run = record();
  await queue.persist(run);
  q.w.set('pass');
  const closing = queue.close(5_000);
  expect(await q.time.drive(closing, q.time.t)).toBe(true);
  expect(q.w.writtenOf('recordCards', run.runId)).toHaveLength(1);
  expect(q.w.writtenOf('recordToolCalls', run.runId)).toHaveLength(1);
  expect(q.logs.of(LOST)).toEqual([]);
  await advanceTo(q.time, HOUR);
  expect(callsOf(q, run.runId)).toHaveLength(4);
});

it('[AC-B3-08y#5][BR-AI-19] close 时最后一次写入仍失败：记 shutdown lost，close 不等时钟即返回；warn 仍只一条', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  const run = record();
  await queue.persist(run);
  const closing = queue.close(5_000);
  expect(await q.time.drive(closing, q.time.t)).toBe(true);
  expect(callsOf(q, run.runId).length).toBeGreaterThan(2);
  expectLost(q.logs.all(), { run_id: run.runId, reason: 'shutdown', cards: 2, tool_calls: 1 });
  expect(q.logs.of(WRITE_FAILED)).toHaveLength(1);
});

it('[AC-B3-08y#5][BR-AI-19] close 时首次写入还挂着（未进队）：在时限内等它，等不到记 shutdown lost；队列空时 close 立即返回', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('hold');
  const run = record();
  void queue.persist(run);
  await settle();
  expect(callsOf(q, run.runId)).toHaveLength(2);
  const start = q.time.t;
  const closing = queue.close(5_000);
  expect(await q.time.drive(closing, start + 5_000)).toBe(true);
  expectLost(q.logs.all(), { run_id: run.runId, reason: 'shutdown', cards: 2, tool_calls: 1 });
  q.w.release();

  const idle = queueRig();
  const empty = idle.build();
  expect(await idle.time.drive(empty.close(5_000), 0), 'nothing queued: at once').toBe(true);
});

// ── createTraceRedoQueue · 会话已脱离用户（BR-AI-22） ──
it('[AC-B3-08y#6][BR-AI-22] 首次写入即 skipped：不 warn、不进队、不记 lost，一条 info agent_trace_skipped_erased（run_id）', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('skip');
  const run = record();
  await queue.persist(run);
  expect(queue.queued()).toBe(0);
  const lines = q.logs.of(SKIPPED);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ level: LEVEL.info, run_id: run.runId });
  expect(JSON.stringify(lines[0])).not.toContain('合成');
  await advanceTo(q.time, HOUR);
  expect(callsOf(q, run.runId)).toHaveLength(2);
  expect(q.logs.of(WRITE_FAILED)).toEqual([]);
  expect(q.logs.of(LOST)).toEqual([]);
  expect(q.onLost).not.toHaveBeenCalled();
});

it('[AC-B3-08y#6][BR-AI-22] 首次失败进队、再写时写者答 skipped（期间完成了注销）：出队，不再写，不记 lost，一条 info', async () => {
  const q = queueRig();
  const queue = q.build();
  q.w.set('fail');
  const run = record();
  await queue.persist(run);
  q.w.set('skip');
  await advanceTo(q.time, 5 * SECOND, SECOND);
  expect(callsOf(q, run.runId)).toHaveLength(4);
  expect(queue.queued()).toBe(0);
  expect('pendingCard' in queue).toBe(false);
  expect(q.logs.of(SKIPPED)).toHaveLength(1);
  await advanceTo(q.time, DAY + HOUR, 10 * MINUTE);
  expect(callsOf(q, run.runId)).toHaveLength(4);
  expect(q.logs.of(LOST)).toEqual([]);
  expect(q.onLost).not.toHaveBeenCalled();
  expect(q.logs.of(WRITE_FAILED)).toHaveLength(1);
});

it('[AC-B3-08zh#1][BR-AI-19] 队列不再提供 pendingCard：卡片随终态同事务写，没有进程内待写卡片', () => {
  const q = queueRig();
  const queue = q.build();
  expect('pendingCard' in queue).toBe(false);
});
