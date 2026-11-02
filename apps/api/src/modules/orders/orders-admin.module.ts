// B1-10j: orders' /admin/v1 routes, the read side of the console's claim review (GET
// /admin/v1/claims, GET /admin/v1/claims/{claim_id}) and, B1-10i, the console's order list and
// detail (GET /admin/v1/orders, GET /admin/v1/orders/{order_id}) and, B1-09i, the manual order
// sync (POST / GET /admin/v1/order-syncs, GET /admin/v1/order-syncs/limits) and, B1-10m, the write
// side: claim item approve / reject and order hold / unhold / reassign and, B1-10n, the Excel import
// tasks (POST / GET /admin/v1/rights-imports, GET /admin/v1/rights-imports/{import_id}). app.module
// imports this module on the admin entry only; the api and stream entries do not serve /admin/v1. Permission checks go through
// platform's AdminOperationGuard, which the admin module provides on the admin entry (orders never
// imports admin). Other modules' reads (identity's masked phones, admin's reviewer names,
// linking's link_logs time and scene) come in as one factory from app.module, so this module
// imports no other module's implementation. Without a database the routes still register and
// every read fails closed (50001); module startup never touches the database handle.
import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  EVENT_BUS,
  FIELD_CRYPTO,
  JOB_QUEUE,
  ROOT_LOGGER,
  createImportStore,
  type AppConfig,
  type AuditPort,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type JobQueue,
  type RootLogger,
} from '../platform/index.ts';
import { createUnionSyncAccess } from '../union/index.ts';
import { createManualOrderSyncs, type ManualOrderSyncs } from './application/manual-sync.ts';
import { manualSyncLimits } from './domain/manual-sync.ts';
import {
  AdminOrderSyncsController,
  MANUAL_ORDER_SYNCS,
} from './http/admin/order-syncs.controller.ts';
import type {
  AdminAssignRebatePort,
  AdminAssignTargetReaders,
} from './application/admin-assign.ts';
import { AdminClaims, type AdminClaimPorts } from './application/admin-claims.ts';
import { AdminOrders, type AdminOrderPorts } from './application/admin-orders.ts';
import type { ClaimReviewDeps } from './application/claim-review.ts';
import type { CommissionSnapshotPort } from './application/commission-snapshot-step.ts';
import type { RightsImportDeps } from './application/rights-imports.ts';
import type { OrderRightsPorts } from './application/rights-ports.ts';
import type { OrderSourcePorts } from './application/source-backfill.ts';
import { AdminClaimReviewController } from './http/admin/claim-review.controller.ts';
import { AdminClaimsController } from './http/admin/claims.controller.ts';
import { AdminOrderActionsController } from './http/admin/order-actions.controller.ts';
import { AdminOrdersController } from './http/admin/orders.controller.ts';
import {
  ADMIN_RIGHTS_IMPORTS,
  AdminRightsImportsController,
} from './http/admin/rights-imports.controller.ts';
import { ADMIN_WRITE_DEPS, type AdminWriteDeps } from './http/admin/write-deps.ts';
import { createAdminClaimReads } from './infra/admin-claim-reads.ts';
import { createAdminOrderReads } from './infra/admin-order-reads.ts';

/** B1-10m: the other modules' real ports of the console's order and claim writes. */
export interface AdminOrderWritePorts {
  /** admin's audit writer bound to the write's transaction. */
  readonly auditOn: (trx: Transaction<Database>) => AuditPort;
  /** settlement's attribution port: R3 / R3b write locked and rebate_status. */
  readonly attribution: ClaimReviewDeps['rebate'] & AdminAssignRebatePort;
  /** settlement's rebate.adminHold / adminUnhold. */
  readonly hold: OrderRightsPorts;
  /** risk's state and identity's deletion stage of an assignment's target. */
  readonly targets: AdminAssignTargetReaders;
  /** admin: the permission keys the account holds in the app. */
  readonly permissions: (appId: string, adminId: string) => Promise<readonly string[]>;
  readonly snapshots: CommissionSnapshotPort;
  /** The source ports on the attribution's transaction: it never waits for a second connection. */
  readonly sourcesOn: (trx: Transaction<Database>) => OrderSourcePorts;
  /**
   * The scene of the order's promotion slot, whatever the slot's status (BR-ATTR-02), on the
   * attribution's transaction.
   */
  readonly pidSceneOn: (
    trx: Transaction<Database>,
  ) => (order: Selectable<Database['orders']>) => Promise<string | null>;
}

export interface OrdersAdminOptions {
  /** identity's masked phones, admin's reviewer names and linking's link_logs moments. */
  readonly ports: (db: Kysely<Database>, crypto: FieldCrypto | null) => AdminClaimPorts;
  /**
   * B1-10i: identity's masked phones, admin's latest manual hold audit and display names,
   * commission's snapshot, linking's link_logs of a link and content's credit.enabled.
   */
  readonly orderPorts: (
    db: Kysely<Database>,
    crypto: FieldCrypto | null,
    clock: Clock,
  ) => AdminOrderPorts;
  /** B1-10m: building them reads nothing. */
  readonly writePorts: (
    db: Kysely<Database>,
    clock: Clock,
    logger: RootLogger,
  ) => AdminOrderWritePorts;
}

export class OrdersAdminModule {
  static forAdmin(options: OrdersAdminOptions): DynamicModule {
    return {
      module: OrdersAdminModule,
      controllers: [
        AdminClaimsController,
        AdminClaimReviewController,
        AdminOrdersController,
        AdminOrderActionsController,
        AdminOrderSyncsController,
        AdminRightsImportsController,
      ],
      providers: [
        {
          provide: AdminClaims,
          inject: [
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (db?: Kysely<Database>, crypto?: FieldCrypto): AdminClaims =>
            db === undefined
              ? new AdminClaims()
              : new AdminClaims({
                  reads: createAdminClaimReads(db),
                  ...options.ports(db, crypto ?? null),
                }),
        },
        {
          provide: AdminOrders,
          inject: [CLOCK, { token: DB, optional: true }, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>, crypto?: FieldCrypto): AdminOrders =>
            db === undefined
              ? new AdminOrders()
              : new AdminOrders({
                  reads: createAdminOrderReads(db),
                  ...options.orderPorts(db, crypto ?? null, clock),
                }),
        },
        {
          provide: ADMIN_WRITE_DEPS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
            events?: EventBus,
          ): AdminWriteDeps | null => {
            if (db === undefined || events === undefined) return null;
            const ports = options.writePorts(db, clock, logger);
            const write = { db, clock, auditOn: ports.auditOn };
            const attribution = {
              ...write,
              events,
              rebate: ports.attribution,
              snapshots: ports.snapshots,
              sourcesOn: ports.sourcesOn,
              pidSceneOn: ports.pidSceneOn,
            };
            const details = options.orderPorts(db, crypto ?? null, clock);
            return {
              claims: { ...attribution, details: options.ports(db, crypto ?? null) },
              hold: { ...write, permissions: ports.permissions, ports: ports.hold, details },
              assign: { ...attribution, targets: ports.targets, details },
            };
          },
        },
        {
          // B1-10n: the import tasks. Building the store reads nothing; where it has no backend
          // (staging / prod before B1-30) every put fails, so an upload rolls back to a 50001.
          provide: ADMIN_RIGHTS_IMPORTS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            APP_CONFIG,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            config: AppConfig,
            db?: Kysely<Database>,
            queue?: JobQueue,
          ): RightsImportDeps | null =>
            db === undefined || queue === undefined
              ? null
              : {
                  db,
                  clock,
                  queue,
                  logger,
                  store: createImportStore({ appEnv: config.appEnv, logger }),
                  auditOn: options.writePorts(db, clock, logger).auditOn,
                },
        },
        {
          // B1-09i: the console's manual sync. union's sync access on the admin entry has no
          // governed adapter, so its offline breaker reads closed here (the breaker lives in the
          // worker process only); the worker's handler checks the real breaker and the site
          // authorization when it takes each job and fails the request instead of fetching.
          provide: MANUAL_ORDER_SYNCS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            queue?: JobQueue,
            crypto?: FieldCrypto,
          ): ManualOrderSyncs => {
            if (db === undefined || queue === undefined) return unavailableManualSyncs(clock);
            const names = options.orderPorts(db, crypto ?? null, clock).adminNames;
            return createManualOrderSyncs({
              db,
              clock,
              queue,
              access: createUnionSyncAccess({
                db,
                clock,
                endpoints: [],
                breaker: () => 'closed',
                logger,
              }),
              adminNames: names,
              logger,
            });
          },
        },
      ],
    };
  }
}

/** Without a database or a queue the routes register; create and list fail closed (50001). */
function unavailableManualSyncs(clock: Clock): ManualOrderSyncs {
  const fail = async (): Promise<never> => {
    throw new Error('orders: manual sync needs the database and the queue');
  };
  return {
    create: fail,
    list: fail,
    limits: () => ({ items: manualSyncLimits(clock.now()).map((item) => ({ ...item })) }),
  };
}

Module({})(OrdersAdminModule);
