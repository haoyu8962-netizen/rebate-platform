// B2-02v: the worker's collection of the open post-credit diffs is cached for 30 seconds by the
// injected clock, counted from the collection's start (BR-FUND-19 alerts within 5 minutes, so the
// common 5-minute cache is not used). A failed collection is never cached and an expired snapshot is
// never served in place of a failed one.
import { expect, it, vi } from 'vitest';
import {
  cacheCreditPostcheckCollector,
  type CreditPostcheckSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { NOW_MS } from '../water-level/water-harness.ts';
import { TTL_MS } from './postcheck-harness.ts';

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

const ONE: CreditPostcheckSnapshot = { open: { postcheck_a: 1 } };
const TWO: CreditPostcheckSnapshot = { open: { postcheck_a: 2 } };

it('[AC-B2-02v#5] 默认缓存 30 秒：差 1 毫秒仍是同一份快照、不再读；满 30 秒重读并跟随新值（不是通用的 5 分钟）', async () => {
  const clock = movingClock();
  const collect = vi.fn<() => Promise<CreditPostcheckSnapshot>>();
  collect.mockResolvedValueOnce(ONE).mockResolvedValueOnce(TWO);
  const cached = cacheCreditPostcheckCollector(collect, clock);

  expect(await cached()).toEqual(ONE);
  expect(await cached()).toEqual(ONE);
  clock.set(NOW_MS + TTL_MS - 1);
  expect(await cached()).toEqual(ONE);
  expect(collect).toHaveBeenCalledTimes(1);

  clock.set(NOW_MS + TTL_MS);
  expect(await cached()).toEqual(TWO);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B2-02v#6] 失败不缓存：读失败原样拒绝，下一次立刻重读；过期的旧快照不会在读失败时顶替', async () => {
  const failure = new Error('stand-in: open diffs read unavailable');
  const clock = movingClock();
  const collect = vi.fn<() => Promise<CreditPostcheckSnapshot>>();
  collect
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(ONE)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(TWO);
  const cached = cacheCreditPostcheckCollector(collect, clock);

  // The first read fails: nothing is kept, and the same instant reads again.
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(ONE);
  expect(collect).toHaveBeenCalledTimes(2);

  // The snapshot expired and the read fails: the scrape fails, the old value does not come back.
  clock.set(NOW_MS + TTL_MS);
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toEqual(TWO);
  expect(collect).toHaveBeenCalledTimes(4);
});
