// B2-09j: the worker's water level collection is cached like review-overdue's (5 minutes by the
// injected clock, counted from the collection's start). A failed collection is never cached and an
// expired snapshot is never served in place of a failed one: the cache never serves a wrong value.
import { expect, it, vi } from 'vitest';
import {
  cacheWaterLowCollector,
  type WaterLowSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { NOW_MS, TTL_MS } from './water-harness.ts';

/** A clock the test moves. */
function movingClock() {
  let ms = NOW_MS;
  return {
    now: () => new Date(ms),
    set(next: number) {
      ms = next;
    },
  };
}

const LOW: WaterLowSnapshot = { waterLow: { water_a: 1 } };
const NOT_LOW: WaterLowSnapshot = { waterLow: { water_a: 0 } };

it('[AC-B2-09j#17] 默认缓存 5 分钟：差 1 毫秒仍是同一份快照、不再读；满 5 分钟重读并跟随新值', async () => {
  const clock = movingClock();
  const collect = vi.fn<() => Promise<WaterLowSnapshot>>();
  collect.mockResolvedValueOnce(LOW).mockResolvedValueOnce(NOT_LOW);
  const cached = cacheWaterLowCollector(collect, clock);

  expect(await cached()).toEqual(LOW);
  expect(await cached()).toEqual(LOW);
  clock.set(NOW_MS + TTL_MS - 1);
  expect(await cached()).toEqual(LOW);
  expect(collect).toHaveBeenCalledTimes(1);

  clock.set(NOW_MS + TTL_MS);
  expect(await cached()).toEqual(NOT_LOW);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B2-09j#18] 失败不缓存：读失败原样拒绝，下一次立刻重读；过期的旧快照不会在读失败时顶替', async () => {
  const failure = new Error('stand-in: water level read unavailable');
  const clock = movingClock();
  const collect = vi.fn<() => Promise<WaterLowSnapshot>>();
  collect
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(LOW)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(NOT_LOW);
  const cached = cacheWaterLowCollector(collect, clock);

  // The first read fails: nothing is kept, and the same instant reads again.
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(LOW);
  expect(collect).toHaveBeenCalledTimes(2);

  // The snapshot expired and the read fails: the scrape fails, the old value does not come back.
  clock.set(NOW_MS + TTL_MS);
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(NOT_LOW);
  expect(collect).toHaveBeenCalledTimes(4);
});
