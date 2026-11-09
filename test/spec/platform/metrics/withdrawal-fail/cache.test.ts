// B2-09zj: the worker's payout failure collection is cached like the water level ones (5 minutes by
// the injected clock, counted from the collection's start). A failed collection is never cached and
// an expired snapshot is never served in place of a failed one: the cache never serves a wrong value.
import { expect, it, vi } from 'vitest';
import {
  cacheWithdrawalFailCollector,
  type WithdrawalFailSnapshot,
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

const BAD: WithdrawalFailSnapshot = {
  w6Today: { fail_a: 1 },
  w5w6Today: { fail_a: 30 },
  w6Streak: { fail_a: 3 },
};
const GOOD: WithdrawalFailSnapshot = {
  w6Today: { fail_a: 1 },
  w5w6Today: { fail_a: 31 },
  w6Streak: { fail_a: 0 },
};

it('[AC-B2-09zj#5] 默认缓存 5 分钟：差 1 毫秒仍是同一份快照、不再读；满 5 分钟重读并跟随新值', async () => {
  const clock = movingClock();
  const collect = vi.fn<() => Promise<WithdrawalFailSnapshot>>();
  collect.mockResolvedValueOnce(BAD).mockResolvedValueOnce(GOOD);
  const cached = cacheWithdrawalFailCollector(collect, clock);

  expect(await cached()).toEqual(BAD);
  expect(await cached()).toEqual(BAD);
  clock.set(NOW_MS + TTL_MS - 1);
  expect(await cached()).toEqual(BAD);
  expect(collect).toHaveBeenCalledTimes(1);

  clock.set(NOW_MS + TTL_MS);
  expect(await cached()).toEqual(GOOD);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B2-09zj#6] 失败不缓存：读失败原样拒绝，下一次立刻重读；过期的旧快照不会在读失败时顶替', async () => {
  const failure = new Error('stand-in: payout failure read unavailable');
  const clock = movingClock();
  const collect = vi.fn<() => Promise<WithdrawalFailSnapshot>>();
  collect
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(BAD)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(GOOD);
  const cached = cacheWithdrawalFailCollector(collect, clock);

  // The first read fails: nothing is kept, and the same instant reads again.
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(BAD);
  expect(collect).toHaveBeenCalledTimes(2);

  // The snapshot expired and the read fails: the scrape fails, the old value does not come back.
  clock.set(NOW_MS + TTL_MS);
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(GOOD);
  expect(collect).toHaveBeenCalledTimes(4);
});
