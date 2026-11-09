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
  registerEventConsumer,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import {
  createOrderAppealRestoreHandler,
  type OrderAppealRestoreConsumer,
} from './application/order-appeal-restore.ts';
import type {
  AdminReconRestorePorts,
  RestoreAdminReconDiffDeps,
} from './application/admin-recon-restore.ts';
import type { AdminSettleBillReadDeps } from './application/admin-settle-bills.ts';
import {
  BLACKLIST_AFTER_CREDIT_CONSUMER,
  createBlacklistAfterCreditHandler,
  type AdminBlacklistClawbackPorts,
  type BlacklistClawbackDeps,
} from './application/blacklist-clawback.ts';
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
  ADMIN_BLACKLIST_CLAWBACK,
  AdminBlacklistClawbackController,
} from './http/admin/blacklist-clawback.controller.ts';
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
import type { AdminSettleAdjustRunDeps } from './adjust/admin-run.ts';
import type { AdminSettleAdjustPorts, SettleAdjustDecisionDeps } from './adjust/approve.ts';
import { getOrderNets } from '../ledger/index.ts';
import { createBeneficiaryGate } from './credit/beneficiary-gate.ts';
import {
  ADMIN_SETTLE_ADJUST_RUNS,
  AdminSettleAdjustRunsController,
} from './http/admin/settle-adjust-runs.controller.ts';
import {
  ADMIN_SETTLE_ADJUSTMENTS,
  AdminSettleAdjustmentsController,
} from './http/admin/settle-adjustments.controller.ts';
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
/** The consumer of order.blacklist_hit_after_credit on the worker entry (registered at build). */
const BLACKLIST_AFTER_CREDIT_WORKER = Symbol('SETTLEMENT_BLACKLIST_AFTER_CREDIT_WORKER');
const ORDER_APPEAL_RESTORE_CONSUMER_TOKEN = Symbol('SETTLEMENT_ORDER_APPEAL_RESTORE_CONSUMER');
const ORDER_APPEAL_RESTORE_CONSUMER: OrderAppealRestoreConsumer = 'settlement-order-appeal-restore';

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
   * B2-04zzl: options.blacklistReview (only app.module's worker entry passes true) also registers
   * the consumer of order.blacklist_hit_after_credit; left out, the module registers the settle
   * queue alone.
   * B2-09gd (D10-1178): options.orderAppealRestore, the same way, registers the consumer of
   * appeal.resolved for revoked order appeals.
   */
  static forWorker(
    ports: SettlementWorkerPorts,
    options?: { blacklistReview?: boolean; orderAppealRestore?: boolean },
  ): DynamicModule {
    return {
      module: SettlementModule,
      providers: [
        ...(options?.blacklistReview === true
          ? [
              {
                // B2-04zzl (BR-ATTR-26): the manual review difference of a credited blacklist hit.
                provide: BLACKLIST_AFTER_CREDIT_WORKER,
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
                ): boolean => {
                  if (db === undefined || queue === undefined) {
                    logger.info(
                      { consumer: BLACKLIST_AFTER_CREDIT_CONSUMER },
                      'blacklist_review_disabled',
                    );
                    return false;
                  }
                  const consumerLogger = logger.child({ module: 'settlement' });
                  registerEventConsumer(queue, {
                    consumer: BLACKLIST_AFTER_CREDIT_CONSUMER,
                    db,
                    logger: consumerLogger,
                    handler: createBlacklistAfterCreditHandler({ clock, logger: consumerLogger }),
                  });
                  return true;
                },
              },
            ]
          : []),
        ...(options?.orderAppealRestore === true
          ? [
              {
                // B2-09gd: appeal.resolved → the restore difference of a revoked order appeal.
                provide: ORDER_APPEAL_RESTORE_CONSUMER_TOKEN,
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
                ): boolean => {
                  if (db === undefined || queue === undefined) {
                    logger.info(
                      { consumer: ORDER_APPEAL_RESTORE_CONSUMER },
                      'order_appeal_restore_disabled',
                    );
                    return false;
                  }
                  registerEventConsumer(queue, {
                    consumer: ORDER_APPEAL_RESTORE_CONSUMER,
                    db,
                    logger,
                    handler: createOrderAppealRestoreHandler({
                      clock,
                      logger: logger.child({ consumer: ORDER_APPEAL_RESTORE_CONSUMER }),
                    }),
                  });
                  return true;
                },
              },
            ]
          : []),
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
 * B2-09zb: POST /admin/v1/settle-adjust-runs (fund.settle_adjust, step-up totp): finance's manual
 * trigger of the positive-difference candidate run (queues the settle_adjust job, one audit record);
 * without a database, idempotency or the job queue it registers and fails closed.
 * B2-09zc: the 补差批次 list (fund.settle_adjust or fund.view) and the batch approval / rejection
 * (fund.settle_adjust, step-up totp); without a database, idempotency, the event bus or the field
 * cipher they register and fail closed.
 * B2-04zzl: POST /admin/v1/recon-diffs/{recon_diff_id}/blacklist-clawback (order.blacklist_clawback,
 * step-up totp): the confirmed clawback of BR-ATTR-26; without a database, idempotency, the event
 * bus or the field cipher it registers and fails closed.
 */
export class SettlementAdminModule {
  static forAdmin(
    ports: AdminSettleCommandPorts &
      AdminReconRestorePorts &
      AdminBlacklistClawbackPorts &
      AdminUnionReceiptPorts &
      AdminSettleAdjustPorts,
  ): DynamicModule {
    return {
      module: SettlementAdminModule,
      controllers: [
        AdminSettleBillsController,
        AdminSettleCommandsController,
        AdminReconRestoreController,
        AdminBlacklistClawbackController,
        AdminUnionReceiptsController,
        AdminSettleAdjustRunsController,
        AdminSettleAdjustmentsController,
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
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
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
                  logger: logger.child({ module: 'settlement' }),
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
                  restoreSnapshot: ports.restoreSnapshot(db, clock, logger),
                  appendBeneficiaryEvent: ports.appendBeneficiaryEvent,
                  ledger: ports.ledger({ clock, eventBus }),
                },
        },
        {
          provide: ADMIN_BLACKLIST_CLAWBACK,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
            eventBus?: EventBus,
            crypto?: FieldCrypto,
          ): BlacklistClawbackDeps | null => {
            if (
              db === undefined ||
              idempotency === undefined ||
              eventBus === undefined ||
              crypto === undefined
            ) {
              return null;
            }
            const child = logger.child({ module: 'settlement' });
            return {
              clock,
              logger: child,
              idempotency,
              auditOn: (trx) => ports.auditWriter(trx, clock),
              clawback: ports.blacklistClawback(
                { db, clock, logger: child, events: eventBus },
                crypto,
              ),
              config: ports.config(db, clock),
            };
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
        {
          provide: ADMIN_SETTLE_ADJUST_RUNS,
          inject: [
            CLOCK,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
            queue?: QueueRuntime,
          ): AdminSettleAdjustRunDeps | null =>
            db === undefined || idempotency === undefined || queue === undefined
              ? null
              : {
                  clock,
                  idempotency,
                  queue,
                  auditOn: (trx) => ports.auditWriter(trx, clock),
                },
        },
        {
          provide: ADMIN_SETTLE_ADJUSTMENTS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
            eventBus?: EventBus,
            crypto?: FieldCrypto,
          ): SettleAdjustDecisionDeps | null => {
            if (
              db === undefined ||
              idempotency === undefined ||
              eventBus === undefined ||
              crypto === undefined
            ) {
              return null;
            }
            const phones = ports.maskedPhones(db, crypto);
            return {
              db,
              clock,
              logger: logger.child({ module: 'settlement' }),
              idempotency,
              ledger: ports.ledger({ clock, eventBus }),
              gate: createBeneficiaryGate({
                clock,
                lockUsers: ports.lockUsers,
                deletionStatus: ports.deletionStatus(db),
                realnameStatus: ports.realnameStatus(db),
                riskState: ports.riskState(db),
                minors: ports.minors(crypto),
              }),
              readSnapshot: ports.readSnapshot,
              readOrderNets: getOrderNets,
              auditOn: (trx) => ports.auditWriter(trx, clock),
              appendBeneficiaryEvent: (trx, input) => ports.appendShareEvent(trx, input, { clock }),
              maskedPhones: (appId, userIds) => phones.maskedPhones(appId, userIds),
            };
          },
        },
      ],
    };
  }
}
