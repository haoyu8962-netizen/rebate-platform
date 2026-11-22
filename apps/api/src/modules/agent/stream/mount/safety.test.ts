// B3-06c unit tests (implementer's own, D10-2498): reviewSettings fixes the review's one deadline at
// its start (before any read), so time spent reading timeout_ms or the block level never moves it.
// Synthetic scheduler and configuration reader only; no network, no database.
import { expect, it } from 'vitest';
import type { Scheduler } from '../../../platform/index.ts';
import { reviewSettings, type StreamReviewConfigReader } from './safety.ts';

/** A scheduler whose clock is set by the test; sleeps settle only on abort (never by time). */
function heldScheduler(start: number) {
  const clock = { now: start };
  const scheduler: Scheduler = {
    now: () => clock.now,
    sleep: (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  return { scheduler, clock };
}

/** A reader whose answer per key is released by the test. */
function heldReader() {
  const pending = new Map<string, (value: unknown) => void>();
  const reader: StreamReviewConfigReader = {
    configValue: (_appId, key) =>
      new Promise((resolve) => {
        pending.set(key, (value) => {
          resolve({ value });
        });
      }),
  };
  const release = async (key: string, value: unknown) => {
    for (let i = 0; i < 20 && !pending.has(key); i += 1) await Promise.resolve();
    const answer = pending.get(key);
    if (answer === undefined) throw new Error(`no read of ${key}`);
    answer(value);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return { reader, release };
}

it('[AC-B3-06c#u4][BR-AI-18] 截止时间从审核开始（任何读取之前）起算：读 timeout_ms 与读等级用掉的时间都从同一时限里扣', async () => {
  const time = heldScheduler(1000);
  const config = heldReader();
  const settings = reviewSettings(
    config.reader,
    time.scheduler,
    'synthetic-app',
    'input',
    new AbortController().signal,
    1000,
  );
  time.clock.now = 1050; // timeout_ms answers 50 ms after the start
  await config.release('agent.safety.timeout_ms', 300);
  time.clock.now = 1200; // the level answers 200 ms after the start
  await config.release('agent.safety.block_level.input', 'medium');
  await expect(settings).resolves.toEqual({ kind: 'ready', left: 100, level: 'medium' });
});

it('[AC-B3-06c#u5][BR-AI-18] 等级在「开始 + timeout_ms」之后才读回：不放行（审核不可用），不按读回时刻重算截止', async () => {
  const time = heldScheduler(0);
  const config = heldReader();
  const settings = reviewSettings(
    config.reader,
    time.scheduler,
    'synthetic-app',
    'output',
    new AbortController().signal,
    1000,
  );
  time.clock.now = 40;
  await config.release('agent.safety.timeout_ms', 300);
  time.clock.now = 310;
  await config.release('agent.safety.block_level.output', 'low');
  const result = await settings;
  expect(result.kind).not.toBe('ready');
});

it('[AC-B3-06c#u6][BR-AI-18] timeout_ms 本身读得比它的值还慢：开始时刻已固定，直接按审核不可用', async () => {
  const time = heldScheduler(500);
  const config = heldReader();
  const settings = reviewSettings(
    config.reader,
    time.scheduler,
    'synthetic-app',
    'input',
    new AbortController().signal,
    1000,
  );
  time.clock.now = 830; // 330 ms after the start, past a 300 ms deadline
  await config.release('agent.safety.timeout_ms', 300);
  await expect(settings).resolves.toEqual({ kind: 'expired' });
});

it('[AC-B3-06c#u7][BR-AI-18] 发起读等级的同步阶段本身耗时 50ms：截止仍从发起前的开始时刻起算，等级在两种起点之间读回按审核不可用', async () => {
  const time = heldScheduler(1000);
  const config = heldReader();
  // Starting the level read stalls the caller for 50 ms before it hands back its pending answer.
  const stalling: StreamReviewConfigReader = {
    configValue: (appId, key) => {
      if (key === 'agent.safety.block_level.input') time.clock.now += 50;
      return config.reader.configValue(appId, key);
    },
  };
  const settings = reviewSettings(
    stalling,
    time.scheduler,
    'synthetic-app',
    'input',
    new AbortController().signal,
    1000,
  );
  expect(time.clock.now).toBe(1050);
  await config.release('agent.safety.timeout_ms', 300); // answers at once (still 1050)
  // Deadline from the review's start: 1000 + 300 = 1300. Counted from after the stalled call it
  // would be 1050 + 300 = 1350; the level answers in between.
  time.clock.now = 1320;
  await config.release('agent.safety.block_level.input', 'low');
  await expect(settings).resolves.toEqual({ kind: 'expired' });
});
