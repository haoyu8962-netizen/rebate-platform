// B1-34q (01 F-ADM-26 ②; D10-1401): the worker entry's schedule of the workbench's yesterday
// overview. A timer, not a queue (unref, first tick after bootstrap, no overlap; stopped on destroy,
// which waits for the tick in flight up to a bound), written like ledger's asset snapshot timer.
// Every tick is tickDashboardDays over the rows themselves (no process memory), with the production
// sources of infra/dashboard-day-sources.ts. Without a database nothing runs.
// TODO(规划/11 §2.3): the gauge of how many days each app's newest row lags behind the newest due
// day, and its alert rule in infra/monitoring/rules/couli.yaml — blocked on the worker's metrics
// registry (platform/metrics, entry.ts), which lies outside task B1-34q's paths; until then a
// missing day shows as the admin_dashboard_day_failed error line of every tick.
import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB as DB_TOKEN,
  ROOT_LOGGER,
  waitForTickStop,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import { tickDashboardDays, type DashboardDaySources } from './application/dashboard-days.ts';
import { createDashboardDaySources } from './infra/dashboard-day-sources.ts';

const TIMER = 'admin-dashboard-days';
/** The timer of the schedule (lifecycle hooks). */
const DASHBOARD_DAYS_TIMER = Symbol('ADMIN_DASHBOARD_DAYS_TIMER');
/** Delay of the first tick after bootstrap. */
export const DASHBOARD_DAYS_FIRST_TICK_MS = 20_000;
/** Interval between ticks: D falls due at D+1 00:10 +08:00 and is written within a minute. */
export const DASHBOARD_DAYS_TICK_MS = 60_000;

interface TickDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly sources: DashboardDaySources;
}

interface DashboardDaysTimer {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

/** The first tick after bootstrap, then one every interval; null deps: inert. */
export function dashboardDaysTimer(deps: TickDependencies | null): DashboardDaysTimer {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: TickDependencies): Promise<void> => {
    try {
      await tickDashboardDays(active);
    } catch (error: unknown) {
      // Listing the apps failed; per-app failures are logged inside the tick.
      active.logger.warn(
        { timer: TIMER, error_name: error instanceof Error ? error.name : typeof error },
        'admin_dashboard_days_tick_failed',
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
        interval = setInterval(tick, DASHBOARD_DAYS_TICK_MS);
        interval.unref();
      }, DASHBOARD_DAYS_FIRST_TICK_MS);
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

export class AdminDashboardDaysModule {
  static forWorker(): DynamicModule {
    return {
      module: AdminDashboardDaysModule,
      providers: [
        {
          provide: DASHBOARD_DAYS_TIMER,
          inject: [CLOCK, ROOT_LOGGER, { token: DB_TOKEN, optional: true }],
          useFactory: (clock: Clock, logger: RootLogger, db?: Kysely<DB>): DashboardDaysTimer => {
            if (db === undefined) {
              logger.info({ timer: TIMER }, 'admin_dashboard_days_disabled');
              return dashboardDaysTimer(null);
            }
            return dashboardDaysTimer({
              db,
              clock,
              logger: logger.child({ module: 'admin', timer: TIMER }),
              sources: createDashboardDaySources({ db, clock }),
            });
          },
        },
      ],
    };
  }
}
