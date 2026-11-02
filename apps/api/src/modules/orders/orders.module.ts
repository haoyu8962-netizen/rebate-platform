// B1-08l: the api entry's orders assembly — the shared OrderQueries provider (class token, also
// what B3-08 will inject) and the /v1/orders controller. Other modules' readers come in as
// factories from app.module (content's configuration reader, linking's order-link reader), so
// this module imports no other module's implementation. Without a database the queries fail
// closed on first use; module startup never touches the database handle.
// B1-09p: settlement's figures reader (options.figures, a factory from app.module) joins the shared
// OrderQueries, so the order amounts, credit period and derived status are real on this entry.
// B1-08n: forWorker — the worker entry's order-sync runtime (worker-runtime.ts) under
// orderSyncToken(); identity's and linking's readers come in as factories from app.module.
// B1-08m: the shared PendingTracks provider (class token) and the /v1/orders/pending-tracks
// controller, over linking's open-attempt port (factory from app.module, like the link reader).
// B1-10b: the /v1/orders/claims controller over the claim ports (ORDER_CLAIM_DEPS: the database,
// REDIS when the entry has it, content's reader); null without a database (both routes 50001).
// B1-10c: the claim evidence ports (options.evidence, a factory over the acceptance transaction)
// join the claim ports, so a submission settles its evidence in the same transaction.
// B1-10h: linking's claim-entry reader (options.claimEntry, a factory from app.module) joins the
// shared OrderQueries, so GET /v1/orders?scope=self carries claim_entry_pinned (BR-ATTR-17).
// B1-08w: forWorker also takes commission's snapshot port (options.snapshots, a factory from
// app.module over the worker's DB, CLOCK and ROOT_LOGGER), built once when the runtime is and
// passed as the runtime's own snapshots dependency (not among the read ports): step ⑥ and the
// B1-08t compensation retry then run in production. Not built when the runtime is disabled.
// B1-09n: options.rebate and options.blocklist reach the runtime among its read ports, and likewise
// are only called when the runtime is built.
import { Module, type DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../content/index.ts';
import type { ClaimEntryReader, PendingAttemptStore } from '../linking/index.ts';
import {
  CLOCK,
  DB,
  EVENT_BUS,
  JOB_QUEUE,
  REDIS,
  ROOT_LOGGER,
  type Clock,
  type EventBus,
  type QueueRuntime,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import {
  UNION_ENDPOINTS,
  UNION_REGISTRY,
  type UnionEndpoint,
  type UnionRegistry,
} from '../union/index.ts';
import {
  OrderQueries,
  createOrderQueries,
  type OrderFiguresReader,
  type OrderLinkReader,
} from './application/order-queries.ts';
import type { OrderClaimDeps } from './application/order-claims.ts';
import type { ClaimEvidenceFactory } from './application/claim-evidence.ts';
import { PendingTracks, createPendingTracks } from './application/pending-tracks.ts';
import { ORDER_SYNC_QUEUE } from './application/sync-scheduler.ts';
import type { CommissionSnapshotPort } from './application/commission-snapshot-step.ts';
import { ORDER_CLAIM_DEPS, OrderClaimsController } from './http/public/order-claims.controller.ts';
import { OrdersController } from './http/public/orders.controller.ts';
import { PendingTracksController } from './http/public/pending-tracks.controller.ts';
import {
  createOrderSyncRuntime,
  orderSyncToken,
  type OrderSyncReadPorts,
  type OrderSyncRuntime,
} from './worker-runtime.ts';

export interface OrdersModuleOptions {
  /**
   * B1-10h: linking's claim-entry reader (link_logs jump-outs, union_bindings) behind listOrders'
   * claim_entry_pinned. app.module always gives it; without it scope=self pages leave the field out.
   */
  readonly claimEntry?: (db: Kysely<Database>) => ClaimEntryReader;
  /**
   * B1-10c: the claim evidence ports over the acceptance transaction (linking's raw reads, the
   * product-key derivation over catalog's platforms). app.module always gives it; optional only
   * so that a module built without it keeps B1-10b's submitted claims.
   */
  readonly evidence?: ClaimEvidenceFactory;
  /**
   * B1-09p: settlement's order figures over ledger, commission, risk and content. app.module always
   * gives it; without it the amounts stay unknown, for module tests only.
   */
  readonly figures?: (db: Kysely<Database>, clock: Clock) => OrderFiguresReader;
  /** content's ContentReader over the primary handle (order.user_query_months, credit.enabled.*). */
  readonly config: (db: Kysely<Database>, clock: Clock) => ContentReader;
  /** linking's order-link reader (links.product_key by app_id and link_id). */
  readonly links: (db: Kysely<Database>) => OrderLinkReader;
  /** linking's open-attempt port (link_open_attempts: read, dismissed_at write). */
  readonly attempts: (db: Kysely<Database>) => PendingAttemptStore;
}

/** The worker's order-sync ports (B1-08n), assembled by app.module. */
export interface OrdersWorkerOptions extends OrderSyncReadPorts {
  /** union's module instance of this entry (UNION_ENDPOINTS, UNION_REGISTRY). */
  readonly union: DynamicModule;
  /**
   * B1-08w: commission's snapshot port (createCommissionSnapshot over the B2-03p beneficiary
   * resolver), assembled by app.module. Called once per runtime, only when the runtime is built
   * (database, job queue and event bus present); building it reads nothing. The same object goes
   * to the attribution pipeline, the update step and the compensation retry scan.
   */
  readonly snapshots: (
    db: Kysely<Database>,
    clock: Clock,
    logger: RootLogger,
  ) => CommissionSnapshotPort;
}

export class OrdersModule {
  static forRoot(options: OrdersModuleOptions): DynamicModule {
    return {
      module: OrdersModule,
      // The static /v1/orders/pending-tracks and /v1/orders/claims routes are matched before
      // /v1/orders/:order_id by Fastify's router whatever the order; listing them first keeps
      // that obvious.
      controllers: [PendingTracksController, OrderClaimsController, OrdersController],
      providers: [
        {
          provide: ORDER_CLAIM_DEPS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            redis?: RedisHandle,
          ): OrderClaimDeps | null =>
            db === undefined
              ? null
              : {
                  db,
                  clock,
                  logger,
                  config: options.config(db, clock),
                  ...(redis === undefined ? {} : { redis }),
                  ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
                },
        },
        {
          provide: OrderQueries,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): OrderQueries =>
            db === undefined
              ? new OrderQueries()
              : createOrderQueries({
                  db,
                  clock,
                  config: options.config(db, clock),
                  links: options.links(db),
                  ...(options.figures === undefined ? {} : { figures: options.figures(db, clock) }),
                  ...(options.claimEntry === undefined
                    ? {}
                    : { claimEntry: options.claimEntry(db) }),
                }),
        },
        {
          provide: PendingTracks,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): PendingTracks =>
            db === undefined
              ? new PendingTracks()
              : createPendingTracks({
                  db,
                  clock,
                  config: options.config(db, clock),
                  attempts: options.attempts(db),
                }),
        },
      ],
      exports: [OrderQueries, PendingTracks],
    };
  }

  /**
   * B1-08n: the worker entry's order sync. orderSyncToken() provides the runtime of
   * createOrderSyncRuntime (handler registered on `order-sync`, scheduler built but not started);
   * entry.ts starts it after the queue runs. Without a database handle, the job queue or the
   * event bus the token provides null and one info line `order_sync_disabled` is logged; nothing
   * is registered and the snapshot port is not built. Assembly runs no query, sends no job and
   * arms no timer. B1-08w: with the snapshot port, start() also arms the compensation scan.
   */
  static forWorker(options: OrdersWorkerOptions): DynamicModule {
    const { union, snapshots, ...ports } = options;
    return {
      module: OrdersModule,
      imports: [union],
      providers: [
        {
          provide: orderSyncToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            UNION_ENDPOINTS,
            UNION_REGISTRY,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            endpoints: readonly UnionEndpoint[],
            registry: UnionRegistry,
            db?: Kysely<Database> | null,
            queue?: QueueRuntime | null,
            events?: EventBus | null,
          ): OrderSyncRuntime | null => {
            if (db == null || queue == null || events == null) {
              logger.info({ queue: ORDER_SYNC_QUEUE }, 'order_sync_disabled');
              return null;
            }
            return createOrderSyncRuntime({
              db,
              clock,
              logger,
              queue,
              events,
              endpoints,
              registry,
              ports,
              snapshots: snapshots(db, clock, logger),
            });
          },
        },
      ],
      exports: [orderSyncToken()],
    };
  }
}

Module({})(OrdersModule);
