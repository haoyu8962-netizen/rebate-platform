// B1-04zza: Taobao-first refund (维权) and punishment (违规) sync on the order-sync queue (规划/02 §7.1;
// 08 BR-FUND-01 / 02 / 06 / 08; orchestrator D10-645, D10-676). Rule tests:
// test/spec/orders/taobao-rights-sync/**.
// - Which platforms: those whose (governed) adapter has listRefunds (rights) / listPunishments
//   (punish) and, when it declares rightsSources, a configured source behind them (Taobao without
//   its 大淘客 order source has none); registry.get throwing (no endpoint) counts as none. orders never compares platform
//   names. A platform without a source dispatches nothing and arms no timer.
// - Gates as the increment scheduler: queryableAccount (D10-36), the offline breaker, site auth.
// - rights increment stream (platform, account, 'rights', '-'): every 30 minutes one window from the
//   cursor (no cursor: the account's sync_start_at; none → nothing), at most 3 hours, ending no
//   later than now; job 'rights.window', singletonKey platform:account:kind:scene:window_start.
// - rights rescan stream (platform, account, 'rights', 'rescan'): a 60-day pass a day in 3-hour
//   windows (one window per 180-second tick), its own cursor; the increment cursor is never moved.
//   A pass's head is fixed once set: a first window slower than a tick does not move the cursor.
// - punish (platform, account, 'punish', '-'): every 30 minutes one 'punish.window' over
//   [now − 30 days, now); no cursor is read or moved (order_rights_dedupe_key dedupes).
// - The writer: one transaction per record: find the sub-order of (app, platform) → lockOrderKey →
//   re-read FOR UPDATE → settlement's rights.record (source API, now = the injected Clock). An
//   order we do not hold (another publisher's slot) is not_found: nothing written, nothing thrown.
import type { OrderRightsStatus } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobPayload, JobQueue } from '../../platform/index.ts';
import {
  REGISTERED_PLATFORMS,
  type RegisteredPlatform,
  type UnionAdapter,
} from '../../union/index.ts';
import { isoAt, nextWindow, parseInstantMs, windowSingletonKey } from '../domain/sync-window.ts';
import { rereadOrderForUpdate } from '../infra/admin-hold-store.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import { findOrderForRights } from '../infra/rights-order-lookup.ts';
import { recordOrderRights, type RightsCommandPort } from './rights-ports.ts';
import type { SyncAccessPort, SyncAccount, SyncLogger, SyncStream } from './sync-ports.ts';
import { ORDER_SYNC_QUEUE, type OrderSyncScheduler } from './sync-scheduler.ts';

/** Job names on the order-sync queue. */
export type RightsSyncJobName = 'rights.window' | 'punish.window';
export const RIGHTS_SYNC_JOB = 'rights.window' satisfies RightsSyncJobName;
export const PUNISH_SYNC_JOB = 'punish.window' satisfies RightsSyncJobName;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** 02 §7.1 (Taobao row): refunds and punishments are pulled every 30 minutes. */
export const RIGHTS_SYNC_ROUND_MS = 30 * MINUTE_MS;
/** Task brief §9 ③: one rights window spans at most 3 hours. */
export const RIGHTS_WINDOW_CAP_MS = 3 * 60 * MINUTE_MS;
/** 02 §7.1: the daily rescan covers the last 60 days. */
export const RIGHTS_RESCAN_DAYS = 60;
/** 60 days in 3-hour windows is 480 windows a day: one every 180 seconds. */
export const RIGHTS_RESCAN_TICK_MS = RIGHTS_WINDOW_CAP_MS / RIGHTS_RESCAN_DAYS;
/**
 * money r1 S2 ②: a pass keeps its own head. A cursor behind the moving head of the 60 days by less
 * than one pass period (a day) is the pass still at work on its first windows (a window queued or
 * slower than a tick), not a stale stream: it is left where it is, so the window's CAS from its
 * window_start still hits once the job is done.
 */
export const RIGHTS_RESCAN_RESTART_SLACK_MS = DAY_MS;
/** 02 §7.1: punishments can only be queried over the last 30 days. */
export const PUNISH_LOOKBACK_DAYS = 30;

/** A refund stream: '-' the 30-minute increment, 'rescan' the daily 60-day pass. */
export interface RightsStream extends SyncStream {
  readonly query_kind: 'rights';
  readonly scene: '-' | 'rescan';
}

export interface RightsSyncWindow extends RightsStream, JobPayload {
  readonly window_start: string;
  readonly window_end: string;
}

/** A punishment window: [now − 30 days, now) at dispatch; never a cursor. */
export interface PunishSyncWindow extends SyncStream, JobPayload {
  readonly query_kind: 'punish';
  readonly scene: '-';
  readonly window_start: string;
  readonly window_end: string;
}

/** sync_cursors over the rights streams (infra/sync-cursors.ts semantics). */
export interface RightsCursorStore {
  read(stream: SyncStream): Promise<string | null>;
  /** One transaction: insert if absent, otherwise CAS from window_start to window_end. */
  advance(window: RightsSyncWindow): Promise<boolean>;
  /** CAS of the stream's row from `expected` (null: insert when absent) to `to`. */
  rewind(stream: RightsStream, expected: string | null, to: string): Promise<boolean>;
}

/**
 * The governed adapters; a missing method means the platform has no such source, and so does an
 * adapter whose declared rightsSources says it cannot fetch as configured (money r1 S2 ①: Taobao
 * without its 大淘客 order source keeps the methods, which then fail adapter_unimplemented).
 */
export interface RightsSyncRegistry {
  get(
    platform: RegisteredPlatform,
  ): Pick<UnionAdapter, 'listRefunds' | 'listPunishments' | 'rightsSources'>;
}

export interface RightsSyncSchedulerDeps {
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly cursors: RightsCursorStore;
  readonly access: SyncAccessPort;
  readonly registry: RightsSyncRegistry;
  /** Flat fields only; never order numbers. */
  readonly logger?: SyncLogger;
}

/** The sub-order a record names: the union's order_id is the sub-order number. */
export interface RightsSyncTarget {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly sub_order_id: string;
}

/** What rights.record receives besides before / order_id / source / now. */
export interface RightsSyncItem {
  readonly type: 'RIGHTS' | 'PUNISH';
  readonly status: OrderRightsStatus;
  readonly amount_fen: bigint | null;
  readonly deduction_commission_fen: bigint | null;
  readonly occurred_at: Date;
  readonly platform_rights_no: string;
}

export type RightsSyncWriteResult = {
  readonly kind: 'applied' | 'duplicate' | 'not_applicable' | 'not_found';
};

export interface RightsSyncWriter {
  write(target: RightsSyncTarget, item: RightsSyncItem): Promise<RightsSyncWriteResult>;
}

export interface RightsSyncWriterDeps {
  readonly db: Kysely<DB>;
  /** RightsRecordInput.now. */
  readonly clock: Clock;
  /** settlement's rights.record, the only writer of order_rights. */
  readonly rights: RightsCommandPort;
}

interface Capability {
  readonly refunds: boolean;
  readonly punishments: boolean;
}

/**
 * What the platform's adapter offers: the method, and the source behind it when the adapter
 * declares its rightsSources; no adapter (registry.get throws) offers nothing.
 */
function capabilityOf(registry: RightsSyncRegistry, platform: RegisteredPlatform): Capability {
  let adapter: ReturnType<RightsSyncRegistry['get']>;
  try {
    adapter = registry.get(platform);
  } catch {
    return { refunds: false, punishments: false };
  }
  const sources = adapter.rightsSources;
  return {
    refunds: typeof adapter.listRefunds === 'function' && (sources?.refunds ?? true),
    punishments: typeof adapter.listPunishments === 'function' && (sources?.punishments ?? true),
  };
}

function memo<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const loaded = new Map<K, Promise<V>>();
  return (key) => {
    let value = loaded.get(key);
    if (value === undefined) {
      value = load(key);
      loaded.set(key, value);
    }
    return value;
  };
}

interface RoundGates {
  readonly capability: (platform: RegisteredPlatform) => Capability;
  readonly queryable: (platform: RegisteredPlatform) => Promise<string | null | undefined>;
  readonly circuitOpen: (platform: RegisteredPlatform) => Promise<boolean>;
}

function roundGates(deps: RightsSyncSchedulerDeps): RoundGates {
  const capabilities = new Map<RegisteredPlatform, Capability>();
  return {
    capability: (platform) => {
      let found = capabilities.get(platform);
      if (found === undefined) {
        found = capabilityOf(deps.registry, platform);
        capabilities.set(platform, found);
      }
      return found;
    },
    queryable: memo(async (platform) => deps.access.queryableAccount?.(platform)),
    circuitOpen: memo((platform) => deps.access.offlineCircuitOpen(platform)),
  };
}

/** The account gates of the increment scheduler: queryable account (D10-36), breaker, site auth. */
async function accountOpen(
  deps: RightsSyncSchedulerDeps,
  gates: RoundGates,
  account: SyncAccount,
  event: string,
): Promise<boolean> {
  const fields = { platform: account.platform, account: account.union_account_id };
  const queryable = await gates.queryable(account.platform);
  if (queryable !== undefined && queryable !== account.union_account_id) {
    deps.logger?.warn(
      { ...fields, reason: queryable === null ? 'no_queryable_account' : 'not_queryable_account' },
      `${event}_account_skipped`,
    );
    return false;
  }
  if (await gates.circuitOpen(account.platform)) {
    deps.logger?.info(fields, `${event}_skipped_circuit_open`);
    return false;
  }
  if (!(await deps.access.siteAuthAvailable(account))) {
    deps.logger?.info(fields, `${event}_paused_site_auth`);
    return false;
  }
  return true;
}

function streamOf(account: SyncAccount, scene: RightsStream['scene']): RightsStream {
  return {
    app_id: account.app_id,
    platform: account.platform,
    union_account_id: account.union_account_id,
    query_kind: 'rights',
    scene,
  };
}

async function sendWindow(
  deps: RightsSyncSchedulerDeps,
  name: RightsSyncJobName,
  payload: RightsSyncWindow | PunishSyncWindow,
): Promise<void> {
  const id = await deps.queue.send(ORDER_SYNC_QUEUE, name, payload, {
    trx: null,
    singletonKey: windowSingletonKey(payload),
  });
  deps.logger?.info(
    {
      platform: payload.platform,
      account: payload.union_account_id,
      query_kind: payload.query_kind,
      scene: payload.scene,
      window_start: payload.window_start,
      window_end: payload.window_end,
      queued: id !== null,
    },
    'order_rights_sync_window_dispatched',
  );
}

/**
 * Runs `each` over every enabled account; accounts are independent, and the first failure is
 * rethrown after the round so the caller logs it.
 */
async function eachAccount(
  deps: RightsSyncSchedulerDeps,
  event: string,
  each: (account: SyncAccount) => Promise<void>,
): Promise<void> {
  const accounts = await deps.access.listEnabledAccounts();
  let failure: { error: unknown } | undefined;
  for (const account of accounts) {
    try {
      await each(account);
    } catch (error) {
      deps.logger?.error(
        { platform: account.platform, account: account.union_account_id, err: error },
        `${event}_account_failed`,
      );
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** One 30-minute round: a rights increment window and a punish window per eligible account. */
export async function scheduleRightsSync(deps: RightsSyncSchedulerDeps): Promise<void> {
  const gates = roundGates(deps);
  await eachAccount(deps, 'order_rights_sync_schedule', async (account) => {
    const capability = gates.capability(account.platform);
    if (!capability.refunds && !capability.punishments) return;
    if (!(await accountOpen(deps, gates, account, 'order_rights_sync'))) return;
    const now = deps.clock.now();
    if (capability.refunds) await dispatchIncrement(deps, account, now);
    if (capability.punishments) {
      const payload: PunishSyncWindow = {
        app_id: account.app_id,
        platform: account.platform,
        union_account_id: account.union_account_id,
        query_kind: 'punish',
        scene: '-',
        window_start: isoAt(now, now.getTime() - PUNISH_LOOKBACK_DAYS * DAY_MS),
        window_end: isoAt(now, now.getTime()),
      };
      await sendWindow(deps, PUNISH_SYNC_JOB, payload);
    }
  });
}

/** The next window of the increment stream from its cursor (no cursor: sync_start_at). */
async function dispatchIncrement(
  deps: RightsSyncSchedulerDeps,
  account: SyncAccount,
  now: Date,
): Promise<void> {
  const stream = streamOf(account, '-');
  const from = (await deps.cursors.read(stream)) ?? account.sync_start_at;
  if (from === null) {
    deps.logger?.warn(
      { platform: account.platform, account: account.union_account_id },
      'order_rights_sync_no_start',
    );
    return;
  }
  const bounds = nextWindow(parseInstantMs(from, 'cursor_at'), now, RIGHTS_WINDOW_CAP_MS);
  if (bounds === null) return;
  await sendWindow(deps, RIGHTS_SYNC_JOB, { ...stream, ...bounds });
}

/** One tick of the daily 60-day rights pass: one window per eligible account. */
export async function scheduleRightsRescan(deps: RightsSyncSchedulerDeps): Promise<void> {
  const gates = roundGates(deps);
  await eachAccount(deps, 'order_rights_rescan_schedule', async (account) => {
    if (!gates.capability(account.platform).refunds) return;
    if (!(await accountOpen(deps, gates, account, 'order_rights_rescan'))) return;
    const fields = { platform: account.platform, account: account.union_account_id };
    if (account.sync_start_at === null) {
      deps.logger?.warn(fields, 'order_rights_rescan_no_start');
      return;
    }
    const stream = streamOf(account, 'rescan');
    const now = deps.clock.now();
    const nowMs = now.getTime();
    const rangeStartMs = nowMs - RIGHTS_RESCAN_DAYS * DAY_MS;
    const cursor = await deps.cursors.read(stream);
    const cursorMs = cursor === null ? null : parseInstantMs(cursor, 'cursor_at');
    // A pass starts at the head of the 60 days: no cursor yet, a cursor older than the range by
    // more than the slack (a pass under way trails the moving head by less), or a cursor without
    // a whole window left before now (the increment stream covers that tail).
    const restart =
      cursorMs === null ||
      cursorMs < rangeStartMs - RIGHTS_RESCAN_RESTART_SLACK_MS ||
      cursorMs + RIGHTS_WINDOW_CAP_MS > nowMs;
    const startMs = restart ? rangeStartMs : cursorMs;
    // Moved first, so the window's CAS from window_start hits; a stream with no row has nothing to
    // move (the window's advance inserts it). A lost CAS sends nothing this tick.
    if (cursor !== null && cursorMs !== startMs) {
      if (!(await deps.cursors.rewind(stream, cursor, isoAt(now, startMs)))) {
        deps.logger?.info(fields, 'order_rights_rescan_cursor_moved');
        return;
      }
      deps.logger?.info(
        { ...fields, cursor_at: isoAt(now, startMs) },
        'order_rights_rescan_restart',
      );
    }
    const bounds = nextWindow(startMs, now, RIGHTS_WINDOW_CAP_MS);
    if (bounds === null) return;
    await sendWindow(deps, RIGHTS_SYNC_JOB, { ...stream, ...bounds });
  });
}

/** A self-rearming timer loop; a failed round is logged only and the next one runs as usual. */
function startLoop(
  deps: RightsSyncSchedulerDeps,
  periodMs: number,
  event: string,
  round: (deps: RightsSyncSchedulerDeps) => Promise<void>,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const arm = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      running = tick();
    }, periodMs);
  };
  const tick = async (): Promise<void> => {
    try {
      await round(deps);
    } catch (error) {
      deps.logger?.error({ err: error }, `${event}_round_failed`);
    }
    if (!stopped) arm();
  };
  arm();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}

/** Starts timers only (platforms with a source); construction and start dispatch nothing. */
export function createRightsSyncScheduler(deps: RightsSyncSchedulerDeps): OrderSyncScheduler {
  return {
    start() {
      const capabilities = REGISTERED_PLATFORMS.map((platform) =>
        capabilityOf(deps.registry, platform),
      );
      const loops: { stop(): Promise<void> }[] = [];
      if (capabilities.some((c) => c.refunds || c.punishments)) {
        loops.push(startLoop(deps, RIGHTS_SYNC_ROUND_MS, 'order_rights_sync', scheduleRightsSync));
      }
      if (capabilities.some((c) => c.refunds)) {
        loops.push(
          startLoop(deps, RIGHTS_RESCAN_TICK_MS, 'order_rights_rescan', scheduleRightsRescan),
        );
      }
      return {
        async stop() {
          await Promise.all(loops.map((loop) => loop.stop()));
        },
      };
    },
  };
}

/** find → lock → re-read → rights.record (source API), one transaction per record. */
export function createRightsSyncWriter(deps: RightsSyncWriterDeps): RightsSyncWriter {
  const { db, clock, rights } = deps;
  const ports = { rights };
  return {
    async write(target, item) {
      return await db.transaction().execute(async (trx): Promise<RightsSyncWriteResult> => {
        const found = await findOrderForRights(trx, {
          app_id: target.app_id,
          platform: target.platform,
          platform_order_no: target.sub_order_id,
        });
        // Only a sub-order of this App and platform is ours; anything else (another publisher's
        // slot, a parent order number) is not_found and writes nothing.
        if (found.kind !== 'found') return { kind: 'not_found' };
        await lockOrderKey(trx, found.order.platform, found.order.sub_order_id);
        const before = await rereadOrderForUpdate(trx, target.app_id, found.order.order_id);
        if (before === undefined) return { kind: 'not_found' };
        const result = await recordOrderRights(trx, ports, {
          before,
          order_id: before.order_id,
          source: 'API',
          type: item.type,
          status: item.status,
          amount_fen: item.amount_fen,
          deduction_commission_fen: item.deduction_commission_fen,
          occurred_at: item.occurred_at,
          platform_rights_no: item.platform_rights_no,
          now: clock.now(),
        });
        return { kind: result.kind };
      });
    },
  };
}
