// B2-02q: the worker entry's daily ledger check (BR-FUND-19): queue ledger-check's handler
// (application/daily-check-schedule.ts createDailyCheckJob) and the chain's seed / heal timer
// (unref, after bootstrap; stopped on destroy, which waits for the tick in flight up to a bound,
// B2-15q, B2-15s).
// B2-02r: every tick is healDailyCheck over the run store (the actual state of the queue and the
// results, no process memory), so a run that failed into ledger-check.dead is sent again and an
// overdue (app, D) is alerted once. Without a database or queue nothing is registered.
// The two ports of the B2-02p execution step come from app.module (ledger imports neither payout
// nor content): payout's createWithdrawHolds and content's createSystemSwitchWriter.
import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB as DB_TOKEN,
  JOB_QUEUE,
  ROOT_LOGGER,
  waitForTickStop,
  type Clock,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import type {
  AutoSettlementSwitch,
  LedgerMismatchHolds,
} from './application/daily-check-execute.ts';
import { createDailyCheckJob } from './application/daily-check-schedule.ts';
import {
  healDailyCheck,
  type DailyCheckRunStore,
} from './application/daily-check-schedule-heal.ts';
import { createDailyCheckRunStore } from './infra/daily-check-run-store.ts';

/** What app.module hands in on the worker entry. */
export interface LedgerDailyCheckWorkerOptions {
  /** payout's createWithdrawHolds as the hold port (reason ledger_mismatch, created_by system). */
  readonly holds: (clock: Clock, logger: RootLogger) => LedgerMismatchHolds;
  /** content's createSystemSwitchWriter as the settle.auto.enabled port. */
  readonly autoSettlement: (clock: Clock, logger: RootLogger) => AutoSettlementSwitch;
}

const QUEUE = 'ledger-check';
/** The registration of the handler (null: no database or queue, nothing registered). */
const DAILY_CHECK_WORKER = Symbol('LEDGER_DAILY_CHECK_WORKER');
/** The seed / heal timer (lifecycle hooks). */
const DAILY_CHECK_TIMER = Symbol('LEDGER_DAILY_CHECK_TIMER');
/** Delay of the first seed after bootstrap (the queue runtime starts meanwhile). */
export const LEDGER_DAILY_CHECK_SEED_DELAY_MS = 15_000;
/** Interval between two heals of the chain. */
export const LEDGER_DAILY_CHECK_HEAL_INTERVAL_MS = 30 * 60_000;

interface SeedDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: QueueRuntime;
  readonly logger: RootLogger;
  readonly runs: DailyCheckRunStore;
}

interface DailyCheckTimer {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

/** The seed after bootstrap and the heal every interval; null deps: inert. */
function dailyCheckTimer(deps: SeedDependencies | null): DailyCheckTimer {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: SeedDependencies): Promise<void> => {
    try {
      await healDailyCheck(active);
    } catch (error: unknown) {
      active.logger.warn(
        { queue: QUEUE, error_name: error instanceof Error ? error.name : typeof error },
        'ledger_daily_check_heal_failed',
      );
    } finally {
      running = false;
    }
  };
  // Only a tick that starts replaces inFlight: a skipped one leaves it on the running tick.
  const tick = (): void => {
    if (deps === null || running || stopped) return;
    running = true;
    inFlight = run(deps);
  };
  return {
    onApplicationBootstrap() {
      if (deps === null || first !== undefined || stopped) return;
      first = setTimeout(() => {
        tick();
        if (stopped) return;
        interval = setInterval(tick, LEDGER_DAILY_CHECK_HEAL_INTERVAL_MS);
        interval.unref();
      }, LEDGER_DAILY_CHECK_SEED_DELAY_MS);
      first.unref();
    },
    async onModuleDestroy() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      if (deps !== null && running) {
        await waitForTickStop(inFlight, 'ledger-daily-check', deps.logger);
      }
    },
  };
}

export class LedgerDailyCheckModule {
  static forWorker(options: LedgerDailyCheckWorkerOptions): DynamicModule {
    return {
      module: LedgerDailyCheckModule,
      providers: [
        {
          provide: DAILY_CHECK_WORKER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
          ): SeedDependencies | null => {
            if (db === undefined || queue === undefined) {
              logger.info({ queue: QUEUE }, 'ledger_daily_check_disabled');
              return null;
            }
            const checkLogger = logger.child({ module: 'ledger', queue: QUEUE });
            queue.register(
              QUEUE,
              createDailyCheckJob({
                db,
                clock,
                queue,
                logger: checkLogger,
                holds: options.holds(clock, checkLogger),
                autoSettlement: options.autoSettlement(clock, checkLogger),
              }),
            );
            return { db, clock, queue, logger: checkLogger, runs: createDailyCheckRunStore(db) };
          },
        },
        {
          // The chain's seed and heal, only beside a registered handler.
          provide: DAILY_CHECK_TIMER,
          inject: [DAILY_CHECK_WORKER],
          useFactory: (deps: SeedDependencies | null): DailyCheckTimer => dailyCheckTimer(deps),
        },
      ],
    };
  }
}
