import { expect, it, vi } from 'vitest';
import {
  cacheChannelMismatchCollector,
  cacheSettleBillMismatchCollector,
  type ChannelMismatchSnapshot,
  type SettleBillMismatchSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { TTL_MS, movingClock } from './kit.ts';

const OPEN_FIRST: ChannelMismatchSnapshot = { open: { alpha: 2 } };
const OPEN_NEXT: ChannelMismatchSnapshot = { open: {} };
const BILL_FIRST: SettleBillMismatchSnapshot = {
  bills: { alpha: { amountMismatch: 3, generatedAtSeconds: 1_767_225_600 } },
};
const BILL_NEXT: SettleBillMismatchSnapshot = {
  bills: { alpha: { amountMismatch: 0, generatedAtSeconds: 1_767_225_601 } },
};

it('[AC-B2-09zn#6] 通道差错单缓存差 1 毫秒满 30 秒仍返回同一快照，满 30 秒重读', async () => {
  const clock = movingClock();
  const collect = vi
    .fn<() => Promise<ChannelMismatchSnapshot>>()
    .mockResolvedValueOnce(OPEN_FIRST)
    .mockResolvedValueOnce(OPEN_NEXT);
  const cached = cacheChannelMismatchCollector(collect, clock);

  expect(await cached()).toBe(OPEN_FIRST);
  clock.setElapsed(TTL_MS - 1);
  expect(await cached()).toBe(OPEN_FIRST);
  expect(collect).toHaveBeenCalledTimes(1);

  clock.setElapsed(TTL_MS);
  expect(await cached()).toBe(OPEN_NEXT);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B2-09zn#7] 账单缓存差 1 毫秒满 30 秒仍返回同一份成对快照，满 30 秒重读', async () => {
  const clock = movingClock();
  const collect = vi
    .fn<() => Promise<SettleBillMismatchSnapshot>>()
    .mockResolvedValueOnce(BILL_FIRST)
    .mockResolvedValueOnce(BILL_NEXT);
  const cached = cacheSettleBillMismatchCollector(collect, clock);

  expect(await cached()).toBe(BILL_FIRST);
  clock.setElapsed(TTL_MS - 1);
  expect(await cached()).toBe(BILL_FIRST);
  expect(collect).toHaveBeenCalledTimes(1);

  clock.setElapsed(TTL_MS);
  expect(await cached()).toBe(BILL_NEXT);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B2-09zn#8] 通道差错单读失败原样拒绝，下一次立刻重读，过期快照不顶替', async () => {
  const failure = new Error('channel mismatch read unavailable');
  const clock = movingClock();
  const collect = vi
    .fn<() => Promise<ChannelMismatchSnapshot>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(OPEN_FIRST)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(OPEN_NEXT);
  const cached = cacheChannelMismatchCollector(collect, clock);

  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toBe(OPEN_FIRST);
  expect(collect).toHaveBeenCalledTimes(2);

  clock.setElapsed(TTL_MS);
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toBe(OPEN_NEXT);
  expect(collect).toHaveBeenCalledTimes(4);
});

it('[AC-B2-09zn#9] 账单读失败原样拒绝，下一次立刻重读，过期快照不顶替', async () => {
  const failure = new Error('settle bill mismatch read unavailable');
  const clock = movingClock();
  const collect = vi
    .fn<() => Promise<SettleBillMismatchSnapshot>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(BILL_FIRST)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(BILL_NEXT);
  const cached = cacheSettleBillMismatchCollector(collect, clock);

  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toBe(BILL_FIRST);
  expect(collect).toHaveBeenCalledTimes(2);

  clock.setElapsed(TTL_MS);
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toBe(BILL_NEXT);
  expect(collect).toHaveBeenCalledTimes(4);
});
