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
// B1-04zzr (D10-798 / D10-804): a platform with rescanTiers (Taobao) rescans in tiers, one stream
// (platform, account, kind, '-') and one cursor each: day 'rescan' (.enabled / .days as before),
// hour 'rescan_hour' (.hour.enabled) and week 'rescan_week' (.week.enabled). Their window is
// order_sync.rescan.<platform>.window_minutes (default 180, invalid → default and one warn), with
// order_sync.promo_mode on at most 20 minutes; the hour tier's window is at most 20 minutes and its
// round starts without the start margin. Each window carries its tier's timeBasis. The gates are
// checked once per account and hold every tier; past them a tier whose cursor CAS misses or that
// fails skips only itself. Each tier has its own timer, paced max(60, floor(P ÷ (D ÷ window))).
// jd / pdd keep the single tier, its keys and its pace.
import type { RegisteredPlatform } from '../../union/index.ts';
import {
  rescanDefaults,
  rescanTierHasStartMargin,
  rescanTierWindowMs,
  rescanTiers,
  type RescanQueryKind,
  type RescanTier,
  type RescanTimeBasis,
} from '../domain/platform-rules/rescan.ts';
import {
  DEFAULT_RESCAN_WINDOW_MINUTES,
  INCREMENT_WINDOW_CAP_MS,
  RESCAN_START_MARGIN_MS,
  isRescanDays,
  isRescanWindowMinutes,
  isoAt,
  parseInstantMs,
  rescanIntervalSeconds,
  rescanRangeStep,
  rescanTierIntervalSeconds,
  rescanWindowCapMs,
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

/** One stream's settings this round: where a round starts, how long a window is, its basis. */
interface StreamPlan {
  readonly queryKind: RescanQueryKind;
  readonly depthMs: number;
  readonly marginMs: number;
  readonly capMs: number;
  /** Set for a tiered platform only; jd / pdd windows carry none (the adapters take update). */
  readonly timeBasis?: RescanTimeBasis;
}

interface RoundGates {
  readonly queryable: (platform: RegisteredPlatform) => Promise<string | null | undefined>;
  readonly circuitOpen: (platform: RegisteredPlatform) => Promise<boolean>;
}

const DAY_MS = 86_400_000;
const PROMO_MODE_KEY = 'order_sync.promo_mode';
const enabledKey = (platform: string): string => `order_sync.rescan.${platform}.enabled`;
const daysKey = (platform: string): string => `order_sync.rescan.${platform}.days`;
const windowMinutesKey = (platform: string): string =>
  `order_sync.rescan.${platform}.window_minutes`;
/** The day tier keeps the platform's .enabled; 'rescan_<tier>' reads .<tier>.enabled. */
const tierEnabledKey = (platform: string, kind: RescanQueryKind): string =>
  kind === 'rescan'
    ? enabledKey(platform)
    : `order_sync.rescan.${platform}.${kind.slice('rescan_'.length)}.enabled`;
const isSet = (value: unknown): boolean => value !== undefined && value !== null;

function capOf(deps: OrderRescanSchedulerDeps, platform: RegisteredPlatform): number | undefined {
  return deps.capsMs?.[platform] ?? INCREMENT_WINDOW_CAP_MS[platform];
}

/** Whether `platform` rescans at all (a single tier with defaults, or tiers) and has a cap. */
function rescans(deps: OrderRescanSchedulerDeps, platform: RegisteredPlatform): boolean {
  if (capOf(deps, platform) === undefined) return false;
  return rescanTiers(platform) !== null || rescanDefaults(platform) !== null;
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

type KeyRef = { key: string };

async function readEnabled(
  deps: OrderRescanSchedulerDeps,
  key: string,
  fallback: boolean,
  ref: KeyRef,
): Promise<boolean> {
  ref.key = key;
  const enabled = await deps.config.get(key);
  if (typeof enabled !== 'boolean' && isSet(enabled)) {
    deps.logger?.warn({ key }, 'order_sync_rescan_enabled_invalid');
  }
  return typeof enabled === 'boolean' ? enabled : fallback;
}

async function readDays(
  deps: OrderRescanSchedulerDeps,
  platform: string,
  fallback: number,
  ref: KeyRef | null,
): Promise<number> {
  const key = daysKey(platform);
  if (ref !== null) ref.key = key;
  const days = await deps.config.get(key);
  if (isRescanDays(days)) return days;
  if (ref !== null && isSet(days)) deps.logger?.warn({ key }, 'order_sync_rescan_days_invalid');
  return fallback;
}

/**
 * The tiered rescan's effective window cap (D10-804): window_minutes (invalid → 180, warned when
 * `ref` is given), at most 20 minutes with promo_mode on (a non-boolean promo_mode is off, warned).
 */
async function readTierCap(
  deps: OrderRescanSchedulerDeps,
  platform: string,
  ref: KeyRef | null,
): Promise<number> {
  const minutesKey = windowMinutesKey(platform);
  if (ref !== null) ref.key = minutesKey;
  const minutes = await deps.config.get(minutesKey);
  const valid = isRescanWindowMinutes(minutes);
  if (!valid && ref !== null && isSet(minutes)) {
    deps.logger?.warn({ key: minutesKey }, 'order_sync_rescan_window_minutes_invalid');
  }
  if (ref !== null) ref.key = PROMO_MODE_KEY;
  const promo = await deps.config.get(PROMO_MODE_KEY);
  if (typeof promo !== 'boolean' && isSet(promo) && ref !== null) {
    deps.logger?.warn({ key: PROMO_MODE_KEY }, 'order_sync_promo_mode_invalid');
  }
  return rescanWindowCapMs(valid ? minutes : DEFAULT_RESCAN_WINDOW_MINUTES, promo === true);
}

function tierPlan(tier: RescanTier, depthMs: number, capMs: number): StreamPlan {
  return {
    queryKind: tier.queryKind,
    depthMs,
    marginMs: rescanTierHasStartMargin(tier.queryKind) ? RESCAN_START_MARGIN_MS : 0,
    capMs: rescanTierWindowMs(tier.queryKind, capMs),
    timeBasis: tier.timeBasis,
  };
}

/**
 * The platform's streams this round (only the `only` tier when given); null when it does not
 * rescan, every stream is off, or a read failed.
 */
async function readSettings(
  deps: OrderRescanSchedulerDeps,
  platform: RegisteredPlatform,
  only?: RescanQueryKind,
): Promise<readonly StreamPlan[] | null> {
  const capMs = capOf(deps, platform);
  if (capMs === undefined) return null;
  const tiers = rescanTiers(platform);
  const defaults = rescanDefaults(platform);
  const ref: KeyRef = { key: enabledKey(platform) };
  try {
    if (tiers === null) {
      if (defaults === null || (only !== undefined && only !== 'rescan')) return null;
      if (!(await readEnabled(deps, enabledKey(platform), defaults.enabled, ref))) return null;
      const days = await readDays(deps, platform, defaults.days, ref);
      return [
        { queryKind: 'rescan', depthMs: days * DAY_MS, marginMs: RESCAN_START_MARGIN_MS, capMs },
      ];
    }
    const on: RescanTier[] = [];
    for (const tier of tiers) {
      if (only !== undefined && tier.queryKind !== only) continue;
      const key = tierEnabledKey(platform, tier.queryKind);
      if (await readEnabled(deps, key, tier.enabled, ref)) on.push(tier);
    }
    if (on.length === 0) return null;
    // The day tier's depth stays order_sync.rescan.<platform>.days (its default from rescanDefaults).
    const dayDepthMs = on.some((tier) => tier.queryKind === 'rescan')
      ? (await readDays(deps, platform, defaults?.days ?? 30, ref)) * DAY_MS
      : null;
    const tierCapMs = await readTierCap(deps, platform, ref);
    return on.map((tier) =>
      tierPlan(
        tier,
        tier.queryKind === 'rescan' ? (dayDepthMs ?? tier.depthMs) : tier.depthMs,
        tierCapMs,
      ),
    );
  } catch (error) {
    deps.logger?.warn({ platform, key: ref.key, err: error }, 'order_sync_rescan_config_failed');
    return null;
  }
}

/**
 * One scheduling round over `platforms`; gated exactly like the increment scheduler. Accounts are
 * independent: the first failure is rethrown after the round so the caller logs it. `only` limits
 * the round to one stream kind (each tier's timer passes its own); absent → every stream.
 */
export async function scheduleOrderRescan(
  deps: OrderRescanSchedulerDeps,
  platforms: readonly RegisteredPlatform[],
  only?: RescanQueryKind,
): Promise<void> {
  const settings = new Map<RegisteredPlatform, readonly StreamPlan[]>();
  for (const platform of platforms) {
    if (!rescans(deps, platform)) continue;
    if (deps.orderSources?.(platform) === false) {
      deps.logger?.info({ platform }, 'order_sync_rescan_skipped_no_order_source');
      continue;
    }
    const read = await readSettings(deps, platform, only);
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
    const plans = settings.get(account.platform);
    if (plans === undefined) continue;
    try {
      const error = await scheduleAccount(deps, account, plans, gates);
      if (error !== undefined) failure ??= error;
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

/** The gates, then each stream; a stream's failure is logged and returned, the others go on. */
async function scheduleAccount(
  deps: OrderRescanSchedulerDeps,
  account: SyncAccount,
  plans: readonly StreamPlan[],
  gates: RoundGates,
): Promise<{ error: unknown } | undefined> {
  const fields = { platform: account.platform, account: account.union_account_id };
  // D10-36: as the increment, only the account whose credentials the adapter holds is fetched.
  const queryable = await gates.queryable(account.platform);
  if (queryable !== undefined && queryable !== account.union_account_id) {
    deps.logger?.warn(
      { ...fields, reason: queryable === null ? 'no_queryable_account' : 'not_queryable_account' },
      'order_sync_rescan_account_skipped',
    );
    return undefined;
  }
  if (await gates.circuitOpen(account.platform)) {
    deps.logger?.info(fields, 'order_sync_rescan_skipped_circuit_open');
    return undefined;
  }
  if (!(await deps.access.siteAuthAvailable(account))) {
    deps.logger?.info(fields, 'order_sync_rescan_paused_site_auth');
    return undefined;
  }
  if (account.sync_start_at === null) {
    deps.logger?.warn(fields, 'order_sync_rescan_no_start');
    return undefined;
  }
  const incrementStream: SyncStream = {
    app_id: account.app_id,
    platform: account.platform,
    union_account_id: account.union_account_id,
    query_kind: 'increment',
    scene: '-',
  };
  const incrementCursor = await deps.cursors.read(incrementStream);
  if (incrementCursor === null) {
    deps.logger?.info(fields, 'order_sync_rescan_no_increment_cursor');
    return undefined;
  }
  const ceilingMs = parseInstantMs(incrementCursor, 'cursor_at');
  if (plans.length === 1) {
    // A single stream: its failure is the account's, as before the tiers.
    await scheduleStream(deps, account, plans[0]!, ceilingMs);
    return undefined;
  }
  let failure: { error: unknown } | undefined;
  for (const plan of plans) {
    try {
      await scheduleStream(deps, account, plan, ceilingMs);
    } catch (error) {
      deps.logger?.error(
        { ...fields, query_kind: plan.queryKind, err: error },
        'order_sync_rescan_schedule_stream_failed',
      );
      failure ??= { error };
    }
  }
  return failure;
}

async function scheduleStream(
  deps: OrderRescanSchedulerDeps,
  account: SyncAccount,
  plan: StreamPlan,
  ceilingMs: number,
): Promise<void> {
  const fields = {
    platform: account.platform,
    account: account.union_account_id,
    ...(plan.queryKind === 'rescan' ? {} : { query_kind: plan.queryKind }),
  };
  const stream: RescanStream = {
    app_id: account.app_id,
    platform: account.platform,
    union_account_id: account.union_account_id,
    query_kind: plan.queryKind,
    scene: '-',
  };
  const cursor = await deps.cursors.read(stream);
  const cursorMs = cursor === null ? null : parseInstantMs(cursor, 'cursor_at');
  const now = deps.clock.now();
  const step = rescanRangeStep(
    cursorMs,
    now.getTime(),
    plan.depthMs,
    plan.marginMs,
    plan.capMs,
    ceilingMs,
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
    ...(plan.timeBasis === undefined ? {} : { timeBasis: plan.timeBasis }),
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

/** How one timer paces its rounds: the default, and the pace read from the current config. */
interface LoopPace {
  readonly only: RescanQueryKind | undefined;
  readonly defaultSeconds: number;
  readonly read: () => Promise<number>;
}

function singlePace(
  deps: OrderRescanSchedulerDeps,
  platform: RegisteredPlatform,
  days: number,
  capMs: number,
): LoopPace {
  const defaultSeconds = rescanIntervalSeconds(days, capMs);
  return {
    only: undefined,
    defaultSeconds,
    async read() {
      const configured = await deps.config.get(daysKey(platform));
      return isRescanDays(configured) ? rescanIntervalSeconds(configured, capMs) : defaultSeconds;
    },
  };
}

function tierPace(
  deps: OrderRescanSchedulerDeps,
  platform: RegisteredPlatform,
  tier: RescanTier,
  defaultDays: number,
): LoopPace {
  const isDay = tier.queryKind === 'rescan';
  const seconds = (depthMs: number, capMs: number): number =>
    rescanTierIntervalSeconds(tier.periodMs, depthMs, rescanTierWindowMs(tier.queryKind, capMs));
  const defaultDepthMs = isDay ? defaultDays * DAY_MS : tier.depthMs;
  return {
    only: tier.queryKind,
    defaultSeconds: seconds(
      defaultDepthMs,
      rescanWindowCapMs(DEFAULT_RESCAN_WINDOW_MINUTES, false),
    ),
    async read() {
      const depthMs = isDay
        ? (await readDays(deps, platform, defaultDays, null)) * DAY_MS
        : tier.depthMs;
      return seconds(depthMs, await readTierCap(deps, platform, null));
    },
  };
}

/**
 * Starts timers only; construction and start must not dispatch a window. The timer paces on valid
 * settings only: an invalid value paces as the default and warns only through the round itself.
 * One timer per platform, or per tier for a tiered platform (a tier that is off still runs its
 * timer and reads its switch every round, so turning it on needs no restart).
 */
export function createOrderRescanScheduler(
  deps: OrderRescanSchedulerDeps,
  platforms: readonly RegisteredPlatform[],
): OrderSyncScheduler {
  return {
    start() {
      const loops = platforms.flatMap((platform) => {
        const capMs = capOf(deps, platform);
        if (capMs === undefined) return [];
        const defaults = rescanDefaults(platform);
        const tiers = rescanTiers(platform);
        if (tiers !== null) {
          return tiers.map((tier) =>
            startLoop(deps, platform, tierPace(deps, platform, tier, defaults?.days ?? 30)),
          );
        }
        if (defaults === null) return [];
        return [startLoop(deps, platform, singlePace(deps, platform, defaults.days, capMs))];
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
  pace: LoopPace,
): { stop(): Promise<void> } {
  const { defaultSeconds } = pace;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const readSeconds = async (): Promise<number> => {
    try {
      return await pace.read();
    } catch {
      // The round reads the same keys and warns; here they only decide the pace.
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
      await scheduleOrderRescan(deps, [platform], pace.only);
    } catch (error) {
      // D10-33: a failed round is logged only; later rounds keep running.
      deps.logger?.error(
        { platform, ...(pace.only === undefined ? {} : { query_kind: pace.only }), err: error },
        'order_sync_rescan_round_failed',
      );
    }
    if (stopped) return;
    const seconds = await readSeconds();
    if (!stopped) timer = armAfter(seconds);
  };

  // As the increment loop: armed at once with the default, replaced as soon as the pace is read.
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
