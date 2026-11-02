// B2-04zo (D10-587): the worker entry's asset daily snapshot schedule (BR-FUND-18, BR-FUND-20): a
// timer, not a queue (unref, first tick after bootstrap, no overlap; stopped on destroy, which
// waits for the tick in flight up to a bound). Every tick is tickAssetSnapshots over the snapshot
// rows themselves. Without a database or queue nothing runs and EVENT_BUS is not asked for; with
// them a missing EVENT_BUS makes assembleAssetSnapshot throw, so the worker refuses to start.
// The two ports come from app.module (ledger imports neither settlement nor content).
import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB as DB_TOKEN,
  EVENT_BUS,
  JOB_QUEUE,
  ROOT_LOGGER,
  waitForTickStop,
  type Clock,
  type EventBus,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import { assembleAssetSnapshot } from './application/asset-snapshot-assembly.ts';
import {
  tickAssetSnapshots,
  type AssetSnapshotRunStore,
} from './application/asset-snapshot-schedule.ts';
import type { AssetSnapshotRunner, PendingEarningsSource } from './application/asset-snapshot.ts';
import { createAssetSnapshotRunStore } from './infra/asset-snapshot-run-store.ts';

/** What app.module hands in on the worker entry. */
export interface LedgerAssetSnapshotWorkerOptions {
  /** settlement's source; config reads follow the read transaction it is handed. */
  readonly pendingEarnings: (clock: Clock) => PendingEarningsSource;
  /** content's ledger.advance_alert_fen of an app; null when not set (no exposure alert). */
  readonly advanceAlertFen: (
    db: Kysely<DB>,
    clock: Clock,
  ) => (appId: string) => Promise<bigint | null>;
}

const TIMER = 'ledger-asset-snapshot';
/** The timer of the schedule (lifecycle hooks). */
const ASSET_SNAPSHOT_TIMER = Symbol('LEDGER_ASSET_SNAPSHOT_TIMER');
/** Delay of the first tick after bootstrap. */
export const LEDGER_ASSET_SNAPSHOT_FIRST_TICK_MS = 15_000;
/** Interval between ticks: settlement batches wait for the snapshot, so it must start on time. */
export const LEDGER_ASSET_SNAPSHOT_TICK_MS = 60_000;

interface TickDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly runner: AssetSnapshotRunner;
  readonly runs: AssetSnapshotRunStore;
}

interface AssetSnapshotTimer {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

/** The first tick after bootstrap, then one every interval; null deps: inert. */
export function assetSnapshotTimer(deps: TickDependencies | null): AssetSnapshotTimer {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: TickDependencies): Promise<void> => {
    try {
      await tickAssetSnapshots({ ...active, isStopped: () => stopped });
    } catch (error: unknown) {
      active.logger.warn(
        { timer: TIMER, error_name: error instanceof Error ? error.name : typeof error },
        'ledger_asset_snapshot_tick_failed',
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
        interval = setInterval(tick, LEDGER_ASSET_SNAPSHOT_TICK_MS);
        interval.unref();
      }, LEDGER_ASSET_SNAPSHOT_FIRST_TICK_MS);
      first.unref();
    },
    async onModuleDestroy() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      if (deps !== null && running) await waitForTickStop(inFlight, TIMER, deps.logger);
    },
  };
}

export class LedgerAssetSnapshotModule {
  static forWorker(options: LedgerAssetSnapshotWorkerOptions): DynamicModule {
    return {
      module: LedgerAssetSnapshotModule,
      providers: [
        {
          provide: ASSET_SNAPSHOT_TIMER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
            eventBus?: EventBus,
          ): AssetSnapshotTimer => {
            if (db === undefined || queue === undefined) {
              logger.info({ timer: TIMER }, 'ledger_asset_snapshot_disabled');
              return assetSnapshotTimer(null);
            }
            const tickLogger = logger.child({ module: 'ledger', timer: TIMER });
            const runner = assembleAssetSnapshot({
              clock,
              logger: tickLogger,
              pendingEarnings: options.pendingEarnings(clock),
              getAdvanceAlertFen: options.advanceAlertFen(db, clock),
              // Checked at run time by the assembly, which throws when it is missing.
              eventBus: eventBus as EventBus,
            });
            return assetSnapshotTimer({
              db,
              clock,
              logger: tickLogger,
              runner,
              runs: createAssetSnapshotRunStore(db),
            });
          },
        },
      ],
    };
  }
}
