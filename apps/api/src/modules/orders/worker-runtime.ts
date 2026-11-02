// B1-08n: the worker's order-sync assembly (规划/02 §7.1～§7.3). OrdersModule.forWorker (orders.module.ts)
// calls createOrderSyncRuntime once with the worker's handles; entry.ts later calls start() once.
// - Building the runtime runs no query, sends nothing and arms no timer: it reads
//   specs/order-status-map/<platform>.csv once per scheduled platform (a missing file is
//   MISSING_STATUS_MAP, any other read error is rethrown: the worker does not start), wraps every
//   configured union adapter once in the worker's own governance (offline breaker readable by the
//   access port; breakers per process, 待裁定 6; the quota bucket comes from ports.quota — B1-22v:
//   app.module's shared Redis bucket, whose answer may be a promise the governor awaits), builds the cursor store, the update
//   step (B1-08i) and the attribution pipeline (B1-08h) over the platform EVENT_BUS, and registers
//   the order-sync handler. The scheduler and the handler share the same access instance.
// - start() starts the scheduler's timer loops only (createOrderSyncScheduler); every call starts
//   one more set (entry.ts calls it once).
// - B1-08t: with the optional commission snapshot port injected, the update step and the pipeline
//   get it, the order-sync handler routes 'snapshot_retry' jobs to the compensation scan
//   (jobs/snapshot-retry.ts, with the runtime's events for its B1-08u exhausted alert), and start()
//   also arms the scan's dispatch timer (every 15 minutes);
//   stop() stops both and waits for the round in flight. Without it nothing of B1-08t runs: no
//   routing, no query, no timer. B1-08w: the production worker injects it (OrdersModule.forWorker
//   over app.module's commission snapshot port); a runtime built directly without it is unchanged.
// Other modules' readers come in as ports from app.module (identity users, linking bindings, the
// quota limiter, B1-08q's source backfill ports); union's are read through union/index.ts. orders
// never imports linking, identity, catalog or content.
// - B1-08q: when ports.sources is given, one OrderSourcePorts object is built at assembly (no read)
//   and the same object goes to the pipeline and the update step; the update step also gets the
//   pipeline's pids reader so its backfill knows the order's pid_scene (D10-60).
// - B1-09b: when ports.blocklist is given (risk's order-side blocklist ports, from app.module), one
//   OrderBlacklistDeps object is built at assembly (no read) and goes to the pipeline and the update
//   step: step ③ (BR-ATTR-26) runs. The Taobao suffix switch is read through
//   ports.suffixVoidEnabled; absent → false, the 08 default (suffix hits only recorded for review).
//   Without rebate.onBlacklistHit (a runtime built without ports.rebate) an uncredited hit is
//   recorded as manual_review with a P1 warning and the order is left unchanged.
// - B1-09n: ports.rebate (app.module's factory over settlement) gives the one rebate port of the
//   sync: the pipeline and the update step get the same object. Absent → NO_REBATE_PORT below.
// - B1-08zc: when ports.platformRestore is given (ledger's registerReconDiffOnce as orders' port, from
//   app.module), it is built once at assembly (no read) and goes to the update step: a VOID /
//   CLAWED_BACK order restored by the platform registers one platform_restore recon diff
//   (BR-FUND-22) in the update's transaction. Absent → nothing is registered.
// - B1-09g: the order-sync handler routes job name 'rights_import' (the admin Excel import tasks,
//   sent by application/rights-imports.ts) to jobs/rights-import.ts with the runtime's db, clock and
//   logger plus `rightsImports` (the import store, the column template registry and the per-kind row
//   processors). Without `rightsImports` such a job throws, so the queue retries and dead-letters it
//   (nothing of a task is touched); the other job names are routed as before.
// - B1-04zm: job name 'rescan.window' is routed to jobs/order-rescan.ts on both branches, and
//   scheduledPlatforms() are the platforms it accepts. With ports.rescanConfig given, start() also
//   arms the rescan loops of those platforms and stop() stops them; absent → no rescan timer.
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { readFileSync } from 'node:fs';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  systemScheduler,
  type Clock,
  type EventBus,
  type QueueRuntime,
  type QuotaLimiter,
  type ImportStore,
  type ReceivedJob,
  type RootLogger,
  type Scheduler,
} from '../platform/index.ts';
import {
  REGISTERED_PLATFORMS,
  createGovernedSyncAdapter,
  createUnionOrderReaders,
  createUnionSyncAccess,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionRegistry,
} from '../union/index.ts';
import { ORDER_RESCAN_JOB, createOrderRescanScheduler } from './application/order-rescan.ts';
import { createOrderPipeline } from './application/pipeline-port.ts';
import type { OrderPipelineDeps, OrderPipelinePort } from './application/pipeline-types.ts';
import type { OrderSourcePorts } from './application/source-backfill.ts';
import type {
  OrderBlacklistDeps,
  OrderBlacklistPorts,
  OrderBlacklistRebatePort,
} from './application/blacklist-step.ts';
import type {
  SyncAccessPort,
  SyncCursorStore,
  SyncLogger,
  SyncRegistry,
} from './application/sync-ports.ts';
import {
  ORDER_SYNC_QUEUE,
  createOrderSyncScheduler,
  type SyncIntervalConfig,
} from './application/sync-scheduler.ts';
import { createOrderUpdateStep, type OrderUpdateDeps } from './application/update-step.ts';
import type { CommissionSnapshotPort } from './application/commission-snapshot-step.ts';
import type { PlatformRestoreDiffPort } from './application/platform-restore-step.ts';
import { SNAPSHOT_RETRY_SCAN_INTERVAL_MS } from './domain/snapshot-retry.ts';
import { listSnapshotRetryAppIds } from './infra/snapshot-retry-store.ts';
import {
  SNAPSHOT_RETRY_JOB,
  createSnapshotRetryScheduler,
  handleSnapshotRetry,
} from './jobs/snapshot-retry.ts';
import { loadStatusMap, type StatusMap } from './domain/status-map.ts';
import { scheduledPlatforms } from './domain/sync-window.ts';
import { createRescanCursorStore, createSyncCursorStore } from './infra/sync-cursors.ts';
import { handleOrderRescanWindow } from './jobs/order-rescan.ts';
import { handleOrderSyncWindow } from './jobs/order-sync.ts';
import type {
  RightsImportProcessors,
  RightsImportTemplates,
} from './application/rights-import-ports.ts';
import { RIGHTS_IMPORT_JOB } from './application/rights-imports.ts';
import { handleRightsImport } from './jobs/rights-import.ts';
import { handleManualSyncJob, isManualSyncJob } from './jobs/manual-sync.ts';
import { createOrderSyncRequestProgress } from './infra/order-sync-requests.ts';

export interface OrderSyncRuntime {
  readonly access: SyncAccessPort;
  readonly cursors: SyncCursorStore;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
  readonly statusMaps: (platform: RegisteredPlatform) => StatusMap;
  readonly logger: SyncLogger;
  start(): { stop(): Promise<void> };
}

/**
 * B1-09n: every rebate hook of the sync, one object: the attribution pipeline and the update step
 * get this same instance (settlement's createRebatePort plus onBlacklistHit over its BLACKLIST_HIT).
 */
export type OrderSyncRebatePort = OrderPipelineDeps['rebate'] &
  OrderUpdateDeps['rebate'] &
  OrderBlacklistRebatePort;

/** B1-09n: what the production rebate port is built over; building it reads nothing. */
export interface OrderRebateAssembly {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly events: Pick<EventBus, 'publish'>;
}

/** B1-09n: app.module's factory: built on the first call, the same instance on every later one. */
export type OrderRebatePortFactory = (assembly: OrderRebateAssembly) => OrderSyncRebatePort;

/** Readers and limits owned by other modules, assembled in app.module (orders imports neither). */
export interface OrderSyncReadPorts {
  /** identity: users.attr_code → user_id in one App, any status. */
  readonly users: (db: Kysely<DB>) => OrderPipelineDeps['users'];
  /** linking: union_bindings of (App, account, relation_id), any status. */
  readonly bindings: (db: Kysely<DB>) => OrderPipelineDeps['bindings'];
  /**
   * The quota bucket of one platform's governed adapter (endpoint.quotaKey), called once per
   * endpoint while the runtime is built. B1-22v: app.module gives the union bucket shared by every
   * process (tryAcquire may answer with a promise; the governor awaits it).
   */
  readonly quota: (endpoint: UnionEndpoint, scheduler: Scheduler) => QuotaLimiter;
  /**
   * B1-08q: the source backfill ports (BR-ATTR-15; linking's link_logs, catalog's key prefixes,
   * content's config_items), called once at assembly and reading nothing until used. Absent (a
   * runtime built without them) → no source backfill: the four source columns stay NULL.
   */
  readonly sources?: (db: Kysely<DB>, clock: Clock, logger: RootLogger) => OrderSourcePorts;
  /**
   * B1-09b: risk's order-side blocklist ports (match / recordHit, B1-09a), called once at assembly
   * and reading nothing until used. Absent, or B1-09n undefined (no field keyring in local / test;
   * app.module refuses that elsewhere) → step ③ (BR-ATTR-26) is skipped.
   */
  readonly blocklist?: (db: Kysely<DB>, clock: Clock) => OrderBlacklistPorts | undefined;
  /**
   * B1-09b: attr.blacklist.order_suffix_void_enabled of one App. Absent → always false (08 default:
   * suffix hits are only recorded for manual review).
   */
  readonly suffixVoidEnabled?: (
    db: Kysely<DB>,
    clock: Clock,
  ) => (appId: string) => Promise<boolean>;
  /**
   * B1-08zc: ledger's recon diff registration as the platform-restore port (BR-FUND-22), called once
   * at assembly with the worker's clock and reading nothing until used. Absent → the update step
   * registers no platform_restore diff (the P9 warning stays).
   */
  readonly platformRestore?: (clock: Clock) => PlatformRestoreDiffPort;
  /**
   * B1-09n: app.module's rebate port factory (FU-REBATE-PORT-WIRING). A runtime built directly
   * without it keeps a no-op port; the production worker always gives it.
   */
  readonly rebate?: OrderRebatePortFactory;
  /**
   * B1-04zm: reads order_sync.rescan.<platform>.enabled / .days, called once at assembly and
   * reading nothing until used. Absent → no rescan timer; 'rescan.window' jobs are routed either way.
   */
  readonly rescanConfig?: (db: Kysely<DB>, clock: Clock) => SyncIntervalConfig;
}

export interface OrderSyncRuntimeDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly queue: QueueRuntime;
  readonly events: EventBus;
  readonly endpoints: readonly UnionEndpoint[];
  readonly registry: UnionRegistry;
  readonly ports: OrderSyncReadPorts;
  /** B1-08k / B1-08t: commission's snapshot port; absent → step ⑥ and the compensation retry are off. */
  readonly snapshots?: CommissionSnapshotPort;
  /** B1-09g: what the rights_import job needs besides db, clock and logger; absent → it throws. */
  readonly rightsImports?: OrderRightsImportDeps;
}

/** B1-09g: the import store and the registries the rights_import job reads. */
export interface OrderRightsImportDeps {
  readonly store: ImportStore;
  readonly templates: RightsImportTemplates;
  readonly processors: RightsImportProcessors;
}

const ORDER_SYNC = Symbol('ORDER_SYNC');

/** The DI token of the worker's order-sync runtime; the same symbol on every call. */
export function orderSyncToken(): symbol {
  return ORDER_SYNC;
}

/** One read of the platform's mapping file; a missing file is null (loadStatusMap refuses it). */
function readStatusMapCsv(platform: RegisteredPlatform): string | null {
  try {
    // specs/ at the repository root; same depth from src/ and dist/.
    return readFileSync(
      new URL(`../../../../../specs/order-status-map/${platform}.csv`, import.meta.url),
      'utf8',
    );
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

function loadStatusMaps(): (platform: RegisteredPlatform) => StatusMap {
  const maps = new Map<RegisteredPlatform, StatusMap>();
  for (const platform of scheduledPlatforms()) {
    maps.set(platform, loadStatusMap(platform, readStatusMapCsv(platform)));
  }
  return (platform) => maps.get(platform) ?? loadStatusMap(platform, null);
}

// TODO(规划/11 §4.5): order_sync.<platform>.interval_seconds 的全局读法 — blocked on 平台级配置口径
const DEFAULT_INTERVAL: SyncIntervalConfig = { get: async () => undefined };

/**
 * B1-09n: a runtime built without ports.rebate (never the production worker): an attributed order
 * keeps the column default rebate_status. No onBlacklistHit, so a hit stays manual_review.
 */
const NO_REBATE_PORT: OrderPipelineDeps['rebate'] & OrderUpdateDeps['rebate'] = {
  onImported: async () => undefined,
  onUpdated: async () => undefined,
  onUnmappedStatus: async () => undefined,
};

export function createOrderSyncRuntime(deps: OrderSyncRuntimeDeps): OrderSyncRuntime {
  const { db, clock, logger, queue, events, endpoints } = deps;
  const statusMaps = loadStatusMaps();

  const scheduler = systemScheduler();
  const governed = new Map<
    RegisteredPlatform,
    { readonly adapter: UnionAdapter; offlineBreakerState(): 'closed' | 'open' }
  >();
  for (const platform of REGISTERED_PLATFORMS) {
    const endpoint = endpoints.find((entry) => entry.platform === platform);
    if (endpoint === undefined) continue;
    governed.set(
      platform,
      createGovernedSyncAdapter(deps.registry.get(platform), {
        endpoint,
        scheduler,
        quota: deps.ports.quota(endpoint, scheduler),
      }),
    );
  }
  const registry: SyncRegistry = {
    get(platform) {
      const entry = governed.get(platform);
      if (entry === undefined) throw new Error(`union: no endpoint for ${platform}`);
      return entry.adapter;
    },
  };
  const access: SyncAccessPort = createUnionSyncAccess({
    db,
    endpoints,
    breaker: (platform) => governed.get(platform)?.offlineBreakerState() ?? 'closed',
    logger,
  });
  const cursors = createSyncCursorStore(db, clock);

  const readers = createUnionOrderReaders(db);
  const users = deps.ports.users(db);
  const bindings = deps.ports.bindings(db);
  // B1-08q: one sources object for both steps (built here, read on use).
  const sources = deps.ports.sources?.(db, clock, logger);
  const snapshots = deps.snapshots;
  // B1-09b: one blacklist object for both steps (built here, read on use).
  const blocklist = deps.ports.blocklist?.(db, clock);
  const blacklist: OrderBlacklistDeps | undefined =
    blocklist === undefined
      ? undefined
      : {
          blocklist,
          suffixVoidEnabled: deps.ports.suffixVoidEnabled?.(db, clock) ?? (async () => false),
        };
  const platformRestore = deps.ports.platformRestore?.(clock);
  // B1-09n: one rebate object for both steps (built here, read on use).
  const rebate = deps.ports.rebate?.({ db, clock, logger, events }) ?? NO_REBATE_PORT;
  const updateStep = createOrderUpdateStep({
    clock,
    users,
    bindings,
    pids: readers.pids,
    statusMaps,
    logger,
    rebate,
    events,
    ...(sources === undefined ? {} : { sources }),
    ...(snapshots === undefined ? {} : { snapshots }),
    ...(blacklist === undefined ? {} : { blacklist }),
    ...(platformRestore === undefined ? {} : { platformRestore }),
  });
  const pipeline = createOrderPipeline({
    db,
    clock,
    statusMaps,
    pids: readers.pids,
    accounts: readers.accounts,
    users,
    bindings,
    rebate,
    updateStep,
    events,
    logger,
    ...(sources === undefined ? {} : { sources }),
    ...(snapshots === undefined ? {} : { snapshots }),
    ...(blacklist === undefined ? {} : { blacklist }),
  });

  const handler = { access, cursors, registry, pipeline, logger };
  const rightsImports = deps.rightsImports;
  const importJob = (job: ReceivedJob): Promise<void> => {
    if (rightsImports === undefined) {
      return Promise.reject(new Error('orders: rights_import is not configured on this worker'));
    }
    return handleRightsImport(job, { db, clock, logger, ...rightsImports });
  };
  // B1-09i: the console's manual sync jobs share the order-sync queue (jobs/manual-sync.ts).
  const manual = {
    access,
    registry,
    pipeline,
    requests: createOrderSyncRequestProgress(db, clock),
    logger,
  };
  const sync = createOrderSyncScheduler(
    { clock, queue, cursors, access, logger },
    DEFAULT_INTERVAL,
  );
  const rescanHandler = {
    access,
    cursors,
    registry,
    pipeline,
    platforms: scheduledPlatforms(),
    logger,
  };
  const windowJob = (job: ReceivedJob): Promise<void> =>
    job.name === ORDER_RESCAN_JOB
      ? handleOrderRescanWindow(job, rescanHandler)
      : handleOrderSyncWindow(job, handler);
  const rescanConfig = deps.ports.rescanConfig?.(db, clock);
  const rescan =
    rescanConfig === undefined
      ? undefined
      : createOrderRescanScheduler(
          {
            clock,
            queue,
            cursors: createRescanCursorStore(db, clock),
            access,
            logger,
            config: rescanConfig,
          },
          scheduledPlatforms(),
        );
  const startSync = (): { stop(): Promise<void> } => {
    const syncRunning = sync.start();
    const rescanRunning = rescan?.start();
    return {
      async stop() {
        await Promise.all([syncRunning.stop(), rescanRunning?.stop()]);
      },
    };
  };
  if (snapshots === undefined) {
    queue.register(ORDER_SYNC_QUEUE, (job) =>
      job.name === RIGHTS_IMPORT_JOB
        ? importJob(job)
        : isManualSyncJob(job)
          ? handleManualSyncJob(job, manual)
          : windowJob(job),
    );
    return {
      access,
      cursors,
      registry,
      pipeline,
      statusMaps,
      logger,
      start: startSync,
    };
  }
  // B1-08u: the scan publishes order.snapshot_retry_exhausted on the runtime's EVENT_BUS, in the
  // transaction of the manual hand-off mark.
  const retryDeps = { db, clock, snapshots, logger, events };
  queue.register(ORDER_SYNC_QUEUE, (job) =>
    job.name === SNAPSHOT_RETRY_JOB
      ? handleSnapshotRetry(job, retryDeps)
      : job.name === RIGHTS_IMPORT_JOB
        ? importJob(job)
        : isManualSyncJob(job)
          ? handleManualSyncJob(job, manual)
          : windowJob(job),
  );
  const retryScheduler = createSnapshotRetryScheduler({
    queue,
    listAppIds: () => listSnapshotRetryAppIds(db),
    intervalMs: SNAPSHOT_RETRY_SCAN_INTERVAL_MS,
    logger,
  });
  return {
    access,
    cursors,
    registry,
    pipeline,
    statusMaps,
    logger,
    start: () => {
      const syncRunning = startSync();
      const retryRunning = retryScheduler.start();
      return {
        async stop() {
          await Promise.all([syncRunning.stop(), retryRunning.stop()]);
        },
      };
    },
  };
}
