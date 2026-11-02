// The site authorization check of the worker entry (B1-22b, BR-ID-24): app.module imports this
// module on `worker` only. It builds the monitor (./service.ts) over DB, CLOCK, JOB_QUEUE,
// FIELD_CRYPTO and the ports app.module hands in (content's config reader, notification's alert
// port), and registers its handler on JOB_QUEUE for queue `union-auth` (worker ENTRY_PLAN only).
// Without a database, a queue or the field cipher nothing is registered, the token provides null
// and one info line `union_auth_disabled` is logged.
//
// The probe port: no union adapter can probe a site authorization yet, so the default probe
// answers unsupported (no last_probe_* written; the expiry check runs as usual).
//
// Chain start and self-heal live here (entry.ts is not this task's path): a timer, unref'd and
// started on application bootstrap, seeds every App's next check slot SEED_DELAY_MS later (the
// queue runtime has started by then; a failed seed is a warn line and is retried on the next
// tick; so is a failed heal, B2-15q), then heals the chain every HEAL_INTERVAL_MS. The timer stops
// on module destroy, which waits for the tick in flight up to a bound (B2-15q, B2-15s).
//
// A class decorator only (no parameter decorators or parameter properties), as in
// risk/risk-scan.module.ts.
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  JOB_QUEUE,
  ROOT_LOGGER,
  waitForTickStop,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type QueueRuntime,
  type RootLogger,
} from '../../platform/index.ts';
import {
  UNION_AUTH_QUEUE,
  createSiteAuthMonitor,
  type SiteAuthAlerts,
  type SiteAuthMonitor,
  type SiteAuthProbe,
  type SiteAuthRefresher,
} from './service.ts';

export interface UnionAuthModuleOptions {
  /** union.auth_alert_days / union.auth_probe_cron / union.auth_alert_phones / attr.jd.* reads. */
  readonly config: (db: Kysely<Database>, clock: Clock) => Pick<ContentReader, 'configValue'>;
  /** notification's alert port with the entry's template SMS sender. */
  readonly alerts: (deps: {
    readonly db: Kysely<Database>;
    readonly clock: Clock;
    readonly logger: RootLogger;
    readonly appEnv: AppConfig['appEnv'];
  }) => SiteAuthAlerts;
  readonly probe?: SiteAuthProbe;
  readonly refresher?: SiteAuthRefresher;
}

const MONITOR = Symbol('UNION_AUTH_MONITOR');
const TIMER = Symbol('UNION_AUTH_TIMER');
/** Delay of the first seed after bootstrap (the worker's queue runtime starts meanwhile). */
export const SEED_DELAY_MS = 30_000;
/** Interval between two heals of the chain. */
export const HEAL_INTERVAL_MS = 5 * 60_000;

/** Provider token of the assembled monitor (null when disabled). */
export function unionAuthMonitorToken(): symbol {
  return MONITOR;
}

const UNSUPPORTED_PROBE: SiteAuthProbe = Object.freeze({
  probe: async () => ({ kind: 'unsupported' as const }),
});

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

interface ChainTimer {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

function chainTimer(monitor: SiteAuthMonitor | null, logger: RootLogger): ChainTimer {
  let seeded = false;
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: SiteAuthMonitor): Promise<void> => {
    try {
      if (!seeded) {
        try {
          await active.seed();
          seeded = true;
        } catch (error) {
          logger.warn(
            { queue: UNION_AUTH_QUEUE, error_name: errorName(error) },
            'union_auth_seed_failed',
          );
        }
      }
      await active.heal();
    } catch (error) {
      logger.warn(
        { queue: UNION_AUTH_QUEUE, error_name: errorName(error) },
        'union_auth_heal_failed',
      );
    } finally {
      running = false;
    }
  };
  // Only a tick that starts replaces inFlight: a skipped one leaves it on the running tick.
  const tick = (): void => {
    if (monitor === null || running || stopped) return;
    running = true;
    inFlight = run(monitor);
  };
  return {
    onApplicationBootstrap() {
      if (monitor === null || first !== undefined || stopped) return;
      first = setTimeout(() => {
        tick();
        interval = setInterval(tick, HEAL_INTERVAL_MS);
        interval.unref();
      }, SEED_DELAY_MS);
      first.unref();
    },
    async onModuleDestroy() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      if (running) await waitForTickStop(inFlight, 'union-auth', logger);
    },
  };
}

@Module({})
export class UnionAuthModule {
  static forWorker(options: UnionAuthModuleOptions): DynamicModule {
    return {
      module: UnionAuthModule,
      providers: [
        {
          provide: MONITOR,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
            crypto?: FieldCrypto,
          ): SiteAuthMonitor | null => {
            if (db === undefined || queue === undefined || crypto === undefined) {
              logger.info({ queue: UNION_AUTH_QUEUE }, 'union_auth_disabled');
              return null;
            }
            const monitor = createSiteAuthMonitor({
              db,
              clock,
              queue,
              logger,
              crypto,
              config: options.config(db, clock),
              probe: options.probe ?? UNSUPPORTED_PROBE,
              ...(options.refresher === undefined ? {} : { refresher: options.refresher }),
              alerts: options.alerts({ db, clock, logger, appEnv: appConfig.appEnv }),
            });
            queue.register(UNION_AUTH_QUEUE, (job) => monitor.handle(job));
            return monitor;
          },
        },
        {
          provide: TIMER,
          inject: [MONITOR, ROOT_LOGGER],
          useFactory: (monitor: SiteAuthMonitor | null, logger: RootLogger): ChainTimer =>
            chainTimer(monitor, logger),
        },
      ],
      exports: [MONITOR],
    };
  }
}
