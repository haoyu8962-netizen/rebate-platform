// B2-09ze: the worker's stale W collection is cached like the water level one (5 minutes by the
// injected clock, counted from the collection's start). A failed collection is never cached and an
// expired snapshot is never served in place of a failed one: the cache never serves a wrong value.
import { expect, it, vi } from 'vitest';
import {
  cacheWaterStaleCollector,
  type WaterStaleSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { NOW_MS, TTL_MS } from '../water-level/water-harness.ts';

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

const STALE: WaterStaleSnapshot = { waterStale: { stale_a: 1 } };
const FRESH: WaterStaleSnapshot = { waterStale: { stale_a: 0 } };

it('[AC-B2-09ze#5] 默认缓存 5 分钟：差 1 毫秒仍是同一份快照、不再读；满 5 分钟重读并跟随新值', async () => {
  const clock = movingClock();
  const collect = vi.fn<() => Promise<WaterStaleSnapshot>>();
  collect.mockResolvedValueOnce(STALE).mockResolvedValueOnce(FRESH);
  const cached = cacheWaterStaleCollector(collect, clock);

  expect(await cached()).toEqual(STALE);
  expect(await cached()).toEqual(STALE);
  clock.set(NOW_MS + TTL_MS - 1);
  expect(await cached()).toEqual(STALE);
  expect(collect).toHaveBeenCalledTimes(1);

  clock.set(NOW_MS + TTL_MS);
  expect(await cached()).toEqual(FRESH);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B2-09ze#6] 失败不缓存：读失败原样拒绝，下一次立刻重读；过期的旧快照不会在读失败时顶替', async () => {
  const failure = new Error('stand-in: stale W read unavailable');
  const clock = movingClock();
  const collect = vi.fn<() => Promise<WaterStaleSnapshot>>();
  collect
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(STALE)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(FRESH);
  const cached = cacheWaterStaleCollector(collect, clock);

  // The first read fails: nothing is kept, and the same instant reads again.
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(STALE);
  expect(collect).toHaveBeenCalledTimes(2);

  // The snapshot expired and the read fails: the scrape fails, the old value does not come back.
  clock.set(NOW_MS + TTL_MS);
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(FRESH);
  expect(collect).toHaveBeenCalledTimes(4);
});
