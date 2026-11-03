import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB as DB_TOKEN,
  EVENT_BUS,
  FIELD_CRYPTO,
  IDEMPOTENCY,
  JOB_QUEUE,
  ROOT_LOGGER,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type Idempotency,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import type {
  AdminReconRestorePorts,
  RestoreAdminReconDiffDeps,
} from './application/admin-recon-restore.ts';
import type { AdminSettleBillReadDeps } from './application/admin-settle-bills.ts';
import {
  createAdminSettleCommandDeps,
  type AdminSettleCommandDeps,
  type AdminSettleCommandPorts,
} from './application/admin-settle-commands.ts';
import type {
  AdminUnionReceiptDeps,
  AdminUnionReceiptPorts,
} from './application/admin-union-receipts.ts';
import {
  ADMIN_RECON_RESTORE,
  AdminReconRestoreController,
} from './http/admin/recon-restore.controller.ts';
import {
  ADMIN_UNION_RECEIPTS,
  AdminUnionReceiptsController,
} from './http/admin/union-receipts.controller.ts';
import {
  ADMIN_SETTLE_BILL_READS,
  AdminSettleBillsController,
} from './http/admin/settle-bills.controller.ts';
import {
  ADMIN_SETTLE_COMMANDS,
  AdminSettleCommandsController,
} from './http/admin/settle-commands.controller.ts';
import { createBeneficiaryGate } from './credit/beneficiary-gate.ts';
import {
  createRebatePort,
  type RebateDependencies,
  type RebatePort,
} from './rebate/application/rebate.ts';
import { createSettleWorkerHandler, createSettleWorkerTimer } from './worker/assemble.ts';
import type { SettlementWorkerPorts } from './worker/ports.ts';

/** The settle queue's registration and timer on the worker entry (lifecycle hooks). */
const SETTLE_WORKER = Symbol('SETTLEMENT_SETTLE_WORKER');
const SETTLE_QUEUE = 'settle';

interface SettleWorkerLifecycle {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

function inertLifecycle(): SettleWorkerLifecycle {
  return { onApplicationBootstrap: () => undefined, onModuleDestroy: () => Promise.resolve() };
}

/** Nest injection token for the pre-credit rebate port (orders' rebate.onImported / onUpdated). */
export const REBATE_PORT = Symbol('REBATE_PORT');

/** register is the standalone module; app.module assembles the orders worker's rebate port. */
export class SettlementModule {
  static register(deps: RebateDependencies): DynamicModule {
    return {
      module: SettlementModule,
      providers: [
        {
          provide: REBATE_PORT,
          useFactory: (): RebatePort => createRebatePort(deps),
        },
      ],
      exports: [REBATE_PORT],
    };
  }

  /**
   * B2-04ze (D10-443): the worker entry's settle queue. With DB, JOB_QUEUE, FIELD_CRYPTO and
   * EVENT_BUS resolved (CLOCK, ROOT_LOGGER always), registers exactly one handler on queue settle
   * (worker/schedule.ts createSettleJobHandler) over createBillJob (production readSource and
   * saveBillValidations), createBatchExecutor, createCreditOrder and createBeneficiaryCredit (both
   * with readAttribution = ports.readAttribution, so readSnapshot is never their attribution read)
   * and createBeneficiaryGate (ports' identity and risk readers, minors = ports.minors(FIELD_CRYPTO)),
   * plus the module's own timer of the daily bill seed and the due batch scan: after bootstrap the
   * first tick runs within 60 s, later ones at most 60 s apart (unref); each tick runs
   * seedSettleBills (createSettleRunStore(db), ports.platforms), the bill catch-up
   * seedSettleBillCatchUp (B2-04zg: createSettleCatchUpStore(db), ports.config; the first tick is
   * the worker's self-heal) and scanDueBatches with the injected Clock, a failure logged and not
   * thrown. A deferred bill (asset snapshot not complete) completes its delivery; the catch-up sends
   * the period again on a later tick. On destroy the timer stops and a tick in flight is
   * awaited: nothing is sent once the module is closed. Without a database or queue nothing is
   * registered and no timer runs.
   */
  static forWorker(ports: SettlementWorkerPorts): DynamicModule {
    return {
      module: SettlementModule,
      providers: [
        {
          provide: SETTLE_WORKER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
            crypto?: FieldCrypto,
            events?: EventBus,
          ): SettleWorkerLifecycle => {
            if (
              db === undefined ||
              queue === undefined ||
              crypto === undefined ||
              events === undefined
            ) {
              logger.info({ queue: SETTLE_QUEUE }, 'settle_worker_disabled');
              return inertLifecycle();
            }
            const workerLogger = logger.child({ module: 'settlement', queue: SETTLE_QUEUE });
            queue.register(
              SETTLE_QUEUE,
              createSettleWorkerHandler(ports, {
                db,
                clock,
                queue,
                crypto,
                events,
                logger: workerLogger,
              }),
            );
            const timer = createSettleWorkerTimer(ports, {
              db,
              clock,
              queue,
              logger: workerLogger,
            });
            return {
              onApplicationBootstrap: () => timer.start(),
              onModuleDestroy: () => timer.stop(),
            };
          },
        },
      ],
    };
  }
}

/**
 * B2-09d: the settlement console's monthly bill reads on the admin entry (settle.bill or
 * fund.view, read only, no audit). B2-09f: the five writes (settle.bill, step-up totp): the batch
 * commands and the supplement launch, each with its audit record on the same transaction. Without
 * B2-09g: POST /admin/v1/recon-diffs/{recon_diff_id}/restore (order.restore, step-up totp): the
 * account-appeal restore of BR-FUND-22 ③. Without a database (or, for the writes, idempotency; for
 * the restore also the field cipher, which D10-482's minor check needs) the routes register and
 * fail closed.
 * B2-04zr: the union collection records (fund.cash_entry, step-up totp; fund.view for the list),
 * with the same fail-closed rule.
 */
export class SettlementAdminModule {
  static forAdmin(
    ports: AdminSettleCommandPorts & AdminReconRestorePorts & AdminUnionReceiptPorts,
  ): DynamicModule {
    return {
      module: SettlementAdminModule,
      controllers: [
        AdminSettleBillsController,
        AdminSettleCommandsController,
        AdminReconRestoreController,
        AdminUnionReceiptsController,
      ],
      providers: [
        {
          provide: ADMIN_SETTLE_BILL_READS,
          inject: [CLOCK, { token: DB_TOKEN, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<DB>): AdminSettleBillReadDeps | null =>
            db === undefined ? null : { db, now: () => clock.now() },
        },
        {
          provide: ADMIN_SETTLE_COMMANDS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
          ): AdminSettleCommandDeps | null =>
            db === undefined || idempotency === undefined
              ? null
              : createAdminSettleCommandDeps(ports, {
                  db,
                  clock,
                  idempotency,
                  logger: logger.child({ module: 'settlement' }),
                }),
        },
        {
          provide: ADMIN_RECON_RESTORE,
          inject: [
            CLOCK,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
            eventBus?: EventBus,
            crypto?: FieldCrypto,
          ): RestoreAdminReconDiffDeps | null =>
            db === undefined ||
            idempotency === undefined ||
            eventBus === undefined ||
            crypto === undefined
              ? null
              : {
                  clock,
                  idempotency,
                  auditOn: (trx) => ports.auditWriter(trx, clock),
                  gate: createBeneficiaryGate({
                    clock,
                    lockUsers: ports.lockUsers,
                    deletionStatus: ports.deletionStatus(db),
                    realnameStatus: ports.realnameStatus(db),
                    riskState: ports.riskState(db),
                    minors: ports.minors(crypto),
                  }),
                  readRestoreSnapshot: ports.readRestoreSnapshot,
                  appendBeneficiaryEvent: ports.appendBeneficiaryEvent,
                  ledger: ports.ledger({ clock, eventBus }),
                },
        },
        {
          provide: ADMIN_UNION_RECEIPTS,
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
          ): AdminUnionReceiptDeps | null =>
            db === undefined || idempotency === undefined || eventBus === undefined
              ? null
              : { db, clock, idempotency, eventBus, ports },
        },
      ],
    };
  }
}
