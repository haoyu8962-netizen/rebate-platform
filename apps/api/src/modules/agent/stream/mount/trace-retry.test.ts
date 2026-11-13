// B3-08y review S1 (BR-AI-19「最多重试 24 小时」): the deadline is read from the injected Clock before
// every write again. The clock and the scheduler are driven apart here, so a timer can fire after
// the deadline (as a real event loop lets it, a few ms late).
import { describe, expect, it, vi } from 'vitest';
import type { Clock, Scheduler } from '../../../platform/index.ts';
import type { CardInput } from '../writer/index.ts';
import {
  TRACE_LOST,
  createTraceRedoQueue,
  type RedoTraceWriter,
  type RunTraceRecord,
  type TraceLostReason,
} from './trace-retry.ts';

const START = 1_790_000_000_000;

/** A clock set by hand and a scheduler whose sleeps are woken by hand. */
function handTime() {
  let ms = START;
  const sleeps: { ms: number; at: number; wake: () => void; signal?: AbortSignal }[] = [];
  const clock: Clock = { now: () => new Date(ms) };
  const scheduler: Scheduler = {
    now: () => ms - START,
    sleep: (wait, signal) =>
      new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        const entry = {
          ms: wait,
          at: ms - START,
          wake: () => {
            sleeps.splice(sleeps.indexOf(entry), 1);
            resolve();
          },
          ...(signal === undefined ? {} : { signal }),
        };
        sleeps.push(entry);
      }),
  };
  return {
    clock,
    scheduler,
    sleeps,
    set(t: number): void {
      ms = START + t;
    },
    /** Wakes the latest live sleep (the queue's write-again timer). */
    wakeLast(): void {
      const live = sleeps.filter((sleep) => sleep.signal?.aborted !== true);
      live.at(-1)?.wake();
    },
    /** The live sleeps as [requested at, ms]. */
    live(): [number, number][] {
      return sleeps
        .filter((sleep) => sleep.signal?.aborted !== true)
        .map((sleep) => [sleep.at, sleep.ms]);
    },
    /** Wakes the live sleep requested at `at` for `wait` ms. */
    wake(at: number, wait: number): void {
      const found = sleeps.find(
        (sleep) => sleep.signal?.aborted !== true && sleep.at === at && sleep.ms === wait,
      );
      expect(found, `a live sleep of ${String(wait)} ms from t=${String(at)}`).toBeDefined();
      found?.wake();
    },
  };
}

function flushed(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function card(): CardInput {
  return {
    card_id: 'c1',
    type: 'order_status',
    schema_version: 1,
    data: { order_id: 'synthetic-order' },
    fallback_text: '合成',
  };
}

function record(): RunTraceRecord {
  return {
    appId: 'synthetic-app',
    sessionId: '0192f3a1-7c00-7000-8000-00000000a001',
    runId: '0192f3a1-7c00-7000-8000-00000000b001',
    cards: [card()],
    toolCalls: [],
  };
}

function rig(options: { readonly toolCalls?: boolean } = {}) {
  const time = handTime();
  let failing = true;
  let hold: Promise<void> | undefined;
  const recordCards = vi.fn<RedoTraceWriter['recordCards']>(async () => {
    const held = hold;
    if (held !== undefined) await held;
    if (failing) throw new Error('合成写入失败');
  });
  const recordToolCalls = vi.fn<RedoTraceWriter['recordToolCalls']>(async () => {
    throw new Error('合成连接断开');
  });
  const writer: RedoTraceWriter = { recordCards, recordToolCalls };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onLost = vi.fn<(reason: TraceLostReason) => void>();
  const queue = createTraceRedoQueue({
    writer,
    clock: time.clock,
    scheduler: time.scheduler,
    logger,
    onLost,
    params: { maxRuns: 10, firstDelayMs: 1_000, maxDelayMs: 1_000, windowMs: 1_500 },
  });
  const run: RunTraceRecord =
    options.toolCalls === true
      ? {
          ...record(),
          toolCalls: [
            {
              seq: 1,
              name: 'search_products',
              args: null,
              result_digest: null,
              status: 'ok',
              latency_ms: null,
            },
          ],
        }
      : record();
  return {
    time,
    queue,
    run,
    recordCards,
    recordToolCalls,
    logger,
    onLost,
    recover(): void {
      failing = false;
    },
    /** Card writes from now on wait for the returned release. */
    holdCards(): () => void {
      let open!: () => void;
      hold = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        hold = undefined;
        open();
      };
    },
  };
}

/** First failure at t = 0, a failed write again at t = 1000; the next timer waits the last 500 ms. */
async function nearDeadline(r: ReturnType<typeof rig>) {
  await r.queue.persist(r.run);
  expect(r.time.live(), 'the deadline timer and the first wait').toEqual([
    [0, 1_500],
    [0, 1_000],
  ]);
  r.time.set(1_000);
  r.time.wakeLast();
  await flushed();
  expect(r.recordCards).toHaveBeenCalledTimes(2);
  expect(r.time.sleeps.at(-1)?.ms, 'the last wait ends on the deadline').toBe(500);
}

function expectExpired(r: ReturnType<typeof rig>, toolCalls = 0): void {
  const lost = r.logger.error.mock.calls.filter((call) => call[1] === TRACE_LOST);
  expect(lost).toHaveLength(1);
  expect(lost[0]?.[0]).toMatchObject({ reason: 'expired', cards: 1, tool_calls: toolCalls });
  expect(r.onLost.mock.calls).toEqual([['expired']]);
  expect(r.queue.queued()).toBe(0);
  expect('pendingCard' in r.queue).toBe(false);
}

describe('createTraceRedoQueue · 截止口径（B3-08y review S1）', () => {
  it('[AC-B3-08y#2][BR-AI-19] 定时器在截止后数毫秒才触发、数据库已恢复：不再调用写者，记一条 expired lost', async () => {
    const r = rig();
    await nearDeadline(r);
    r.recover();
    r.time.set(1_503);
    r.time.wakeLast();
    await flushed();
    expect(r.recordCards).toHaveBeenCalledTimes(2);
    expectExpired(r);
  });

  it('[AC-B3-08y#2][BR-AI-19] 定时器恰好在截止时刻触发：等于截止算过期，不写，记 expired', async () => {
    const r = rig();
    await nearDeadline(r);
    r.recover();
    r.time.set(1_500);
    r.time.wakeLast();
    await flushed();
    expect(r.recordCards).toHaveBeenCalledTimes(2);
    expectExpired(r);
  });

  it('[AC-B3-08y#2][BR-AI-19] 截止前 1 毫秒触发仍照常再写', async () => {
    const r = rig();
    await nearDeadline(r);
    r.recover();
    r.time.set(1_499);
    r.time.wakeLast();
    await flushed();
    expect(r.recordCards).toHaveBeenCalledTimes(3);
    expect(r.logger.error).not.toHaveBeenCalled();
    expect(r.queue.queued()).toBe(0);
  });

  it('[AC-B3-08y#5][BR-AI-19] close 时某项已过截止（定时器未触发）：不做最后一写，记 expired 而非 shutdown', async () => {
    const r = rig();
    await nearDeadline(r);
    r.recover();
    r.time.set(1_600);
    await r.queue.close(5_000);
    expect(r.recordCards).toHaveBeenCalledTimes(2);
    expectExpired(r);
  });

  it('[AC-B3-08y#5][BR-AI-19] close 时截止未到：照常最后写一次，写成不记 lost', async () => {
    const r = rig();
    await nearDeadline(r);
    r.recover();
    r.time.set(1_200);
    await r.queue.close(5_000);
    expect(r.recordCards).toHaveBeenCalledTimes(3);
    expect(r.logger.error).not.toHaveBeenCalled();
  });

  it('[AC-B3-08y#2][BR-AI-19] 截止从任一半第一次失败那一刻起算：工具调用 t=0 失败、卡片写入挂到 t=600 才失败，截止仍是 t=0 + 窗口，准点记 expired', async () => {
    const r = rig({ toolCalls: true });
    const release = r.holdCards();
    const persisted = r.queue.persist(r.run);
    await flushed();
    expect(r.time.live(), 'the deadline timer starts with the failed half').toEqual([[0, 1_500]]);
    r.time.set(600);
    release();
    await persisted;
    expect(r.time.live()).toEqual([
      [0, 1_500],
      [600, 900],
    ]);
    r.time.set(1_500);
    r.time.wake(0, 1_500);
    await flushed();
    expectExpired(r, 1);
    expect(r.time.live(), 'no timer left').toEqual([]);
  });

  it('[AC-B3-08y#2][BR-AI-19] 到截止时再写还挂着：准点记一条 expired、onLost 一次；写入随后成功也不改记、不再记 lost', async () => {
    const r = rig();
    await r.queue.persist(r.run);
    r.recover();
    const release = r.holdCards();
    r.time.set(1_000);
    r.time.wake(0, 1_000);
    await flushed();
    expect(r.recordCards, 'the write again is in flight').toHaveBeenCalledTimes(2);
    r.time.set(1_500);
    r.time.wake(0, 1_500);
    await flushed();
    expectExpired(r);
    release();
    await flushed();
    await flushed();
    expect(r.logger.error).toHaveBeenCalledTimes(1);
    expect(r.onLost).toHaveBeenCalledTimes(1);
    expect(r.logger.debug.mock.calls.map((call) => call[1])).toContain(
      'agent_trace_result_after_lost',
    );
    expect(r.recordCards).toHaveBeenCalledTimes(2);
    expect(r.time.live()).toEqual([]);
  });

  it('[AC-B3-08y#5][BR-AI-19] close 清掉截止定时器：最后一写写成后不再有定时器、不记 lost', async () => {
    const r = rig();
    await r.queue.persist(r.run);
    r.recover();
    await r.queue.close(5_000);
    expect(r.time.live().filter(([, wait]) => wait !== 5_000)).toEqual([]);
    expect(r.logger.error).not.toHaveBeenCalled();
  });
});
