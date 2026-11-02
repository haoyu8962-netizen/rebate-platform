// B2-15b / B2-15c: the payment module on the api entry (task B2-15b §9.1: the four /v1/pay/orders
// routes over the pay order use cases; B2-15c §9.1: the notification entry POST
// /notify/pay/<channel>), on the worker entry (B2-15c: the handler of queue `pay`; B2-15e adds
// refund.query) and, from B2-15e, on the admin entry (the console's original-route refund,
// http/admin/, over platform idempotency and admin's audit writer handed in by app.module; B2-15f
// adds the pay reads and the manual settlement of a needs_manual pay order there).
// app.module hands in content's configuration reader as a factory, so this module imports no other
// module's implementation but ledger's posting port (LedgerModule, index.ts); the business type
// registry follows APP_ENV (prod registers nothing); the channel set comes from createPayChannelSet
// (B2-15k: fake channels in local / test or with PAY_CHANNEL_IMPL=fake, a real adapter with complete
// credentials, otherwise an unavailable channel that fails closed, payment/AGENTS.md rule 6). Without a database or job queue the pay order use cases are not assembled and the
// routes fail closed (50001).
// The notification entry exists only in a process with a database (`notifyEntry`): it is outside
// the client contract and, without a database, the queue and the field cipher, nothing of a
// notification could be verified against an order or kept, so there is no route to register (the
// contract smoke of the entries builds without a database). On the api entry the module also
// installs the raw-body capture of the notification routes on the Fastify instance before it is
// ready (http/public/notify-body.ts), through Nest's HttpAdapterHost in its init hook.
// B2-15m: on the worker entry, the daily chain of bill.recon starts and heals itself as B1-22b's
// chain does (union/auth-expiry/union-auth.module.ts): a timer, unref'd and started on application
// bootstrap, seeds the chain RECON_SEED_DELAY_MS later (the queue runtime has started by then) and
// again every RECON_HEAL_INTERVAL_MS (application/pay-recon-schedule.ts seedBillRecon with the
// process's memory of the Apps already started; a failure is a warn line and is retried on the next
// tick). Only where the pay queue handler is registered; the timer stops on module destroy, which
// waits for the tick in flight up to a bound (B2-15q: the database closes after that; B2-15s).
import { Module, type DynamicModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../content/index.ts';
import {
  LEDGER,
  LedgerModule,
  registerReconDiff,
  registerReconDiffOnce,
  type Ledger,
} from '../ledger/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  EVENT_BUS,
  FIELD_CRYPTO,
  IDEMPOTENCY,
  JOB_QUEUE,
  REDIS,
  ROOT_LOGGER,
  waitForTickStop,
  type AppConfig,
  type AuditPort,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type Idempotency,
  type JobQueue,
  type QueueRuntime,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import { createBizRegistry } from './application/biz-registry.ts';
import { PayChannelSet } from './application/pay-channel.ts';
import { PayAdminReads } from './application/pay-admin-reads.ts';
import type { PayOrderDeps } from './application/pay-orders.ts';
import { seedBillRecon, type PayReconSeedDeps } from './application/pay-recon-schedule.ts';
import type { PayRefundDeps } from './application/pay-refunds.ts';
import type { PayResolveDeps } from './application/pay-resolve.ts';
import type { PayLedgerPort } from './application/pay-settlement.ts';
import { AdminPayOrdersController, PAY_RESOLVE_DEPS } from './http/admin/pay-orders.controller.ts';
import { AdminPayRefundsController, PAY_REFUND_DEPS } from './http/admin/pay-refunds.controller.ts';
import { installNotifyBodyCapture } from './http/public/notify-body.ts';
import {
  PAY_NOTIFY_DEPS,
  PayNotifyController,
  isNotifyRoute,
  type PayNotifyDeps,
} from './http/public/pay-notify.controller.ts';
import { PAY_ORDER_DEPS, PayOrdersController } from './http/public/pay-orders.controller.ts';
import { createPayChannelSet } from './infra/channels/index.ts';
import { createNotifyRateLimiter } from './infra/notify-rate-limit.ts';
import { createPayJobHandler } from './jobs/pay-jobs.ts';
import { PAY_QUEUE } from './jobs/names.ts';

export interface PaymentModuleOptions {
  /** content's ContentReader over the primary handle (pay.enabled, pay.channel_enabled.*, …). */
  readonly config: (db: Kysely<Database>, clock: Clock) => ContentReader;
  /**
   * api entry: register the notification entry (POST /notify/pay/<channel>). app.module passes
   * whether the process has a database; without one the entry is left out (see the header).
   */
  readonly notifyEntry?: boolean;
}

/**
 * B2-15e: the admin entry's options (the console's original-route refund); B2-15f: the pay reads
 * and the manual settlement of a needs_manual pay order.
 */
export interface PaymentAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /**
   * B2-15f: content's ContentReader over the primary handle (pay.close_grace_minutes and the other
   * close settings, pay.<pay_channel>.success_states) for the manual settlement.
   */
  readonly config: PaymentModuleOptions['config'];
}

/** Nest token of the worker's registered pay queue handler (null without database or queue). */
export const PAY_JOBS = Symbol('PAYMENT_PAY_JOBS');
/** Nest token of the api entry's notification body capture (an init hook). */
const NOTIFY_BODY_CAPTURE = Symbol('PAYMENT_NOTIFY_BODY_CAPTURE');
/** Nest token of the worker's timer of the bill.recon chain (B2-15m; lifecycle hooks). */
const RECON_TIMER = Symbol('PAYMENT_RECON_TIMER');
/** B2-15m: delay of the first seed after bootstrap (the queue runtime starts meanwhile). */
export const RECON_SEED_DELAY_MS = 15_000;
/** B2-15m: interval between two heals of the bill.recon chain. */
export const RECON_HEAL_INTERVAL_MS = 5 * 60_000;

interface ReconChainTimer {
  onApplicationBootstrap(): void;
  onModuleDestroy(): Promise<void>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** B2-15m: the seed after bootstrap and the heal every interval (see the header); null: inert. */
function reconChainTimer(deps: PayReconSeedDeps | null): ReconChainTimer {
  const started = new Map<string, string>();
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: PayReconSeedDeps): Promise<void> => {
    try {
      await seedBillRecon(active, { started });
    } catch (error: unknown) {
      active.logger.warn(
        { queue: PAY_QUEUE, error_name: errorName(error) },
        'pay_bill_recon_heal_failed',
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
        interval = setInterval(tick, RECON_HEAL_INTERVAL_MS);
        interval.unref();
      }, RECON_SEED_DELAY_MS);
      first.unref();
    },
    async onModuleDestroy() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      if (deps !== null && running) {
        await waitForTickStop(inFlight, 'payment-recon', deps.logger);
      }
    },
  };
}

/**
 * ledger's posting and recon diff registration as payment's port (BR-PAY-07); B2-15n: with the
 * registration that tells a new diff from a known one (pay_recon_mismatch alerted once).
 */
function ledgerPort(ledger: Ledger, clock: Clock): PayLedgerPort {
  return {
    post: (trx, voucher) => ledger.post(trx, voucher),
    registerReconDiff: (trx, input) => registerReconDiff(trx, input, { clock }),
    registerReconDiffOnce: (trx, input) => registerReconDiffOnce(trx, input, { clock }),
  };
}

const channelSetProvider = {
  provide: PayChannelSet,
  inject: [APP_CONFIG, CLOCK, ROOT_LOGGER],
  useFactory: (config: AppConfig, clock: Clock, logger: RootLogger): Promise<PayChannelSet> =>
    createPayChannelSet(config, { clock, logger: logger.child({ module: 'payment' }) }),
};

@Module({})
export class PaymentModule {
  static forApi(options: PaymentModuleOptions): DynamicModule {
    const notifyEntry = options.notifyEntry === true;
    return {
      module: PaymentModule,
      imports: [LedgerModule.forRoot()],
      controllers: [PayOrdersController, ...(notifyEntry ? [PayNotifyController] : [])],
      providers: [
        channelSetProvider,
        {
          provide: PAY_ORDER_DEPS,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            PayChannelSet,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
            channels: PayChannelSet,
            db?: Kysely<Database>,
            queue?: JobQueue,
          ): PayOrderDeps | null =>
            db === undefined || queue === undefined
              ? null
              : {
                  db,
                  clock,
                  config: options.config(db, clock),
                  queue,
                  channels,
                  registry: createBizRegistry(config.appEnv),
                  logger: logger.child({ module: 'payment' }),
                },
        },
        ...(notifyEntry
          ? [
              {
                provide: PAY_NOTIFY_DEPS,
                inject: [
                  CLOCK,
                  ROOT_LOGGER,
                  PayChannelSet,
                  LEDGER,
                  DB,
                  JOB_QUEUE,
                  EVENT_BUS,
                  { token: FIELD_CRYPTO, optional: true },
                  { token: REDIS, optional: true },
                ],
                useFactory: (
                  clock: Clock,
                  logger: RootLogger,
                  channels: PayChannelSet,
                  ledger: Ledger,
                  db: Kysely<Database>,
                  queue: JobQueue,
                  events: EventBus,
                  crypto?: FieldCrypto,
                  redis?: RedisHandle,
                ): PayNotifyDeps => {
                  const child = logger.child({ module: 'payment', entry_point: 'notify' });
                  if (crypto === undefined) {
                    // Fail closed from now on (rule 6): announced once, every notification nacked.
                    child.error({}, 'pay_notify_crypto_missing');
                  }
                  if (redis === undefined) child.warn({}, 'pay_notify_rate_limit_disabled');
                  return {
                    handler: {
                      db,
                      clock,
                      config: options.config(db, clock),
                      queue,
                      events,
                      channels,
                      ledger: ledgerPort(ledger, clock),
                      crypto: crypto ?? null,
                      logger: child,
                    },
                    rateLimiter:
                      redis === undefined
                        ? null
                        : createNotifyRateLimiter({ redis, clock, crypto: crypto ?? null }),
                    logger: child,
                  };
                },
              },
              {
                provide: NOTIFY_BODY_CAPTURE,
                inject: [HttpAdapterHost],
                useFactory: (host: HttpAdapterHost): { onModuleInit(): void } => ({
                  onModuleInit() {
                    // Only where an HTTP server exists: a module graph built without one (an
                    // application context, a wiring test) has no adapter and nothing to capture.
                    const adapter: { getInstance?: () => unknown } | null | undefined =
                      host.httpAdapter;
                    const instance = adapter?.getInstance?.();
                    if (instance === undefined || instance === null) return;
                    installNotifyBodyCapture(instance, isNotifyRoute);
                  },
                }),
              },
            ]
          : []),
      ],
      exports: [PayChannelSet],
    };
  }

  /**
   * B2-15e: the admin entry's original-route refund (POST /admin/v1/pay-orders/{id}/refunds, POST
   * /admin/v1/pay-anomalies/{id}/refunds) over platform idempotency, the queue (the first
   * refund.query slot) and admin's audit writer bound to the creating transaction. Without the
   * database, the queue or the idempotency primitive the routes fail closed (50001).
   * B2-15f: the pay order list / detail and the anomaly list (reads over the primary handle) and
   * the manual settlement (POST /admin/v1/pay-orders/{id}/resolve) over the channel set, ledger's
   * posting (the PAY_RECEIPT of PO2), the queue and event bus (biz.reconcile, pay_order.paid),
   * content's configuration and admin's audit writer bound to the settling transaction. Without the
   * database, the queue or the event bus they fail closed (50001).
   * B2-15j: the R4 recon diff list (GET /admin/v1/pay-recon-diffs) on the same reads, through
   * ledger's getReconDiffs.
   * B2-15o: the refund list and detail (GET /admin/v1/pay-refunds…) on the same reads, mounted on
   * AdminPayRefundsController.
   */
  static forAdmin(options: PaymentAdminOptions): DynamicModule {
    return {
      module: PaymentModule,
      imports: [LedgerModule.forRoot()],
      controllers: [AdminPayRefundsController, AdminPayOrdersController],
      providers: [
        channelSetProvider,
        {
          provide: PayAdminReads,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): PayAdminReads => new PayAdminReads(db ?? null),
        },
        {
          provide: PAY_RESOLVE_DEPS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            PayChannelSet,
            LEDGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            channels: PayChannelSet,
            ledger: Ledger,
            db?: Kysely<Database>,
            queue?: JobQueue,
            events?: EventBus,
          ): PayResolveDeps | null =>
            db === undefined || queue === undefined || events === undefined
              ? null
              : {
                  db,
                  clock,
                  config: options.config(db, clock),
                  queue,
                  events,
                  channels,
                  ledger: ledgerPort(ledger, clock),
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  logger: logger.child({ module: 'payment', entry_point: 'admin' }),
                },
        },
        {
          provide: PAY_REFUND_DEPS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            PayChannelSet,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            channels: PayChannelSet,
            db?: Kysely<Database>,
            queue?: JobQueue,
            idempotency?: Idempotency,
          ): PayRefundDeps | null =>
            db === undefined || queue === undefined || idempotency === undefined
              ? null
              : {
                  db,
                  clock,
                  queue,
                  channels,
                  idempotency,
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  logger: logger.child({ module: 'payment', entry_point: 'admin' }),
                },
        },
      ],
      exports: [PayChannelSet],
    };
  }

  /**
   * The worker entry: the handler of queue `pay` (order.query, biz.reconcile, order.close,
   * refund.query; B2-15j bill.recon, the T+1 reconciliation over the channel set, ledger's posting
   * and recon diff registration). B2-15m: beside it, the timer that seeds and heals the bill.recon
   * chain (see the header).
   */
  static forWorker(options: Pick<PaymentModuleOptions, 'config'>): DynamicModule {
    return {
      module: PaymentModule,
      imports: [LedgerModule.forRoot()],
      providers: [
        channelSetProvider,
        {
          provide: PAY_JOBS,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            PayChannelSet,
            LEDGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
            channels: PayChannelSet,
            ledger: Ledger,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
            events?: EventBus,
          ): { readonly queue: string } | null => {
            const child = logger.child({ module: 'payment', queue: PAY_QUEUE });
            if (db === undefined || queue === undefined || events === undefined) {
              child.info({}, 'pay_jobs_disabled');
              return null;
            }
            queue.register(
              PAY_QUEUE,
              createPayJobHandler({
                db,
                clock,
                config: options.config(db, clock),
                queue,
                events,
                channels,
                registry: createBizRegistry(config.appEnv),
                ledger: ledgerPort(ledger, clock),
                logger: child,
              }),
            );
            return { queue: PAY_QUEUE };
          },
        },
        {
          // B2-15m: the bill.recon chain's seed and heal, only beside a registered handler.
          provide: RECON_TIMER,
          inject: [
            PAY_JOBS,
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            jobs: { readonly queue: string } | null,
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            queue?: JobQueue,
          ): ReconChainTimer =>
            reconChainTimer(
              jobs === null || db === undefined || queue === undefined
                ? null
                : {
                    db,
                    clock,
                    queue,
                    logger: logger.child({ module: 'payment', queue: PAY_QUEUE }),
                  },
            ),
        },
      ],
      exports: [PayChannelSet],
    };
  }
}
