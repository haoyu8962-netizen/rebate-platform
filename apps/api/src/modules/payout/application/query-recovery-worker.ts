// B2-06i: the payout process's timer around the query chain's crash recovery (规划/08 BR-WDR-14;
// query-recovery.ts): one round at once, then one every hour. A round still running when the hour
// comes means that hour is skipped, so rounds never overlap. A failed round is one warn line with
// the error's name only and the next hour tries again: recovery never takes the process down.
// stop() clears the timer and waits for the round in flight, because the entry closes the queue and
// the database right after it (D10-553, as payment.module.ts reconChainTimer).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { QueryRecovery, QueryRecoveryLogger } from './query-recovery.ts';

export const QUERY_RECOVERY_INTERVAL_MS = 3_600_000;

export interface QueryRecoveryWorkerOptions {
  readonly recovery: Pick<QueryRecovery, 'scan'>;
  /** The handle handed to scan. */
  readonly db: Kysely<DB>;
  /** Every round reads clock.now() afresh. */
  readonly clock: Clock;
  readonly logger: QueryRecoveryLogger;
}

export interface QueryRecoveryWorker {
  stop(): Promise<void>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function startQueryRecoveryWorker(options: QueryRecoveryWorkerOptions): QueryRecoveryWorker {
  const { recovery, db, clock, logger } = options;
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const round = async (): Promise<void> => {
    try {
      const { scanned, enqueued, manual } = await recovery.scan(db, clock.now());
      logger.info({ scanned, enqueued, manual }, 'payout_query_recovery_scanned');
    } catch (error: unknown) {
      logger.warn({ error_name: errorName(error) }, 'payout_query_recovery_failed');
    } finally {
      running = false;
    }
  };
  // Only a round that starts replaces inFlight: a skipped hour leaves it on the running round.
  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    inFlight = round();
  };
  tick();
  const interval = setInterval(tick, QUERY_RECOVERY_INTERVAL_MS);
  interval.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await inFlight;
    },
  };
}
