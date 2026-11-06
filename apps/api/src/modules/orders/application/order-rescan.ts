// B1-04zm: order rescan scheduler (规划/02 §7.1; D10-543, D10-524). Each enabled account of a
// platform is one stream (platform, account, 'rescan', '-') with its own cursor; every timer round
// dispatches one window ('rescan.window' on the order-sync queue). The increment path is untouched.
// Settings come from order_sync.rescan.<platform>.enabled / .days (B1-04zq). Unset: jd on and 30
// days, pdd off and 90 days. days must be an integer in 1～90, anything else takes the default with
// one warn per platform per round whose only field is `key`. taobao and any platform not listed
// never rescan. A failed read skips the platform for this round: it is never taken as the default.
// D10-545: a round ends at min(now, the stream's increment cursor), read and never moved, so a tail
// the increment has not fetched yet is not reported as missed. An empty increment cursor sends
// nothing this round and moves no cursor. An account without sync_start_at is skipped before any
// cursor is read, as the increment skips it.
// The round that ends a stream's round only moves the cursor. Every window comes out of rescanStep
// as a 'window' step, so the next round's first window, one tick later, is bounded like any other.
// B1-04zzb (D10-741 ③): as the increment scheduler, a platform whose adapter reports no order
// source (deps.orderSources) is skipped for the round before its settings are read: no window, no
// cursor read or move, no error, one info line per platform and round. Absent → no gating.
import type { RegisteredPlatform } from '../../union/index.ts';
import { rescanDefaults, type RescanDefaults } from '../domain/platform-rules/rescan.ts';
import {
  INCREMENT_WINDOW_CAP_MS,
  isRescanDays,
  isoAt,
  parseInstantMs,
  rescanIntervalSeconds,
  rescanStep,
  windowSingletonKey,
} from '../domain/sync-window.ts';
import type {
  OrderRescanWindow,
  RescanCursorStore,
  RescanStream,
  SyncAccount,
  SyncSchedulerDeps,
  SyncStream,
} from './sync-ports.ts';
import {
  ORDER_SYNC_QUEUE,
  type OrderSyncScheduler,
  type SyncIntervalConfig,
} from './sync-scheduler.ts';

export const ORDER_RESCAN_JOB = 'rescan.window';

export interface OrderRescanSchedulerDeps extends Omit<SyncSchedulerDeps, 'cursors'> {
  readonly cursors: RescanCursorStore;
  readonly config: SyncIntervalConfig;
  /** Window cap per platform; absent → the rule table's syncWindowCapMs. */
  readonly capsMs?: Readonly<Partial<Record<RegisteredPlatform, number>>>;
  /** false → the platform has no order source this round and is skipped; absent → no gating. */
  readonly orderSources?: (platform: RegisteredPlatform) => boolean;
}

interface RescanSettings {
  readonly days: number;
  readonly capMs: number;
}

interface RoundGates {
  readonly queryable: (platform: RegisteredPlatform) => Promise<string | null | undefined>;
  readonly circuitOpen: (platform: RegisteredPlatform) => Promise<boolean>;
}

const enabledKey = (platform: string): string => `order_sync.rescan.${platform}.enabled`;
const daysKey = (platform: string): string => `order_sync.rescan.${platform}.days`;
const isSet = (value: unknown): boolean => value !== undefined && value !== null;

function capOf(deps: OrderRescanSchedulerDeps, platform: RegisteredPlatform): number | undefined {
  return deps.capsMs?.[platform] ?? INCREMENT_WINDOW_CAP_MS[platform];
}

function once<V>(
  load: (platform: RegisteredPlatform) => Promise<V>,
): (platform: RegisteredPlatform) => Promise<V> {
  const loaded = new Map<RegisteredPlatform, Promise<V>>();
  return (platform) => {
    let value = loaded.get(platform);
    if (value === undefined) {
      value = load(platform);
      loaded.set(platform, value);
    }
    return value;
  };
}

/** The platform's settings this round; null when it does not rescan or a read failed. */
async function readSettings(
  deps: OrderRescanSchedulerDeps,
  platform: RegisteredPlatform,
): Promise<RescanSettings | null> {
  const defaults = rescanDefaults(platform);
  const capMs = capOf(deps, platform);
  if (defaults === null || capMs === undefined) return null;
  let key = enabledKey(platform);
  try {
    const enabled = await deps.config.get(key);
    if (typeof enabled !== 'boolean' && isSet(enabled)) {
      deps.logger?.warn({ key }, 'order_sync_rescan_enabled_invalid');
    }
    if (!(typeof enabled === 'boolean' ? enabled : defaults.enabled)) return null;
    key = daysKey(platform);
    const days = await deps.config.get(key);
    if (isRescanDays(days)) return { days, capMs };
    if (isSet(days)) deps.logger?.warn({ key }, 'order_sync_rescan_days_invalid');
    return { days: defaults.days, capMs };
  } catch (error) {
    deps.logger?.warn({ platform, key, err: error }, 'order_sync_rescan_config_failed');
    return null;
  }
}

/**
 * One scheduling round over `platforms`; gated exactly like the increment scheduler. Accounts are
 * independent: the first failure is rethrown after the round so the caller logs it.
 */
export async function scheduleOrderRescan(
  deps: OrderRescanSchedulerDeps,
  platforms: readonly RegisteredPlatform[],
): Promise<void> {
  const settings = new Map<RegisteredPlatform, RescanSettings>();
  for (const platform of platforms) {
    if (rescanDefaults(platform) === null || capOf(deps, platform) === undefined) continue;
    if (deps.orderSources?.(platform) === false) {
      deps.logger?.info({ platform }, 'order_sync_rescan_skipped_no_order_source');
      continue;
    }
    const read = await readSettings(deps, platform);
    if (read !== null) settings.set(platform, read);
  }
  if (settings.size === 0) return;
  const accounts = await deps.access.listEnabledAccounts();
  const gates: RoundGates = {
    queryable: once(async (platform) => deps.access.queryableAccount?.(platform)),
    circuitOpen: once((platform) => deps.access.offlineCircuitOpen(platform)),
  };
  let failure: { error: unknown } | undefined;
  for (const account of accounts) {
    const platformSettings = settings.get(account.platform);
    if (platformSettings === undefined) continue;
    try {
      await scheduleAccount(deps, account, platformSettings, gates);
    } catch (error) {
      deps.logger?.error(
        { platform: account.platform, account: account.union_account_id, err: error },
        'order_sync_rescan_schedule_account_failed',
      );
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

async function scheduleAccount(
  deps: OrderRescanSchedulerDeps,
  account: SyncAccount,
  settings: RescanSettings,
  gates: RoundGates,
): Promise<void> {
  const fields = { platform: account.platform, account: account.union_account_id };
  // D10-36: as the increment, only the account whose credentials the adapter holds is fetched.
  const queryable = await gates.queryable(account.platform);
  if (queryable !== undefined && queryable !== account.union_account_id) {
    deps.logger?.warn(
      { ...fields, reason: queryable === null ? 'no_queryable_account' : 'not_queryable_account' },
      'order_sync_rescan_account_skipped',
    );
    return;
  }
  if (await gates.circuitOpen(account.platform)) {
    deps.logger?.info(fields, 'order_sync_rescan_skipped_circuit_open');
    return;
  }
  if (!(await deps.access.siteAuthAvailable(account))) {
    deps.logger?.info(fields, 'order_sync_rescan_paused_site_auth');
    return;
  }
  if (account.sync_start_at === null) {
    deps.logger?.warn(fields, 'order_sync_rescan_no_start');
    return;
  }
  const stream: RescanStream = {
    app_id: account.app_id,
    platform: account.platform,
    union_account_id: account.union_account_id,
    query_kind: 'rescan',
    scene: '-',
  };
  const incrementStream: SyncStream = { ...stream, query_kind: 'increment' };
  const incrementCursor = await deps.cursors.read(incrementStream);
  if (incrementCursor === null) {
    deps.logger?.info(fields, 'order_sync_rescan_no_increment_cursor');
    return;
  }
  const cursor = await deps.cursors.read(stream);
  const cursorMs = cursor === null ? null : parseInstantMs(cursor, 'cursor_at');
  const now = deps.clock.now();
  const step = rescanStep(
    cursorMs,
    now.getTime(),
    settings.days,
    settings.capMs,
    parseInstantMs(incrementCursor, 'cursor_at'),
  );
  const startMs = step.kind === 'window' ? step.startMs : step.restartMs;
  // Moved first, so the window's CAS from window_start hits. A stream with no row has nothing to
  // move: the window's advance inserts it.
  if (cursor !== null && cursorMs !== startMs) {
    if (!(await deps.cursors.rewind(stream, cursor, isoAt(now, startMs)))) {
      deps.logger?.info(fields, 'order_sync_rescan_cursor_moved');
      return;
    }
  }
  if (step.kind === 'round_end') {
    deps.logger?.info(fields, 'order_sync_rescan_round_end');
    return;
  }
  const payload: OrderRescanWindow = {
    ...stream,
    window_start: isoAt(now, step.startMs),
    window_end: isoAt(now, step.endMs),
  };
  const id = await deps.queue.send(ORDER_SYNC_QUEUE, ORDER_RESCAN_JOB, payload, {
    trx: null,
    singletonKey: windowSingletonKey(payload),
  });
  deps.logger?.info(
    {
      ...fields,
      window_start: payload.window_start,
      window_end: payload.window_end,
      queued: id !== null,
    },
    'order_sync_rescan_window_dispatched',
  );
}

/**
 * Starts timers only; construction and start must not dispatch a window. The timer paces on valid
 * days only: an invalid value paces as the default and warns only through the round itself.
 */
export function createOrderRescanScheduler(
  deps: OrderRescanSchedulerDeps,
  platforms: readonly RegisteredPlatform[],
): OrderSyncScheduler {
  return {
    start() {
      const loops = platforms.flatMap((platform) => {
        const defaults = rescanDefaults(platform);
        const capMs = capOf(deps, platform);
        if (defaults === null || capMs === undefined) return [];
        return [startLoop(deps, platform, defaults, capMs)];
      });
      return {
        async stop() {
          await Promise.all(loops.map((loop) => loop.stop()));
        },
      };
    },
  };
}

function startLoop(
  deps: OrderRescanSchedulerDeps,
  platform: RegisteredPlatform,
  defaults: RescanDefaults,
  capMs: number,
): { stop(): Promise<void> } {
  const defaultSeconds = rescanIntervalSeconds(defaults.days, capMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const readSeconds = async (): Promise<number> => {
    try {
      const days = await deps.config.get(daysKey(platform));
      return isRescanDays(days) ? rescanIntervalSeconds(days, capMs) : defaultSeconds;
    } catch {
      // The round reads the same key and warns; here it only decides the pace.
      return defaultSeconds;
    }
  };

  const armAfter = (seconds: number): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      timer = undefined;
      running = round();
    }, seconds * 1000);

  const round = async (): Promise<void> => {
    try {
      await scheduleOrderRescan(deps, [platform]);
    } catch (error) {
      // D10-33: a failed round is logged only; later rounds keep running.
      deps.logger?.error({ platform, err: error }, 'order_sync_rescan_round_failed');
    }
    if (stopped) return;
    const seconds = await readSeconds();
    if (!stopped) timer = armAfter(seconds);
  };

  // As the increment loop: armed at once with the default, replaced as soon as days is read.
  const armFirst = async (): Promise<void> => {
    const placeholder = armAfter(defaultSeconds);
    timer = placeholder;
    const seconds = await readSeconds();
    if (stopped || timer !== placeholder) return;
    clearTimeout(placeholder);
    timer = armAfter(seconds);
  };

  running = armFirst();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
