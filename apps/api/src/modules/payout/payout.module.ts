// B2-05c / B2-05d: the payout module on the api entry. app.module assembles the ports of the
// withdrawal rules use case (identity, risk, ledger, content's configuration reader, the default
// fee / tax calculator and the "nothing pending" re-verification gate) and hands them as `rules`,
// and the application use case (the same ports plus identity's users lock and payee snapshot,
// the ledger and the event bus) as `apply`; an entry without a database (contract smoke, tests)
// gets no use case and the controller refuses with 50001. `handle` overrides the process DB
// handle (tests only).
import type { DynamicModule, FactoryProvider } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { BALANCE_RECOVERED_HOOK, createLedger } from '../ledger/index.ts';
import { createBalanceRecoveredHook } from './application/balance-recovered.ts';
import {
  IDEMPOTENCY,
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  EVENT_BUS,
  FIELD_CRYPTO,
  JOB_QUEUE,
  ROOT_LOGGER,
  registerEventConsumer,
  waitForTickStop,
  type AppConfig,
  type AuditPort,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type JobQueue,
  type QueueRuntime,
  type ReceivedJob,
  type RootLogger,
  type Idempotency,
} from '../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../risk/index.ts';
import { WENT_NEGATIVE_CONSUMER, createWentNegativeConsumer } from './application/went-negative.ts';
import {
  AUTO_PAYOUT_CONSUMER,
  createAutoPayoutConsumer,
  type AutoPayoutOptions,
} from './application/auto-payout.ts';
import type {
  AdminPayoutWatermarkDeps,
  AdminPayoutWatermarkPorts,
} from './application/admin-payout-watermarks.ts';
import { createPayoutExecute } from './application/payout-execute.ts';
import { PAYOUT_LANDING_QUEUE, createLandingJob } from './jobs/landing-job.ts';
import { anyReviewWaiting, createReviewOverdueCheck } from './application/review-overdue.ts';
import {
  PAYOUT_OVERDUE_QUEUE,
  createReviewOverdueJob,
  seedReviewOverdue,
} from './jobs/review-overdue-job.ts';
import { PAYOUT_PAUSE_JOB, createPauseJob } from './jobs/pause-job.ts';
import { PAYOUT_REVIEW_QUEUE, createReviewJob } from './jobs/review-job.ts';
import { createPayoutReconJob, type PayoutBillPort } from './jobs/recon-job.ts';
import { createAttemptAppendJob } from './jobs/attempt-append-job.ts';
import { PAYOUT_ATTEMPT_APPEND_QUEUE } from './application/withdrawal-proven-success.ts';
import { PAYOUT_RECON_QUEUE, seedPayoutRecon } from './application/recon-schedule.ts';
import { createWithdrawHolds } from './application/withdraw-holds.ts';
import type { TaxYtdIdentityKeyReader } from './application/tax-ytd.ts';
import { defaultPayoutChannelConfig } from './application/judgement.ts';
import { FakeChannel } from './infra/channels/fake-channel.ts';
import type { PayoutChannelName } from './infra/channels/payout-channel.ts';
import { PAYOUT_QUEUE, type PayoutQueuePausePort } from './jobs/transfer-job.ts';
import { createPayoutRuntime, payoutRuntimeToken, type PayoutRuntime } from './payout-runtime.ts';
import type { WithdrawalAttemptsPort } from './application/withdrawal-commands.ts';
import type { WithdrawApplyOptions, WithdrawApplyService } from './application/withdraw-apply.ts';
import {
  registerWithdrawalAccountDecrypt,
  type DecryptWithdrawalAccount,
} from './application/withdrawal-reads.ts';
import type { PayoutConfigPort, WithdrawRulesService } from './application/withdraw-rules.ts';
import {
  WithdrawalsController,
  type WithdrawStepUp,
} from './http/public/withdrawals.controller.ts';
import type {
  AdminPayeeDecrypt,
  AdminWithdrawalReadDeps,
} from './application/admin-withdrawals.ts';
import {
  ADMIN_PAYOUT_WATERMARKS,
  AdminPayoutWatermarksController,
} from './http/admin/payout-watermarks.controller.ts';
import {
  ADMIN_WITHDRAWAL_READS,
  AdminWithdrawalsController,
} from './http/admin/withdrawals.controller.ts';
import {
  WITHDRAW_APPLY,
  WITHDRAW_RULES,
  WITHDRAW_READS,
  WITHDRAW_RULES_HANDLE,
  WITHDRAW_STEP_UP,
} from './tokens.ts';

type Factory<T> = Pick<FactoryProvider<T | null>, 'inject' | 'useFactory'>;

export interface PayoutModuleOptions {
  /** A ready use case (tests), or a factory over the entry's providers (app.module). */
  rules?: WithdrawRulesService | Factory<WithdrawRulesService>;
  apply?: WithdrawApplyService | Factory<WithdrawApplyService>;
  /** identity's withStepUp (app.module); without it POST /v1/withdrawals refuses with 50001. */
  stepUp?: WithdrawStepUp;
  /**
   * B2-05f: the process's snapshot decryption for the records (a factory over the entry's field
   * cipher, app.module); registered once for read.ts and used by the two GET handlers.
   */
  reads?: Factory<DecryptWithdrawalAccount>;
  handle?: Kysely<DB>;
}

function provider<T>(
  token: symbol,
  value: T | Factory<T> | undefined,
  isService: (value: T | Factory<T>) => value is T,
) {
  return value === undefined
    ? { provide: token, useValue: null }
    : isService(value)
      ? { provide: token, useValue: value }
      : { provide: token, ...value };
}

function isRulesService(
  value: WithdrawRulesService | Factory<WithdrawRulesService>,
): value is WithdrawRulesService {
  return typeof (value as WithdrawRulesService).getRules === 'function';
}

function isApplyService(
  value: WithdrawApplyService | Factory<WithdrawApplyService>,
): value is WithdrawApplyService {
  return typeof (value as WithdrawApplyService).apply === 'function';
}

/** The payout entry's payee decryption (resolved from PayoutProcessOptions.decryptPayee). */
const PAYOUT_DECRYPT_PAYEE = Symbol('PAYOUT_DECRYPT_PAYEE');

/** The negative balance consumer's registration token (worker entry). */
export const WENT_NEGATIVE_CONSUMER_TOKEN = Symbol('PAYOUT_WENT_NEGATIVE_CONSUMER');

export interface PayoutWorkerOptions {
  /** identity's users row lock (dependency inversion: app.module hands it in). */
  lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  /** payout_attempts reads through payout's own store (B2-06c; app.module hands it in). */
  attempts: WithdrawalAttemptsPort;
  /**
   * B2-11c: the other modules' ports of the withdrawal.created consumer (content's configuration
   * reader, risk's state / appeal readers, the risk facts reader with commission's and identity's
   * ports, identity's adult check and the live blocklist check), built by app.module per process.
   * Without it the consumer is not registered.
   */
  autoPayout?: (deps: {
    db: Kysely<DB>;
    clock: Clock;
    crypto: FieldCrypto | undefined;
  }) => AutoPayoutPorts;
  /**
   * B2-06f (D10-398 ①): the transfer review's ports (BR-WDR-13 ③ on couli_app): content's
   * configuration reader over the worker handle (payout.* read straight from PG), risk's state and
   * appeal readers (BR-WDR-05).
   */
  config: (db: Kysely<DB>, clock: Clock) => PayoutConfigPort;
  risk: RiskStateBatchReader;
  appeal: AppealPrevStateReader;
  /** B2-06f (D10-398 ②): content's system write of payout.queue_paused = true (worker). */
  pauseQueue: (clock: Clock) => PayoutQueuePausePort;
  /**
   * B2-08b (BR-WDR-20, D10-181 ①): identity's realname-identity-key port for the landing job's
   * tax_ytd (app.module hands in createRealnameIdentityKeyReader()).
   */
  identityKey?: TaxYtdIdentityKeyReader;
}

/** What app.module supplies to the automatic payout decision (BR-WDR-30). */
export type AutoPayoutPorts = Pick<
  AutoPayoutOptions,
  'config' | 'risk' | 'appeal' | 'facts' | 'adult' | 'blacklist'
>;

/** The automatic payout consumer's registration token (worker entry). */
export const AUTO_PAYOUT_CONSUMER_TOKEN = Symbol('PAYOUT_AUTO_PAYOUT_CONSUMER');

/** B2-06f: the payout process's ports, assembled by app.module (dependency inversion). */
export interface PayoutProcessOptions {
  /** identity's users row lock (module lock order: users → balances; the query job's port). */
  lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  /** content's configuration reader over the process handle: payout.* read straight from PG. */
  config: (db: Kysely<DB>, clock: Clock) => PayoutConfigPort;
  /** The payee snapshot decryption over the process's field cipher. */
  decryptPayee: Factory<DecryptWithdrawalAccount>;
}

/**
 * A direct negative-balance recheck job (payout's transfer job, W9 member_blocked: payload exactly
 * { app_id, user_id }) wrapped as the event envelope registerEventConsumer requires; an event the
 * bus published already carries the envelope and passes through unchanged.
 */
function withEnvelope(job: ReceivedJob, clock: Clock): ReceivedJob {
  const payload = job.payload as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'app_id' ||
    keys[1] !== 'user_id' ||
    typeof payload['app_id'] !== 'string' ||
    typeof payload['user_id'] !== 'string'
  ) {
    return job;
  }
  return {
    ...job,
    payload: {
      app_id: payload['app_id'],
      v: 1,
      occurred_at: clock.now().toISOString(),
      data: { app_id: payload['app_id'], user_id: payload['user_id'] },
    },
  };
}

/** The worker's registration of the R2 reconciliation's handler (B2-07c; null: not registered). */
export const PAYOUT_RECON_JOBS_TOKEN = Symbol('PAYOUT_RECON_JOBS');
/** B2-07e: whether the payout process registered the attempt-append handler (false without db / queue). */
export const PAYOUT_ATTEMPT_APPEND_TOKEN = Symbol('PAYOUT_ATTEMPT_APPEND');
/** The worker's timer of the payout-recon chain (B2-07c; lifecycle hooks). */
const PAYOUT_RECON_TIMER = Symbol('PAYOUT_RECON_TIMER');
/** B2-07c: delay of the first seed after bootstrap (the queue runtime starts meanwhile). */
export const PAYOUT_RECON_SEED_DELAY_MS = 15_000;
/** B2-07c: interval between two heals of the payout-recon chain. */
export const PAYOUT_RECON_HEAL_INTERVAL_MS = 30 * 60_000;
/** B2-05n: the worker's payout-overdue handler registration (true when registered). */
export const PAYOUT_OVERDUE_JOBS_TOKEN = Symbol('PAYOUT_OVERDUE_JOBS');
/** The worker's timer of the payout-overdue chain (B2-05n; lifecycle hooks). */
const PAYOUT_OVERDUE_TIMER = Symbol('PAYOUT_OVERDUE_TIMER');
/** B2-05n: delay of the first seed after bootstrap (the queue runtime starts meanwhile). */
export const PAYOUT_OVERDUE_SEED_DELAY_MS = 15_000;
/** B2-05n: interval between two heals of the payout-overdue chain (a seed of the current slot). */
export const PAYOUT_OVERDUE_HEAL_INTERVAL_MS = 30 * 60_000;

/**
 * B2-07c: the bill ports of the worker. Only the payout process reads channel secrets (payout
 * AGENTS.md rule 4), so prod has no port here until a bill download lands (every run then records
 * partial, never succeeded); outside prod the synthetic FakeChannel, whose days without an injected
 * bill are unavailable too.
 */
function reconBillsFor(
  appEnv: AppConfig['appEnv'],
): Readonly<Partial<Record<PayoutChannelName, PayoutBillPort>>> {
  if (appEnv === 'prod') return {};
  const defaults = defaultPayoutChannelConfig();
  return {
    alipay: new FakeChannel({
      mode: 'dry_run',
      lists: {
        definiteFailCodes: defaults.definiteFailCodes,
        payerSideCodes: defaults.payerSideCodes,
        queryStatusMap: defaults.queryStatusMap,
      },
      script: {},
    }),
  };
}

/**
 * B2-07c: the audit of the system's recon_diff holds. audit_logs records admin writes (its actor
 * is an admin_users row); a hold added by the reconciliation has no admin, so its audit is an info
 * line with the hold's ids only (the hold row itself keeps created_by and source_ref).
 */
function systemHoldAudit(logger: RootLogger): AuditPort {
  return {
    append(input) {
      logger.info(
        { app_id: input.appId, actor: input.actor, action: input.action, target: input.target },
        'withdraw_hold_system_audit',
      );
      return Promise.resolve();
    },
  };
}

interface ReconChainTimer {
  onApplicationBootstrap(): void;
  /** Waits for the tick in flight up to a bound (B2-15q, B2-15s); the database closes after it. */
  onModuleDestroy(): Promise<void>;
}

/** B2-07c: the payout-recon seed after bootstrap and its heal every interval; null deps: inert. */
function reconChainTimer(
  deps: { db: Kysely<DB>; clock: Clock; queue: JobQueue; logger: RootLogger } | null,
): ReconChainTimer {
  const started = new Map<string, string>();
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: NonNullable<typeof deps>): Promise<void> => {
    try {
      await seedPayoutRecon({ ...active, started });
    } catch (error: unknown) {
      active.logger.warn(
        {
          queue: PAYOUT_RECON_QUEUE,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'payout_recon_heal_failed',
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
        interval = setInterval(tick, PAYOUT_RECON_HEAL_INTERVAL_MS);
        interval.unref();
      }, PAYOUT_RECON_SEED_DELAY_MS);
      first.unref();
    },
    async onModuleDestroy() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      if (deps !== null && running) {
        await waitForTickStop(inFlight, 'payout-recon', deps.logger);
      }
    },
  };
}

/**
 * B2-05n (BR-WDR-26 「每 5 分钟运行一次」): the payout-overdue seed after bootstrap and its heal
 * every interval (seedReviewOverdue sends the current slot; the exclusive key merges a repeat);
 * null deps: inert. Same shape as the payout-recon timer above.
 */
function overdueChainTimer(
  deps: { db: Kysely<DB>; clock: Clock; queue: JobQueue; logger: RootLogger } | null,
): ReconChainTimer {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = async (active: NonNullable<typeof deps>): Promise<void> => {
    try {
      // Only while a withdrawal waits for a review with a deadline (anyReviewWaiting): an empty
      // database runs no chain, as the recon and ledger daily-check seeds read their apps first.
      if (await anyReviewWaiting(active.db)) await seedReviewOverdue(active);
    } catch (error: unknown) {
      active.logger.warn(
        {
          queue: PAYOUT_OVERDUE_QUEUE,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'payout_overdue_heal_failed',
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
        interval = setInterval(tick, PAYOUT_OVERDUE_HEAL_INTERVAL_MS);
        interval.unref();
      }, PAYOUT_OVERDUE_SEED_DELAY_MS);
      first.unref();
    },
    async onModuleDestroy() {
      stopped = true;
      if (first !== undefined) clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      if (deps !== null && running) {
        await waitForTickStop(inFlight, 'payout-overdue', deps.logger);
      }
    },
  };
}

export class PayoutModule {
  /**
   * B2-05e: the worker entry's account.went_negative consumer on queue evt.payout-went-negative
   * (registerEventConsumer: processed_events claim and the locked recheck in one transaction).
   * Registration runs no statement; without a database or queue nothing is registered and one
   * info line `went_negative_consumer_disabled` is logged.
   */
  /**
   * B2-05k: payout's recovery port for ledger (BR-WDR-05 (a)), global so LedgerModule's optional
   * BALANCE_RECOVERED_HOOK injection sees it on every entry that books money. The hook clears the
   * member's NEGATIVE_BALANCE blocks inside the posting that takes available back to >= 0.
   */
  static recovery(): DynamicModule {
    return {
      module: PayoutModule,
      global: true,
      providers: [
        {
          provide: BALANCE_RECOVERED_HOOK,
          inject: [CLOCK],
          useFactory: (clock: Clock) => createBalanceRecoveredHook({ clock }),
        },
      ],
      exports: [BALANCE_RECOVERED_HOOK],
    };
  }

  static forWorker(options: PayoutWorkerOptions): DynamicModule {
    return {
      module: PayoutModule,
      providers: [
        // B2-11c (BR-WDR-30): withdrawal.created → the automatic payout decision on queue
        // evt.payout-auto-payout (registerEventConsumer: processed_events claim and the decision's
        // effects in one transaction). Registration runs no statement.
        {
          provide: AUTO_PAYOUT_CONSUMER_TOKEN,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
            eventBus?: EventBus,
            crypto?: FieldCrypto,
          ): boolean => {
            if (
              db === undefined ||
              queue === undefined ||
              eventBus === undefined ||
              options.autoPayout === undefined
            ) {
              logger.info({ consumer: AUTO_PAYOUT_CONSUMER }, 'auto_payout_consumer_disabled');
              return false;
            }
            const ports = options.autoPayout({ db, clock, crypto });
            const child = logger.child({ module: 'payout' });
            const ledger = createLedger({
              clock,
              eventBus,
              balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
            });
            const consumer = createAutoPayoutConsumer({
              ...ports,
              db,
              logger: child,
              clock,
              ledger,
              lockUsersForUpdate: options.lockUsersForUpdate,
              attempts: options.attempts,
              eventBus,
              execute: createPayoutExecute({
                config: ports.config,
                risk: ports.risk,
                appeal: ports.appeal,
                ledger,
                queue,
                eventBus,
                logger: child,
              }),
            });
            registerEventConsumer(queue, {
              consumer: AUTO_PAYOUT_CONSUMER,
              db,
              logger,
              handler: (event, trx) => consumer.handle(event, trx),
            });
            return true;
          },
        },
        {
          provide: WENT_NEGATIVE_CONSUMER_TOKEN,
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
          ): boolean => {
            if (db === undefined || queue === undefined || eventBus === undefined) {
              logger.info({ consumer: WENT_NEGATIVE_CONSUMER }, 'went_negative_consumer_disabled');
              return false;
            }
            const consumer = createWentNegativeConsumer({
              db,
              logger: logger.child({ module: 'payout' }),
              clock,
              ledger: createLedger({
                clock,
                eventBus,
                balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
              }),
              lockUsersForUpdate: options.lockUsersForUpdate,
              attempts: options.attempts,
              eventBus,
            });
            // B2-06d (BR-WDR-05 (a)): the payout process's W9 member_blocked enqueues a direct
            // recheck { app_id, user_id } on this queue; it is given the event envelope the
            // consumer expects before the shared registration sees it (one job, one claim).
            const normalized: Pick<QueueRuntime, 'register'> = {
              register(name, handler) {
                queue.register(name, (job) => handler(withEnvelope(job, clock)));
              },
            };
            registerEventConsumer(normalized, {
              consumer: WENT_NEGATIVE_CONSUMER,
              db,
              logger,
              handler: (event, trx) => consumer.handle(event, trx),
            });
            // B2-06fz (D10-326 C): the payout process only records a success / fail attempt and
            // enqueues one payout-landing job; this worker lands W5 / W6 as couli_app (ledger
            // voucher, users lock, event) through jobs/landing-job.ts. B2-06f (D10-398 ②): a
            // `pause` job on the same queue persists payout.queue_paused (jobs/pause-job.ts).
            const payoutLogger = logger.child({ module: 'payout' });
            const workerLedger = createLedger({
              clock,
              eventBus,
              balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
            });
            const land = createLandingJob({
              db,
              ledger: workerLedger,
              lockUsersForUpdate: options.lockUsersForUpdate,
              eventBus,
              clock,
              logger: payoutLogger,
              // B2-08b (BR-WDR-20): identity's realname-identity-key port for the tax_ytd row.
              ...(options.identityKey === undefined ? {} : { identityKey: options.identityKey }),
            });
            const pause = createPauseJob({
              db,
              pauseQueue: options.pauseQueue(clock),
              logger: payoutLogger,
            });
            queue.register(PAYOUT_LANDING_QUEUE, (job) =>
              job.name === PAYOUT_PAUSE_JOB ? pause(job) : land(job),
            );
            // B2-06f (D10-398 ①): BR-WDR-13 ③ payout_disabled → queue_paused → channel_disabled →
            // member_blocked under the users lock; a pass sends `release` back to queue `payout`.
            queue.register(
              PAYOUT_REVIEW_QUEUE,
              createReviewJob({
                db,
                clock,
                config: options.config(db, clock),
                risk: options.risk,
                appeal: options.appeal,
                ledger: workerLedger,
                lockUsersForUpdate: options.lockUsersForUpdate,
                queue,
                eventBus,
                logger: payoutLogger,
              }),
            );
            return true;
          },
        },
        // B2-07c (BR-WDR-23, D10-408): the daily R2 reconciliation on queue payout-recon
        // (couli_app): the bill of the previous +08:00 day against the withdrawals, recon diffs,
        // recon_diff holds under the users lock, the run record and the next day's run.
        {
          provide: PAYOUT_RECON_JOBS_TOKEN,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
          ): boolean => {
            if (db === undefined || queue === undefined) {
              logger.info({ queue: PAYOUT_RECON_QUEUE }, 'payout_recon_disabled');
              return false;
            }
            const reconLogger = logger.child({ module: 'payout', queue: PAYOUT_RECON_QUEUE });
            queue.register(
              PAYOUT_RECON_QUEUE,
              createPayoutReconJob({
                db,
                clock,
                config: options.config(db, clock),
                queue,
                bills: reconBillsFor(appConfig.appEnv),
                holds: createWithdrawHolds({
                  clock,
                  lockUsersForUpdate: options.lockUsersForUpdate,
                  audit: systemHoldAudit(reconLogger),
                }),
                logger: reconLogger,
              }),
            );
            return true;
          },
        },
        // B2-05n (BR-WDR-26 超时判定, D10-475 ②): queue payout-overdue — every five minutes the
        // worker judges withdrawals past their review_deadline still in PENDING_REVIEW / APPROVED
        // (users row lock → CAS review_overdue_at → event withdrawal.review_overdue on the same
        // transaction → warn after the commit), then enqueues the next slot.
        {
          provide: PAYOUT_OVERDUE_JOBS_TOKEN,
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
          ): boolean => {
            if (db === undefined || queue === undefined || eventBus === undefined) {
              logger.info({ queue: PAYOUT_OVERDUE_QUEUE }, 'payout_overdue_disabled');
              return false;
            }
            const overdueLogger = logger.child({ module: 'payout', queue: PAYOUT_OVERDUE_QUEUE });
            const check = createReviewOverdueCheck({
              db,
              lockUsersForUpdate: options.lockUsersForUpdate,
              eventBus,
              clock,
              logger: overdueLogger,
            });
            queue.register(
              PAYOUT_OVERDUE_QUEUE,
              createReviewOverdueJob({ check, queue, clock, logger: overdueLogger }),
            );
            return true;
          },
        },
        {
          // B2-05n: the payout-overdue chain's seed and heal, only beside a registered handler.
          provide: PAYOUT_OVERDUE_TIMER,
          inject: [
            PAYOUT_OVERDUE_JOBS_TOKEN,
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            registered: boolean,
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: JobQueue,
          ): ReconChainTimer =>
            overdueChainTimer(
              !registered || db === undefined || queue === undefined
                ? null
                : {
                    db,
                    clock,
                    queue,
                    logger: logger.child({ module: 'payout', queue: PAYOUT_OVERDUE_QUEUE }),
                  },
            ),
        },
        {
          // B2-07c: the payout-recon chain's seed and heal, only beside a registered handler.
          provide: PAYOUT_RECON_TIMER,
          inject: [
            PAYOUT_RECON_JOBS_TOKEN,
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            registered: boolean,
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            queue?: JobQueue,
          ): ReconChainTimer =>
            reconChainTimer(
              !registered || db === undefined || queue === undefined
                ? null
                : {
                    db,
                    clock,
                    queue,
                    logger: logger.child({ module: 'payout', queue: PAYOUT_RECON_QUEUE }),
                  },
            ),
        },
      ],
    };
  }

  /**
   * B2-06f: the payout entry's runtime under payoutRuntimeToken() (payout-runtime.ts); entry.ts
   * starts it with the PAYOUT_MODE decision before the queue runs.
   */
  static forPayout(options: PayoutProcessOptions): DynamicModule {
    const decrypt = options.decryptPayee;
    return {
      module: PayoutModule,
      providers: [
        {
          provide: PAYOUT_DECRYPT_PAYEE,
          inject: decrypt.inject ?? [],
          useFactory: async (...deps: unknown[]): Promise<DecryptWithdrawalAccount | null> =>
            (await decrypt.useFactory(...deps)) ?? null,
        },
        {
          provide: payoutRuntimeToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            PAYOUT_DECRYPT_PAYEE,
            { token: DB_TOKEN, optional: true },
            { token: JOB_QUEUE, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          // Assembly runs no statement and registers nothing: entry.ts calls start(decision).
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            decryptPayee: DecryptWithdrawalAccount | null,
            db?: Kysely<DB>,
            queue?: QueueRuntime,
            eventBus?: EventBus,
          ): PayoutRuntime | null => {
            if (
              db === undefined ||
              queue === undefined ||
              eventBus === undefined ||
              decryptPayee === null
            ) {
              logger.info({ queue: PAYOUT_QUEUE }, 'payout_runtime_disabled');
              return null;
            }
            return createPayoutRuntime({
              db,
              queue,
              eventBus,
              clock,
              logger: logger.child({ module: 'payout' }),
              // Built once over the process handle; every read goes to PG (no cache, no Redis).
              config: options.config(db, clock),
              ledger: createLedger({
                clock,
                eventBus,
                balanceRecoveredHook: createBalanceRecoveredHook({ clock }),
              }),
              lockUsersForUpdate: options.lockUsersForUpdate,
              decryptPayee,
            });
          },
        },
        // B2-07e (D10-428): the W11 attempt records. The admin write-off queues one job per
        // (withdrawal, difference) on its own transaction; this process (couli_payout, the only
        // role with INSERT on payout_attempts) appends the kind=query / result=success row,
        // idempotently. Registered at assembly, before entry.ts starts the queue.
        {
          provide: PAYOUT_ATTEMPT_APPEND_TOKEN,
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
              logger.info({ queue: PAYOUT_ATTEMPT_APPEND_QUEUE }, 'payout_attempt_append_disabled');
              return false;
            }
            queue.register(
              PAYOUT_ATTEMPT_APPEND_QUEUE,
              createAttemptAppendJob({
                db,
                clock,
                logger: logger.child({ module: 'payout', queue: PAYOUT_ATTEMPT_APPEND_QUEUE }),
              }),
            );
            return true;
          },
        },
      ],
      exports: [payoutRuntimeToken(), PAYOUT_ATTEMPT_APPEND_TOKEN],
    };
  }

  static forRoot(options?: PayoutModuleOptions): DynamicModule {
    const rulesProvider = provider(WITHDRAW_RULES, options?.rules, isRulesService);
    const applyProvider = provider(WITHDRAW_APPLY, options?.apply, isApplyService);
    const stepUpProvider = { provide: WITHDRAW_STEP_UP, useValue: options?.stepUp ?? null };
    const reads = options?.reads;
    const readsProvider =
      reads === undefined
        ? { provide: WITHDRAW_READS, useValue: null }
        : {
            provide: WITHDRAW_READS,
            inject: reads.inject ?? [],
            useFactory: async (...deps: unknown[]): Promise<DecryptWithdrawalAccount | null> => {
              const decrypt = await reads.useFactory(...deps);
              if (decrypt !== null) registerWithdrawalAccountDecrypt(decrypt);
              return decrypt;
            },
          };
    const handleProvider =
      options?.handle === undefined
        ? {
            provide: WITHDRAW_RULES_HANDLE,
            inject: [{ token: DB_TOKEN, optional: true }],
            useFactory: (db?: Kysely<DB>): Kysely<DB> | null => db ?? null,
          }
        : { provide: WITHDRAW_RULES_HANDLE, useValue: options.handle };
    return {
      module: PayoutModule,
      controllers: [WithdrawalsController],
      providers: [rulesProvider, applyProvider, stepUpProvider, readsProvider, handleProvider],
      exports: [WITHDRAW_RULES, WITHDRAW_APPLY],
    };
  }
}

/** B2-09c: what app.module hands in for the console reads (payout imports no identity). */
export interface PayoutAdminOptions extends AdminPayoutWatermarkPorts {
  /** identity's masked phones (BR-ID-33 3 + 4) over the entry's handle and field cipher. */
  readonly phones: (
    db: Kysely<DB>,
    crypto: FieldCrypto | null,
  ) => AdminWithdrawalReadDeps['phones'];
  /** The payee snapshot decryption (payout_accounts.* contexts); null without the field cipher. */
  readonly decryptPayee: (crypto: FieldCrypto | null) => AdminPayeeDecrypt | null;
}

/**
 * B2-09c: the admin entry's withdrawal reads (GET /admin/v1/withdrawals and its detail;
 * withdraw.review or fund.view, read only, no audit), guarded through platform's
 * AdminOperationGuard and read on the primary handle. Without the database or the field cipher
 * the routes still register and fail closed (50001).
 * B2-09i: the W entry (POST /admin/v1/payout-watermarks; fund.cash_entry, step-up totp), with the
 * same fail-closed rule without the database or idempotency.
 */
export class PayoutAdminModule {
  static forAdmin(options: PayoutAdminOptions): DynamicModule {
    return {
      module: PayoutAdminModule,
      controllers: [AdminWithdrawalsController, AdminPayoutWatermarksController],
      providers: [
        {
          provide: ADMIN_WITHDRAWAL_READS,
          inject: [
            CLOCK,
            { token: DB_TOKEN, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<DB>,
            crypto?: FieldCrypto,
          ): AdminWithdrawalReadDeps | null => {
            if (db === undefined) return null;
            const decryptPayee = options.decryptPayee(crypto ?? null);
            if (decryptPayee === null) return null;
            return {
              db,
              now: () => clock.now(),
              phones: options.phones(db, crypto ?? null),
              decryptPayee,
            };
          },
        },
        {
          provide: ADMIN_PAYOUT_WATERMARKS,
          inject: [
            CLOCK,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
          ): AdminPayoutWatermarkDeps | null =>
            db === undefined || idempotency === undefined
              ? null
              : { clock, idempotency, ports: options },
        },
      ],
    };
  }
}
