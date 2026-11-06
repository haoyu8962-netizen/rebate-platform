// B2-12f: BR-FUND-12 bad debt write-offs (application/bad-debt-writeoff.ts, conventions there).
// forWorker (worker entry only): the generation of the candidates on a timer, not a queue (unref,
// first tick 15 s after bootstrap, then every 60 s, no overlap; stopped on destroy, which waits for
// the tick in flight up to a bound). Without a database nothing runs. forAdmin (admin entry only):
// the list and the approval routes. app.module calls each once and hands in identity's and
// content's ports (and, for the approval, the ledger with the entry's bus and payout's recovery
// hook); ledger imports neither identity nor content.
import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB as DB_TOKEN,
  EVENT_BUS,
  IDEMPOTENCY,
  ROOT_LOGGER,
  waitForTickStop,
  type AuditPort,
  type Clock,
  type EventBus,
  type Idempotency,
  type RootLogger,
} from '../platform/index.ts';
import {
  tickBadDebtWriteoffCandidates,
  type AdminBadDebtWriteoffApproveDeps,
  type AdminBadDebtWriteoffReadDeps,
  type BadDebtWriteoffPorts,
} from './application/bad-debt-writeoff.ts';
import { createLedger, type Ledger } from './application/reverse.ts';
import {
  AdminBadDebtWriteoffsController,
  BAD_DEBT_WRITEOFF_APPROVE_DEPS,
  BAD_DEBT_WRITEOFF_READ_DEPS,
} from './http/admin/bad-debt-writeoffs.controller.ts';

/** What app.module hands in on the worker entry. */
export interface LedgerBadDebtWriteoffWorkerOptions {
  readonly ports: BadDebtWriteoffPorts;
}

/** What app.module hands in on the admin entry. */
export interface LedgerBadDebtWriteoffAdminOptions {
  readonly ports: BadDebtWriteoffPorts;
  /** The approval's ledger: the entry's event bus and payout's recovery hook (D10-587). */
  readonly ledger: (context: { readonly clock: Clock; readonly eventBus: EventBus }) => Ledger;
  /** Binds admin's audit writer to the approving transaction. */
  readonly auditWriter: (db: Kysely<DB>, clock: Clock) => AuditPort;
}

const TIMER = 'ledger-bad-debt-writeoff';
/** The timer of the generation (lifecycle hooks). */
const BAD_DEBT_WRITEOFF_TIMER = Symbol('LEDGER_BAD_DEBT_WRITEOFF_TIMER');
/** Delay of the first tick after bootstrap. */
export const LEDGER_BAD_DEBT_WRITEOFF_FIRST_TICK_MS = 15_000;
/** Interval between ticks (the day's R3 completion is picked up within a minute). */
export const LEDGER_BAD_DEBT_WRITEOFF_TICK_MS = 60_000;

interface TickDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly ports: BadDebtWriteoffPorts;
  /** Balance locks only: the generation posts no voucher. */
  readonly ledger: Pick<Ledger, 'lockBalances'>;
}

interface BadDebtWriteoffTimer {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

/** The first tick after bootstrap, then one every interval; null deps: inert. */
export function badDebtWriteoffTimer(deps: TickDependencies | null): BadDebtWriteoffTimer {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: TickDependencies): Promise<void> => {
    try {
      await tickBadDebtWriteoffCandidates({ ...active, isStopped: () => stopped });
    } catch (error: unknown) {
      active.logger.warn(
        { timer: TIMER, error_name: error instanceof Error ? error.name : typeof error },
        'ledger_bad_debt_writeoff_tick_failed',
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
        interval = setInterval(tick, LEDGER_BAD_DEBT_WRITEOFF_TICK_MS);
        interval.unref();
      }, LEDGER_BAD_DEBT_WRITEOFF_FIRST_TICK_MS);
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

export class LedgerBadDebtWriteoffModule {
  static forWorker(options: LedgerBadDebtWriteoffWorkerOptions): DynamicModule {
    return {
      module: LedgerBadDebtWriteoffModule,
      providers: [
        {
          provide: BAD_DEBT_WRITEOFF_TIMER,
          inject: [CLOCK, ROOT_LOGGER, { token: DB_TOKEN, optional: true }],
          useFactory: (clock: Clock, logger: RootLogger, db?: Kysely<DB>): BadDebtWriteoffTimer => {
            if (db === undefined) {
              logger.info({ timer: TIMER }, 'ledger_bad_debt_writeoff_disabled');
              return badDebtWriteoffTimer(null);
            }
            return badDebtWriteoffTimer({
              db,
              clock,
              logger: logger.child({ module: 'ledger', timer: TIMER }),
              ports: options.ports,
              // Only lockBalances is used (the generation posts nothing): no bus, no recovery hook.
              ledger: createLedger({ clock }),
            });
          },
        },
      ],
    };
  }

  static forAdmin(options: LedgerBadDebtWriteoffAdminOptions): DynamicModule {
    return {
      module: LedgerBadDebtWriteoffModule,
      controllers: [AdminBadDebtWriteoffsController],
      providers: [
        {
          provide: BAD_DEBT_WRITEOFF_READ_DEPS,
          inject: [CLOCK, { token: DB_TOKEN, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<DB>): AdminBadDebtWriteoffReadDeps | null =>
            db === undefined ? null : { db, clock, ports: options.ports },
        },
        {
          provide: BAD_DEBT_WRITEOFF_APPROVE_DEPS,
          inject: [
            CLOCK,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
            eventBus?: EventBus,
          ): AdminBadDebtWriteoffApproveDeps | null =>
            db === undefined || idempotency === undefined || eventBus === undefined
              ? null
              : {
                  db,
                  clock,
                  idempotency,
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  ledger: options.ledger({ clock, eventBus }),
                  ports: options.ports,
                },
        },
      ],
    };
  }
}
