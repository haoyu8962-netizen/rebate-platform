import type { DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  EVENT_BUS,
  IDEMPOTENCY,
  JOB_QUEUE,
  type AuditPort,
  type Clock,
  type EventBus,
  type Idempotency,
  type JobQueue,
} from '../platform/index.ts';
import type {
  CloseAdminReconDiffDeps,
  ReconDiffHoldRelease,
} from './application/admin-recon-diff-close.ts';
import type {
  ReconDiffWriteOff,
  WriteOffAdminReconDiffDeps,
} from './application/admin-recon-diff-write-off.ts';
import {
  AdminReconDiffWriteOffController,
  RECON_DIFF_WRITE_OFF_DEPS,
} from './http/admin/recon-diff-write-off.controller.ts';
import { BalanceRecoveredHook, createLedger } from './application/recovered-ledger.ts';
import type { Ledger } from './application/reverse.ts';
import {
  ASSET_SNAPSHOT_READ_DB,
  AdminAssetSnapshotsController,
} from './http/admin/asset-snapshots.controller.ts';
import {
  ADMIN_FUND_LEDGER,
  AdminFundLedgerController,
} from './http/admin/fund-ledger.controller.ts';
import type { AdminFundLedgerDeps } from './application/admin-fund-ledger.ts';
import {
  AdminReconDiffCloseController,
  RECON_DIFF_CLOSE_DEPS,
} from './http/admin/recon-diff-close.controller.ts';
import {
  AdminReconDiffsController,
  RECON_DIFF_READ_DB,
} from './http/admin/recon-diffs.controller.ts';
import type {
  AdminAdjustmentCreateDeps,
  AdminAdjustmentPorts,
  AdminAdjustmentReadDeps,
} from './application/admin-adjustment.ts';
import {
  ADJUSTMENT_CREATE_DEPS,
  ADJUSTMENT_READ_DEPS,
  AdminAdjustmentsController,
} from './http/admin/adjustments.controller.ts';

/** Nest injection token for the process ledger (the Clock-backed posting port, with the optional event bus and recovery port). */
export const LEDGER = Symbol('LEDGER');

/**
 * The ledger port over the process Clock. It holds no database handle: every call runs on the
 * caller's handle or transaction, so the module needs nothing at startup.
 */
export class LedgerModule {
  static forRoot(): DynamicModule {
    return {
      module: LedgerModule,
      providers: [
        {
          provide: LEDGER,
          // EVENT_BUS exists only where the entry has a database (PlatformModule); entries
          // without one cannot post, so the bus is optional here like DB elsewhere.
          // BALANCE_RECOVERED_HOOK is provided by payout where it runs (BR-WDR-05 (a));
          // elsewhere it is absent and recovery calls nothing.
          inject: [
            CLOCK,
            { token: EVENT_BUS, optional: true },
            { token: BalanceRecoveredHook, optional: true },
          ],
          useFactory: (
            clock: Clock,
            eventBus: EventBus | undefined,
            balanceRecoveredHook: BalanceRecoveredHook | undefined,
          ): Ledger =>
            createLedger({
              clock,
              ...(eventBus === undefined ? {} : { eventBus }),
              ...(balanceRecoveredHook === undefined ? {} : { balanceRecoveredHook }),
            }),
        },
      ],
      exports: [LEDGER],
    };
  }
}

/** B2-09b: what app.module hands in for the close (ledger imports neither admin nor payout). */
export interface LedgerAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** payout's release of the holds whose source is the diff (its single writer of withdraw_holds). */
  readonly holdRelease: (clock: Clock) => ReconDiffHoldRelease;
  /**
   * B2-07e: payout's W11 over the entry's handle, clock, job queue and event bus (the port the
   * write-off of an R2 payer-side difference calls; payout is the single writer of withdrawals).
   */
  readonly writeOff: (context: {
    readonly db: Kysely<Database>;
    readonly clock: Clock;
    readonly queue: JobQueue;
    readonly eventBus: EventBus;
  }) => ReconDiffWriteOff;
  /** B2-04zs: payout's water level of the enterprise Alipay channel. */
  readonly waterLevel: AdminFundLedgerDeps['waterLevel'];
  /** B2-04zs: admin's createAdminDisplayNameReader. */
  readonly adminNames: AdminFundLedgerDeps['adminNames'];
  /**
   * B2-12c: the manual adjustments' ledger (the entry's event bus and payout's recovery hook,
   * D10-587) and the other modules' ports (identity, payout, orders, notification).
   */
  readonly adjustments: {
    readonly ledger: (context: { readonly clock: Clock; readonly eventBus: EventBus }) => Ledger;
    readonly ports: AdminAdjustmentPorts;
  };
}

/**
 * B2-09a: the admin entry's R1–R3 recon diff reads (GET /admin/v1/recon-diffs and its detail),
 * guarded through platform's AdminOperationGuard and read on the primary handle. B2-09b: the close
 * (POST /admin/v1/recon-diffs/{recon_diff_id}/close, fund.recon) under platform idempotency, with
 * payout's hold release and admin's audit writer on the closing transaction. B2-09e: the daily
 * asset snapshot list (GET /admin/v1/asset-snapshots, fund.view, read only). B2-04zs: the fund
 * ledger overview (GET /admin/v1/fund-ledger, fund.view, read only). Without the database
 * the routes still register and fail closed (50001).
 */
export class LedgerAdminModule {
  static forAdmin(options: LedgerAdminOptions): DynamicModule {
    return {
      module: LedgerAdminModule,
      controllers: [
        AdminReconDiffsController,
        AdminReconDiffCloseController,
        AdminAssetSnapshotsController,
        AdminReconDiffWriteOffController,
        AdminFundLedgerController,
        AdminAdjustmentsController,
      ],
      providers: [
        // B2-12c: the adjustment reads (fund.adjust or fund.view, read only) on the primary
        // handle, the balance preview through the entry's plain ledger read.
        {
          provide: ADJUSTMENT_READ_DEPS,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): AdminAdjustmentReadDeps | null =>
            db === undefined
              ? null
              : {
                  db,
                  clock,
                  ledger: createLedger({ clock }),
                  userStatus: options.adjustments.ports.userStatus,
                },
        },
        // B2-12c: the one-step submission (fund.adjust, step-up sms, platform idempotency): the
        // form, its ADMIN_ADJUST voucher on the ledger with the bus and the recovery hook, the
        // audit record (admin's writer bound to the transaction) and the in-app message commit
        // together. Without the database, the bus or idempotency the route fails closed (50001).
        {
          provide: ADJUSTMENT_CREATE_DEPS,
          inject: [
            CLOCK,
            { token: DB, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<Database>,
            idempotency?: Idempotency,
            eventBus?: EventBus,
          ): AdminAdjustmentCreateDeps | null =>
            db === undefined || idempotency === undefined || eventBus === undefined
              ? null
              : {
                  db,
                  clock,
                  idempotency,
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  ledger: options.adjustments.ledger({ clock, eventBus }),
                  ports: options.adjustments.ports,
                },
        },
        {
          provide: RECON_DIFF_READ_DB,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): Kysely<Database> | null => db ?? null,
        },
        {
          provide: ADMIN_FUND_LEDGER,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): AdminFundLedgerDeps | null =>
            db === undefined
              ? null
              : { db, clock, waterLevel: options.waterLevel, adminNames: options.adminNames },
        },
        {
          provide: ASSET_SNAPSHOT_READ_DB,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): Kysely<Database> | null => db ?? null,
        },
        {
          provide: RECON_DIFF_CLOSE_DEPS,
          inject: [CLOCK, { token: DB, optional: true }, { token: IDEMPOTENCY, optional: true }],
          useFactory: (
            clock: Clock,
            db?: Kysely<Database>,
            idempotency?: Idempotency,
          ): CloseAdminReconDiffDeps | null =>
            db === undefined || idempotency === undefined
              ? null
              : {
                  db,
                  clock,
                  idempotency,
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  holds: options.holdRelease(clock),
                },
        },
        // B2-07e: the write-off (payout.execute, step-up totp, platform idempotency): payout's W11
        // on the write-off transaction (voucher, attempt-append job, wallet event), the diff row,
        // the hold release and the recon_diff_write_off audit row commit together. Without the
        // database, the queue, the event bus or idempotency the route fails closed (50001).
        {
          provide: RECON_DIFF_WRITE_OFF_DEPS,
          inject: [
            CLOCK,
            { token: DB, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<Database>,
            idempotency?: Idempotency,
            queue?: JobQueue,
            eventBus?: EventBus,
          ): WriteOffAdminReconDiffDeps | null =>
            db === undefined ||
            idempotency === undefined ||
            queue === undefined ||
            eventBus === undefined
              ? null
              : {
                  db,
                  clock,
                  idempotency,
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  holds: options.holdRelease(clock),
                  writeOff: options.writeOff({ db, clock, queue, eventBus }),
                },
        },
      ],
    };
  }
}
