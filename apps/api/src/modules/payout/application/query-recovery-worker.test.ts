import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { QUERY_RECOVERY_INTERVAL_MS, startQueryRecoveryWorker } from './query-recovery-worker.ts';
import type { QueryRecoveryResult } from './query-recovery.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const COUNTS: QueryRecoveryResult = { scanned: 0, enqueued: 0, manual: 0 };

// The rule tests stop during the first round only; the wait must follow the latest round.
it('[AC-B2-06i-U#1] stop during a later round waits for that round, not the first one', async () => {
  vi.useFakeTimers();
  const finishers: (() => void)[] = [];
  const scan = vi.fn(
    () =>
      new Promise<QueryRecoveryResult>((resolve) => {
        finishers.push(() => resolve(COUNTS));
      }),
  );
  const worker = startQueryRecoveryWorker({
    recovery: { scan },
    db: {} as Kysely<DB>,
    clock: new FixedClock('2026-11-02T02:00:00.000Z'),
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  finishers[0]!();
  await vi.advanceTimersByTimeAsync(QUERY_RECOVERY_INTERVAL_MS);
  expect(scan).toHaveBeenCalledTimes(2);

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(3 * QUERY_RECOVERY_INTERVAL_MS);
  expect(stopped).toBe(false);
  expect(scan).toHaveBeenCalledTimes(2);

  finishers[1]!();
  await stopping;
  expect(stopped).toBe(true);
});
