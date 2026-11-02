// The recovery worker over a scripted scan: fake timers, no database. Each scan call is one round
// the test ends by hand, so a round in flight stays in flight for as long as a test needs.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, vi } from 'vitest';
import * as workerModule from '../../../../apps/api/src/modules/payout/application/query-recovery-worker.ts';
import type {
  QueryRecovery,
  QueryRecoveryLogger,
  QueryRecoveryResult,
} from '../../../../apps/api/src/modules/payout/application/query-recovery.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

export const HOUR_MS = 3_600_000;
export const START = '2026-11-02T02:00:00.000Z';
export const COUNTS: QueryRecoveryResult = { scanned: 3, enqueued: 1, manual: 2 };
/** In a thrown error's message only: it must never reach a log line. */
export const DETAIL = 'synthetic-detail-of-a-withdrawal';

export interface Round {
  readonly handle: Kysely<DB>;
  readonly now: Date;
  finish(result?: QueryRecoveryResult): void;
  fail(error: unknown): void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
  vi.clearAllTimers();
  // Spies first: one taken on a fake timer function must not outlive the fake timers.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

export function harness() {
  vi.useFakeTimers();
  const clock = new FixedClock(START);
  const rounds: Round[] = [];
  let running = 0;
  let mostRunning = 0;
  const scan = vi.fn<QueryRecovery['scan']>(
    (handle, now) =>
      new Promise<QueryRecoveryResult>((resolve, reject) => {
        running += 1;
        mostRunning = Math.max(mostRunning, running);
        rounds.push({
          handle,
          now,
          finish(result = COUNTS) {
            running -= 1;
            resolve(result);
          },
          fail(error) {
            running -= 1;
            reject(error);
          },
        });
      }),
  );
  const logger = {
    info: vi.fn<QueryRecoveryLogger['info']>(),
    warn: vi.fn<QueryRecoveryLogger['warn']>(),
  };
  const db = { handle: 'synthetic' } as unknown as Kysely<DB>;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => void rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  cleanups.push(() => process.off('unhandledRejection', onRejection));
  return {
    clock,
    scan,
    logger,
    db,
    /** Rejections nobody handled since this harness was made. */
    rejections,
    mostRunning: () => mostRunning,
    round(index: number): Round {
      expect(rounds.length).toBeGreaterThan(index);
      return rounds[index] as Round;
    },
    start: () => workerModule.startQueryRecoveryWorker({ recovery: { scan }, db, clock, logger }),
  };
}

/** The exported constant, read off the namespace: the skeleton may not declare it. */
export function declaredInterval(): unknown {
  return (workerModule as unknown as { QUERY_RECOVERY_INTERVAL_MS?: unknown })
    .QUERY_RECOVERY_INTERVAL_MS;
}

/** Lets promise callbacks run; no fake timer fires. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Moves the fake timers on; a round's callbacks and unhandled rejections are seen by then. */
export async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

export function failure(name: string): Error {
  const error = new Error(DETAIL);
  error.name = name;
  return error;
}
