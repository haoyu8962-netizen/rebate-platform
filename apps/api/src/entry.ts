// Shared runner behind the five `main.<entry>.ts` files.
import { createHttpApp, createWorkerContext } from './bootstrap.ts';
import { agentSweeperToken, type AgentSweeperRuntime } from './modules/agent/index.ts';
import {
  inviteRewardScannerToken,
  startInviteRewardWorker,
  type InviteRewardScanner,
} from './modules/growth/index.ts';
import {
  deletionExpiryToken,
  payoutVerifyRecheckToken,
  startDeletionExpiry,
  startPayoutVerifyRecheck,
} from './modules/identity/index.ts';
import {
  type AppConfig,
  type Clock,
  type ConnectionConfig,
  type DbHandles,
  type MaintConnectionConfig,
  type MaintDbHandle,
  ConfigError,
  type EntryName,
  type HttpEntry,
  type RootLogger,
  type QueueRuntime,
  type MetricsServer,
  type IdempotencyPurger,
  type WorkerMetricsSnapshot,
  IDEMPOTENCY,
  JOB_QUEUE,
  collectWorkerMetrics,
  createMetricsRegistry,
  startMetricsServer,
  createRootLogger,
  createDbHandles,
  createMaintDbHandle,
  loadMaintConnectionConfig,
  createWorkerMaintenance,
  startWorkerServices,
  scheduleIdempotencyPurge,
  clockFromConfig,
  isHttpEntry,
  loadConfig,
  loadConnectionConfig,
  activeTracing,
  startTracing,
  type TracingHandle,
} from './modules/platform/index.ts';
import {
  orderSyncToken,
  readOrderSyncPendingOpen,
  type OrderSyncRuntime,
} from './modules/orders/index.ts';
import {
  autoPayoutConfigOf,
  payoutRuntimeToken,
  readPayoutFundMetrics,
  readPayoutReviewOverdue,
  resolvePayoutMode,
  type PayoutModeDecision,
  type PayoutRuntime,
} from './modules/payout/index.ts';
import {
  cacheAutoPayoutCollector,
  cacheFundCollector,
  cacheReviewOverdueCollector,
  collectAutoPayoutDaily,
  type AutoPayoutCapFenOf,
  type AutoPayoutDailySnapshot,
  type FundMetricsSnapshot,
  type ReviewOverdueSnapshot,
} from './modules/platform/metrics/index.ts';
import { readSettlementFundMetrics } from './modules/settlement/index.ts';
import {
  armRedisGeneration,
  redisGenerationRenewalToken,
  riskScanToken,
  seedRiskScan,
  startRedisGenerationRenewal,
  startRiskScanHeal,
  type RedisGenerationRenewal,
} from './modules/risk/index.ts';

// Keeps a worker process alive until a signal arrives; longer than any deployment lives.
const KEEP_ALIVE_INTERVAL_MS = 2 ** 30;

function portOf(entry: HttpEntry, config: AppConfig): number {
  if (entry === 'api') return config.apiPort;
  if (entry === 'stream') return config.streamPort;
  return config.adminPort;
}

interface StartupSignals {
  /** True once the first SIGTERM / SIGINT arrived (also during startup). */
  stopping(): boolean;
  /** Startup finished after a signal: close now and log `stopped` (or `shutdown_failed`). */
  stop(close: () => Promise<void>): Promise<void>;
  /** Startup finished: log `started` and close on the first signal, or close now if one came. */
  serve(close: () => Promise<void>, started: Record<string, unknown>): Promise<void>;
  /**
   * Startup failed and its cleanup begins: later signals are absorbed without a `stopping`
   * line (B1-01zs), so cleanup finishes and the process still ends with `startup_failed`, 1.
   */
  fail(): void;
  /** Failure cleanup finished: remove the handlers (runEntry, after `startup_failed`). */
  detach(): void;
}

/**
 * Installs the SIGTERM / SIGINT handlers before startup begins (not with COULI_EXIT_AFTER_INIT).
 * A signal during startup logs `stopping` once; startup owns cleanup until it finishes, so
 * nothing still starting is closed underneath it. Repeated signals are absorbed. Every entry,
 * the worker included, goes through this one watcher (B1-01zs).
 */
function watchSignals(
  logger: RootLogger,
  attach: boolean,
  afterClose?: () => Promise<void>,
): StartupSignals {
  let stopping = false;
  let failed = false;
  let close: (() => Promise<void>) | undefined;
  const shutdown = async (run: () => Promise<void>): Promise<void> => {
    try {
      try {
        await run();
      } finally {
        // B1-31: tracing is flushed and stopped once the entry's own close ran (never before).
        await afterClose?.();
      }
      logger.info('stopped');
    } catch (error) {
      logger.error({ err: error }, 'shutdown_failed');
      process.exitCode = 1;
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping || failed) return;
    stopping = true;
    logger.info({ signal }, 'stopping');
    if (close !== undefined) void shutdown(close);
  };
  if (attach) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
  return {
    stopping: () => stopping,
    stop: shutdown,
    async serve(run, started) {
      if (stopping) {
        await shutdown(run);
        return;
      }
      close = run;
      logger.info(started, 'started');
    },
    fail() {
      failed = true;
    },
    detach() {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    },
  };
}

/**
 * The worker's order-sync loops (B1-08n): resolved and started only while no stop was requested.
 * Older or isolated worker contexts may lack the runtime; that is not a startup failure.
 */
function startOrderSync(
  resolve: () => unknown,
  queue: QueueRuntime,
  stopping: () => boolean,
): { stop(): Promise<void> } | undefined {
  if (stopping()) return undefined;
  let runtime: Partial<OrderSyncRuntime> | null | undefined;
  try {
    runtime = resolve() as Partial<OrderSyncRuntime> | null | undefined;
  } catch {
    return undefined;
  }
  if (stopping() || runtime === (queue as unknown) || typeof runtime?.start !== 'function') {
    return undefined;
  }
  try {
    return runtime.start();
  } catch {
    return undefined;
  }
}

/**
 * The payout process's runtime (B2-06f): resolved optionally as the worker's order sync, and
 * started with the PAYOUT_MODE decision before the queue starts, so queue `payout` has its handler
 * from the first job. A context without the provider, a null provider (no database, queue, event
 * bus or field cipher) or a value without start registers nothing; a failing start fails startup.
 */
function startPayoutRuntime(
  resolve: () => unknown,
  queue: QueueRuntime,
  decision: PayoutModeDecision,
): Partial<PayoutRuntime> | undefined {
  let runtime: Partial<PayoutRuntime> | null | undefined;
  try {
    runtime = resolve() as Partial<PayoutRuntime> | null | undefined;
  } catch {
    return undefined;
  }
  if (runtime === (queue as unknown) || typeof runtime?.start !== 'function') return undefined;
  runtime.start(decision);
  return runtime;
}

/**
 * The query chain's crash recovery (B2-06i, BR-WDR-14): once the queue runs, because its rounds
 * enqueue jobs; not when a stop was already requested. Optional like the runtime itself: a runtime
 * without startRecovery starts and stops as before, no crash, no log.
 */
function startPayoutRecovery(
  runtime: Partial<PayoutRuntime> | undefined,
  stopping: () => boolean,
): { stop(): Promise<void> } | undefined {
  if (stopping() || typeof runtime?.startRecovery !== 'function') return undefined;
  return runtime.startRecovery();
}

/**
 * The daily purge of expired idempotency records (B1-15za, BR-ID-30): handed to the queue runtime
 * before its start, which then creates the internal queue, schedule and lane. Optional like the
 * other worker runtimes: a context without the provider, a null provider or a value without
 * purgeExpired → not handed over, no crash, no log.
 */
function wireIdempotencyPurge(resolve: () => unknown, queue: QueueRuntime): void {
  let idempotency: Partial<IdempotencyPurger> | null | undefined;
  try {
    idempotency = resolve() as Partial<IdempotencyPurger> | null | undefined;
  } catch {
    return;
  }
  if (typeof idempotency?.purgeExpired !== 'function') return;
  scheduleIdempotencyPurge(queue, idempotency as IdempotencyPurger);
}

/**
 * growth's invite reward loop (B1-35): resolved and started only while no stop was requested.
 * Optional like the order-sync runtime: a context without the provider, a null provider (no
 * database, field cipher or event bus) or a value without tick → no loop, no crash, no log.
 */
function startInviteReward(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
): { stop(): Promise<void> } | undefined {
  if (stopping()) return undefined;
  let scanner: Partial<InviteRewardScanner> | null | undefined;
  try {
    scanner = resolve() as Partial<InviteRewardScanner> | null | undefined;
  } catch {
    return undefined;
  }
  if (stopping() || typeof scanner?.tick !== 'function') return undefined;
  return startInviteRewardWorker({ scanner: scanner as InviteRewardScanner, logger });
}

/**
 * The Redis generation key's renewal (R-04, B1-02zi): every 60 seconds, worker only. Optional like
 * the other worker loops: a context without the provider, a null provider (APP_ENV local / test,
 * or no REDIS) or a stop already requested → no timer, no crash, no log.
 */
function startGenerationRenewal(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
): { stop(): void } | undefined {
  if (stopping()) return undefined;
  let renewal: Partial<RedisGenerationRenewal> | null | undefined;
  try {
    renewal = resolve() as Partial<RedisGenerationRenewal> | null | undefined;
  } catch {
    return undefined;
  }
  if (stopping() || typeof renewal?.renew !== 'function') return undefined;
  return startRedisGenerationRenewal({ renewal: renewal as RedisGenerationRenewal, logger });
}

/**
 * The entry's internal Prometheus /metrics listener (B1-01zzh): only when METRICS_PORT is set.
 * Every entry exports process-level metrics; only the worker passes `collect` (whole-database
 * gauges read through its own handle at scrape time) and, since B1-01zzi, `collectFund` (the fund
 * gauges from the orders, settlement and payout read ports; the worker hands it in wrapped by
 * `cacheFundCollector`, B1-01zzo) and, since B1-01zzp, `collectAutoPayout` (today's automatic
 * total against the cap, cached per +08:00 day) and, since B2-05o, `collectReviewOverdue` (the
 * withdrawals judged review-overdue still waiting, payout's read-only port). Not on the Nest
 * application, not in the OAS.
 */
async function openMetrics(
  entry: EntryName,
  config: AppConfig,
  logger: RootLogger,
  collectors?: {
    readonly collect: () => Promise<WorkerMetricsSnapshot>;
    readonly collectFund: () => Promise<FundMetricsSnapshot>;
    readonly collectAutoPayout: () => Promise<AutoPayoutDailySnapshot>;
    readonly collectReviewOverdue: () => Promise<ReviewOverdueSnapshot>;
  },
): Promise<MetricsServer | undefined> {
  if (config.metrics === undefined) return undefined;
  const registry = createMetricsRegistry(
    collectors === undefined ? { entry } : { entry, ...collectors },
  );
  const server = await startMetricsServer({
    host: config.metrics.host,
    port: config.metrics.port,
    registry,
  });
  logger.info({ host: config.metrics.host, port: server.port }, 'metrics_listening');
  return server;
}

/**
 * The cap of the auto-payout gauge (B1-01zzp, D10-393 (c)): B2-11c's own reading of
 * platform_daily_max_fen, so an absent or malformed row alerts on the default the decision
 * executes with. The decision logs the fallback; the scrape does not repeat it.
 */
const payoutCapFenOf: AutoPayoutCapFenOf = (snapshot) =>
  autoPayoutConfigOf(snapshot, () => undefined).config.platform_daily_max_fen;

/**
 * The worker's fund gauges (B1-01zzi) through each module's read-only port over the worker's own
 * database handle, read in parallel at scrape time. Any port rejecting rejects the whole snapshot:
 * no value is replaced by 0, so a failed read fails the scrape visibly.
 */
async function collectFundMetrics(db: DbHandles['db'], clock: Clock): Promise<FundMetricsSnapshot> {
  const [orderSyncPendingOpen, settlement, payout] = await Promise.all([
    readOrderSyncPendingOpen(db),
    readSettlementFundMetrics(db, clock),
    readPayoutFundMetrics(db),
  ]);
  return {
    orderSyncPendingOpen,
    billJobsFailed: settlement.billJobsFailed,
    partialBatches: settlement.partialBatches,
    beneficiariesHeldOver30Days: settlement.beneficiariesHeldOver30Days,
    payingNeedsManual: payout.payingNeedsManual,
  };
}

/** Closes the metrics listener during a failed startup without masking the startup error. */
async function closeQuietly(server: MetricsServer | undefined, logger: RootLogger): Promise<void> {
  try {
    await server?.close();
  } catch (error) {
    logger.warn({ err: error }, 'metrics_close_failed');
  }
}

/** A start step whose rejection marks the startup as failed before any cleanup runs. */
function failFirst(
  signals: StartupSignals,
  part: { start(): Promise<void>; stop(): Promise<void> },
): { start(): Promise<void>; stop(): Promise<void> } {
  return {
    start: () =>
      part.start().catch((error: unknown) => {
        signals.fail();
        throw error;
      }),
    stop: () => part.stop(),
  };
}

async function start(
  entry: EntryName,
  config: AppConfig,
  logger: RootLogger,
  dbHandles: DbHandles,
  maintHandle: MaintDbHandle | null,
  redisUrl: ConnectionConfig['redisUrl'],
  signals: StartupSignals,
): Promise<void> {
  // R-04 (B1-02zi, 9.2 #5): the entry injects the Redis generation switch by APP_ENV (staging /
  // prod on, local / test off) before the application is built.
  armRedisGeneration(config.appEnv, logger);
  if (isHttpEntry(entry)) {
    // startQueue: false — this runner starts JOB_QUEUE itself below, after init and its exit /
    // signal checks and before listen, so the production start order stays as it was (B1-12g).
    const app = await createHttpApp(entry, {
      config,
      logger,
      dbHandles,
      redisUrl,
      startQueue: false,
    });
    let metricsServer: MetricsServer | undefined;
    const close = async (): Promise<void> => {
      try {
        await metricsServer?.close();
      } finally {
        await app.close();
      }
    };
    try {
      if (signals.stopping()) {
        await signals.stop(close);
        return;
      }
      await app.init();
      if (config.exitAfterInit) {
        logger.info({ listening: false }, 'started');
        await app.close();
        return;
      }
      if (signals.stopping()) {
        await signals.stop(close);
        return;
      }
      await app.get<QueueRuntime>(JOB_QUEUE).start();
      // A signal during queue start: never open the port, just close.
      if (signals.stopping()) {
        await signals.stop(close);
        return;
      }
      const port = portOf(entry, config);
      await app.listen(port, config.apiHost);
      metricsServer = await openMetrics(entry, config, logger);
      await signals.serve(close, { listening: true, host: config.apiHost, port });
    } catch (error) {
      signals.fail();
      await closeQuietly(metricsServer, logger);
      await app.close();
      throw error;
    }
    return;
  }

  if (entry === 'worker') {
    const clock = clockFromConfig(config);
    const context = await createWorkerContext(entry, {
      config,
      logger,
      dbHandles,
      clock,
      redisUrl,
    });
    let servicesOwnCleanup = false;
    let metricsServer: MetricsServer | undefined;
    try {
      if (config.exitAfterInit) {
        logger.info({ listening: false }, 'started');
        return;
      }
      const queue = context.get<QueueRuntime>(JOB_QUEUE);
      wireIdempotencyPurge(() => context.get<unknown>(IDEMPOTENCY, { strict: false }), queue);
      const maintenance =
        maintHandle === null
          ? null
          : createWorkerMaintenance({
              db: maintHandle.db,
              logger,
              clock,
            });
      servicesOwnCleanup = true;
      // A failed start step marks the failure (failFirst) before startWorkerServices cleans up,
      // so a signal during that cleanup logs no `stopping` (B1-01zs).
      const services = await startWorkerServices({
        queue: failFirst(signals, queue),
        maintenance: maintenance === null ? null : failFirst(signals, maintenance),
        logger,
        close: [
          () => context.close(),
          ...(maintHandle === null ? [] : [() => maintHandle.close()]),
        ],
      });
      // Startup owns cleanup until here. A signal during startup stops the services now: no
      // `started` line and no keep-alive timer (B1-01t contract 7 c).
      if (signals.stopping()) {
        await signals.stop(() => services.stop());
        return;
      }
      // The /metrics listener (B1-01zzh), opened once the services run and no stop was requested.
      // A failed listen stops the services it would otherwise leave running, then fails startup.
      try {
        metricsServer = await openMetrics(entry, config, logger, {
          collect: () => collectWorkerMetrics(dbHandles.db, clock),
          // Cached for 5 minutes (B1-01zzo): the held-beneficiary count groups a whole table.
          // A failed collection is not cached and never falls back to an older snapshot.
          collectFund: cacheFundCollector(() => collectFundMetrics(dbHandles.db, clock), clock),
          // The auto-payout daily gauges (B1-01zzp), cached the same way and per +08:00 day.
          collectAutoPayout: cacheAutoPayoutCollector(
            () => collectAutoPayoutDaily(dbHandles.db, clock, payoutCapFenOf),
            clock,
          ),
          // The review overdue gauge (B2-05o; BR-WDR-24): payout's read-only port, cached the same
          // way; a failed read fails the scrape (no 0 in its place) and is read again next time.
          collectReviewOverdue: cacheReviewOverdueCollector(
            () => readPayoutReviewOverdue(dbHandles.db),
            clock,
          ),
        });
      } catch (error) {
        signals.fail();
        await services.stop();
        throw error;
      }
      const servedMetrics = metricsServer;
      // The risk-scan chain (B1-03j): its current-slot seeds, now that the queue runs. A failed
      // seed is a warn line only; a signal that arrived meanwhile sends nothing.
      const resolveScan = (): unknown => context.get<unknown>(riskScanToken(), { strict: false });
      await seedRiskScan(resolveScan, logger, () => signals.stopping());
      // The chain's self-heal (B1-03u): re-sends both next slots every five minutes, so a failed
      // continuation does not stop the scans until the next worker start. Started even after a
      // failed seed; stopped first on shutdown, before the services.
      const heal = startRiskScanHeal(resolveScan, logger, () => signals.stopping());
      // The Redis generation key's renewal (R-04, B1-02zi): every 60 seconds under APP_ENV
      // staging / prod; stopped with the heal on shutdown.
      const generation = startGenerationRenewal(
        () => context.get<unknown>(redisGenerationRenewalToken(), { strict: false }),
        logger,
        () => signals.stopping(),
      );
      // The paid bank-card verification records' takeover / recheck (B1-13g, BR-WDR-02 ⑦): a
      // 60-second timer, no immediate round. Not started once a stop was requested; stopped first
      // on shutdown, waiting for its current row, before anything else closes. Optional like the
      // agent and order-sync runtimes: a context without the provider (older or isolated worker
      // contexts) resolves to null, so no timer, no crash and no log line.
      const recheck = signals.stopping()
        ? undefined
        : startPayoutVerifyRecheck(
            () => {
              try {
                return context.get<unknown>(payoutVerifyRecheckToken(), { strict: false });
              } catch {
                return null;
              }
            },
            logger,
            () => signals.stopping(),
          );
      // The cooling-period expiry of deletion requests (B1-15f, BR-ID-27): a 60-second timer, no
      // immediate round, started after the recheck; on shutdown it is stopped after the recheck
      // drained and waited for (its current request) before the services stop. A context without
      // the provider resolves to null: no timer, no crash, no log line.
      const expiry = signals.stopping()
        ? undefined
        : startDeletionExpiry(
            () => {
              try {
                return context.get<unknown>(deletionExpiryToken(), { strict: false });
              } catch {
                return null;
              }
            },
            logger,
            () => signals.stopping(),
          );
      let runtime: Partial<AgentSweeperRuntime> | null | undefined;
      if (!signals.stopping()) {
        try {
          runtime = context.get<Partial<AgentSweeperRuntime> | null | undefined>(
            agentSweeperToken(),
            { strict: false },
          );
        } catch {
          // Older or isolated worker contexts may not provide the optional runtime.
        }
      }
      const loop =
        !signals.stopping() &&
        runtime !== (queue as unknown) &&
        typeof runtime?.start === 'function'
          ? runtime.start()
          : undefined;
      // Order sync (B1-08n): the scheduler's timer loops, started once the queue runs (nothing is
      // dispatched at start). Optional like the agent runtime: a throw, null, a value without a
      // start function, a failing start or a stop already requested → no loops, no crash, no log.
      const sync = startOrderSync(
        () => context.get<unknown>(orderSyncToken(), { strict: false }),
        queue,
        () => signals.stopping(),
      );
      // The invite reward scan (B1-35): payout every 60 seconds and the daily expiry, started once
      // the queue runs; stopped first on shutdown, waiting for its round in flight.
      const reward = startInviteReward(
        () => context.get<unknown>(inviteRewardScannerToken(), { strict: false }),
        logger,
        () => signals.stopping(),
      );
      const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
      await signals.serve(
        async () => {
          try {
            try {
              try {
                // Stop being scraped first: collect reads through handles closed below.
                await servedMetrics?.close();
              } finally {
                try {
                  await reward?.stop();
                } finally {
                  try {
                    await recheck?.stop();
                  } finally {
                    await expiry?.stop();
                  }
                }
              }
            } finally {
              heal.stop();
              generation?.stop();
              try {
                try {
                  await sync?.stop();
                } finally {
                  await loop?.stop();
                }
              } finally {
                await services.stop();
              }
            }
          } finally {
            clearInterval(keepAlive);
          }
        },
        { listening: false },
      );
    } catch (error) {
      signals.fail();
      await closeQuietly(metricsServer, logger);
      throw error;
    } finally {
      if (!servicesOwnCleanup) {
        try {
          await context.close();
        } finally {
          await maintHandle?.close();
        }
      }
    }
    return;
  }

  // payout: PAYOUT_MODE first (BR-WDR-13: default dry_run; live only in prod with every credential
  // variable set): a refusal is a ConfigError naming variables only, before anything is built.
  const decision = resolvePayoutMode(config.appEnv, process.env);
  // payout: redisUrl is null (it never reads Redis, ADR-0001 §4.2 #20), so no REDIS provider.
  const context = await createWorkerContext(entry, { config, logger, dbHandles, redisUrl });
  const queue = context.get<QueueRuntime>(JOB_QUEUE);
  if (config.exitAfterInit) {
    logger.info({ listening: false, payout_mode: decision.mode }, 'started');
    await context.close();
    return;
  }
  if (signals.stopping()) {
    await signals.stop(() => context.close());
    return;
  }
  let metricsServer: MetricsServer | undefined;
  let recovery: { stop(): Promise<void> } | undefined;
  try {
    // Queue `payout`'s handler is registered before the queue starts (B2-06f).
    const runtime = startPayoutRuntime(
      () => context.get<unknown>(payoutRuntimeToken(), { strict: false }),
      queue,
      decision,
    );
    await queue.start();
    recovery = startPayoutRecovery(runtime, () => signals.stopping());
    // B1-01zzh: process-level metrics only; payout never reads business tables for them.
    metricsServer = await openMetrics(entry, config, logger);
  } catch (error) {
    signals.fail();
    // The round in flight needs the queue and the database (D10-553): it stops first.
    await recovery?.stop();
    await closeQuietly(metricsServer, logger);
    await queue.stop();
    await context.close();
    throw error;
  }
  const servedMetrics = metricsServer;
  const servedRecovery = recovery;
  // Keep entries alive even while no business module has registered a handler.
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
  await signals.serve(
    async () => {
      try {
        try {
          await servedRecovery?.stop();
          await servedMetrics?.close();
        } finally {
          await queue.stop();
          await context.close();
        }
      } finally {
        clearInterval(keepAlive);
      }
    },
    { listening: false },
  );
}

/**
 * Loads the configuration, builds the entry and logs one structured `started` line.
 * With COULI_EXIT_AFTER_INIT=1 the entry initialises, closes and lets the process exit with
 * code 0 without opening a port. Any startup failure is logged and sets exit code 1.
 */
export async function runEntry(entry: EntryName): Promise<void> {
  let config: AppConfig | undefined;
  let connections: ConnectionConfig | undefined;
  let maintConnection: MaintConnectionConfig | null = null;
  const problems: string[] = [];
  try {
    try {
      config = loadConfig(process.env, entry);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    try {
      connections = loadConnectionConfig(entry, process.env);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    try {
      maintConnection = loadMaintConnectionConfig(entry, process.env);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    if (problems.length > 0) throw new ConfigError(problems);
  } catch (error) {
    const logger = createRootLogger({ level: 'error', entry, appEnv: 'unknown' });
    if (error instanceof ConfigError) {
      logger.fatal({ problems: error.problems }, 'config_invalid');
    } else {
      logger.fatal({ err: error }, 'config_invalid');
    }
    process.exitCode = 1;
    return;
  }
  if (config === undefined || connections === undefined) return;
  const logger = createRootLogger({
    level: config.logLevel,
    entry,
    appEnv: config.appEnv,
    deployVersion: config.deployVersion,
  });
  let handles: DbHandles | undefined;
  let maintHandle: MaintDbHandle | null = null;
  // Installed before anything is created; removed only after a failed startup's cleanup, so a
  // signal during that cleanup neither logs `stopping` nor ends the process early (B1-01zs).
  // B1-31: tracing (idempotent: main.<entry>.ts started it before this module was loaded, so
  // this is a no-op there; a direct runEntry call starts it here, before the application is
  // built). The signal watchers and the database handles stay synchronous, as before (B1-01t).
  // Tracing stops with the entry: after the entry's close on a signal (watchSignals), after a
  // startup failure's cleanup, or right away with COULI_EXIT_AFTER_INIT — never while it serves.
  let tracing: TracingHandle | undefined;
  const signals = watchSignals(logger, !config.exitAfterInit, async () => {
    await tracing?.shutdown();
  });
  try {
    handles = createDbHandles(connections, { logger });
    if (maintConnection !== null) maintHandle = createMaintDbHandle(maintConnection, { logger });
    tracing = await startTracing({ entry, config, logger });
    await start(entry, config, logger, handles, maintHandle, connections.redisUrl, signals);
    if (config.exitAfterInit) await tracing.shutdown();
  } catch (error) {
    signals.fail();
    try {
      await handles?.close();
      await maintHandle?.close();
      logger.fatal({ err: error }, 'startup_failed');
      process.exitCode = 1;
    } finally {
      signals.detach();
      // B1-31b: a startup that failed before startTracing returned (createDbHandles threw) still
      // flushes the tracing main.<entry>.ts booted; nothing is started here.
      await (tracing ?? activeTracing())?.shutdown();
    }
  }
}
