// B1-08g: incremental order sync scheduler (规划/02 §7.1). Each enabled union account is one
// stream (platform, account, 'increment', '-'); every round dispatches only the next continuous
// window from its cursor. Nothing is dispatched on construction or start: only timer rounds.
// B1-04zt: a start older than the platform's order query can answer (domain/platform-rules/
// query-lookback.ts) would dead-letter its window and be sent again every round, so the cursor is
// moved up first, also when the stream has no row yet: the next round then starts inside the
// tolerance of clampedIncrementStartMs and sends the same window, or nothing new. A lost
// compare-and-set sends nothing this round.
import type { RegisteredPlatform } from '../../union/index.ts';
import { orderQueryLookbackMs } from '../domain/platform-rules/query-lookback.ts';
import {
  clampedIncrementStartMs,
  INCREMENT_WINDOW_CAP_MS,
  intervalSeconds,
  isoAt,
  nextWindow,
  parseInstantMs,
  scheduledPlatforms,
  windowSingletonKey,
} from '../domain/sync-window.ts';
import type { OrderSyncWindow, SyncAccount, SyncSchedulerDeps, SyncStream } from './sync-ports.ts';

export const ORDER_SYNC_QUEUE = 'order-sync';
export const ORDER_SYNC_JOB = 'window';

/**
 * One scheduling round. Accounts are independent: one failing account does not stop the others;
 * the first failure is rethrown after the round so the caller logs it.
 */
export async function scheduleOrderSync(
  deps: SyncSchedulerDeps,
  platforms: readonly RegisteredPlatform[] = scheduledPlatforms(),
): Promise<void> {
  const accounts = await deps.access.listEnabledAccounts();
  const circuit = new Map<RegisteredPlatform, Promise<boolean>>();
  const circuitOpen = (p: RegisteredPlatform): Promise<boolean> => {
    let open = circuit.get(p);
    if (open === undefined) {
      open = deps.access.offlineCircuitOpen(p);
      circuit.set(p, open);
    }
    return open;
  };
  const queryable = new Map<RegisteredPlatform, Promise<string | null>>();
  const queryableAccount = (p: RegisteredPlatform): Promise<string | null> | undefined => {
    const port = deps.access;
    if (port.queryableAccount === undefined) return undefined;
    let id = queryable.get(p);
    if (id === undefined) {
      id = port.queryableAccount(p);
      queryable.set(p, id);
    }
    return id;
  };
  let failure: { error: unknown } | undefined;
  for (const account of accounts) {
    if (!platforms.includes(account.platform)) continue;
    try {
      await scheduleAccount(deps, account, circuitOpen, queryableAccount);
    } catch (error) {
      deps.logger?.error(
        { platform: account.platform, account: account.union_account_id, err: error },
        'order_sync_schedule_account_failed',
      );
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

async function scheduleAccount(
  deps: SyncSchedulerDeps,
  account: SyncAccount,
  circuitOpen: (p: RegisteredPlatform) => Promise<boolean>,
  queryableAccount: (p: RegisteredPlatform) => Promise<string | null> | undefined,
): Promise<void> {
  const cap = INCREMENT_WINDOW_CAP_MS[account.platform];
  if (cap === undefined) return;
  const fields = { platform: account.platform, account: account.union_account_id };
  // D10-36: the adapter queries one credential set per platform; any other enabled account of the
  // same platform would fetch the credential owner's orders yet advance its own cursor.
  const queryablePromise = queryableAccount(account.platform);
  if (queryablePromise !== undefined) {
    const queryable = await queryablePromise;
    if (queryable !== account.union_account_id) {
      deps.logger?.warn(
        {
          platform: account.platform,
          union_account_id: account.union_account_id,
          reason: queryable === null ? 'no_queryable_account' : 'not_queryable_account',
        },
        'order_sync_account_skipped',
      );
      return;
    }
  }
  if (await circuitOpen(account.platform)) {
    deps.logger?.info(fields, 'order_sync_skipped_circuit_open');
    return;
  }
  if (!(await deps.access.siteAuthAvailable(account))) {
    deps.logger?.info(fields, 'order_sync_paused_site_auth');
    return;
  }
  const stream: SyncStream = {
    app_id: account.app_id,
    platform: account.platform,
    union_account_id: account.union_account_id,
    query_kind: 'increment',
    scene: '-',
  };
  const cursor = await deps.cursors.read(stream);
  const from = cursor ?? account.sync_start_at;
  if (from === null) {
    deps.logger?.warn(fields, 'order_sync_no_start');
    return;
  }
  const fromMs = parseInstantMs(from, 'cursor_at');
  const now = deps.clock.now();
  const clampedMs = clampedIncrementStartMs(
    fromMs,
    now.getTime(),
    orderQueryLookbackMs(account.platform),
  );
  if (clampedMs !== null) {
    if (deps.cursors.rewind === undefined) {
      deps.logger?.warn(fields, 'order_sync_start_clamp_unavailable');
      return;
    }
    if (!(await deps.cursors.rewind(stream, cursor, isoAt(now, clampedMs)))) {
      deps.logger?.info(fields, 'order_sync_cursor_moved');
      return;
    }
    deps.logger?.warn(fields, 'order_sync_start_clamped');
  }
  const bounds = nextWindow(clampedMs ?? fromMs, now, cap);
  if (bounds === null) return;
  const payload: OrderSyncWindow = {
    ...stream,
    query_kind: 'increment',
    scene: '-',
    ...bounds,
  };
  const id = await deps.queue.send(ORDER_SYNC_QUEUE, ORDER_SYNC_JOB, payload, {
    trx: null,
    singletonKey: windowSingletonKey(payload),
  });
  deps.logger?.info(
    {
      ...fields,
      window_start: bounds.window_start,
      window_end: bounds.window_end,
      queued: id !== null,
    },
    'order_sync_window_dispatched',
  );
}

export interface SyncIntervalConfig {
  get(key: string): Promise<unknown>;
}

export interface OrderSyncScheduler {
  /** Starts timers only; construction and start must not dispatch a window. */
  start(): { stop(): Promise<void> };
}

export function createOrderSyncScheduler(
  deps: SyncSchedulerDeps,
  config: SyncIntervalConfig,
): OrderSyncScheduler {
  return {
    start() {
      const loops = scheduledPlatforms().map((platform) => startLoop(deps, config, platform));
      return {
        async stop() {
          await Promise.all(loops.map((l) => l.stop()));
        },
      };
    },
  };
}

function startLoop(
  deps: SyncSchedulerDeps,
  config: SyncIntervalConfig,
  platform: RegisteredPlatform,
): { stop(): Promise<void> } {
  const key = `order_sync.${platform}.interval_seconds`;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const readInterval = async (): Promise<number> => {
    try {
      return intervalSeconds(await config.get(key));
    } catch (error) {
      deps.logger?.error({ platform, err: error }, 'order_sync_interval_config_failed');
      return intervalSeconds(undefined);
    }
  };

  const arm = async (): Promise<void> => {
    const seconds = await readInterval();
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = round();
    }, seconds * 1000);
  };

  const round = async (): Promise<void> => {
    try {
      await scheduleOrderSync(deps, [platform]);
    } catch (error) {
      // D10-33: a failed round is logged only; later rounds keep running.
      deps.logger?.error({ platform, err: error }, 'order_sync_round_failed');
    }
    if (!stopped) await arm();
  };

  // B1-08t: start() leaves this platform's timer armed at once (one per platform, as the worker
  // assembly counts right after start()): the first timer uses the default interval and is
  // replaced by the configured one as soon as it is read, unless it already fired or stop() ran.
  const armFirst = async (): Promise<void> => {
    const placeholder = setTimeout(
      () => {
        timer = undefined;
        running = round();
      },
      intervalSeconds(undefined) * 1000,
    );
    timer = placeholder;
    const seconds = await readInterval();
    if (stopped || timer !== placeholder) return;
    clearTimeout(placeholder);
    timer = setTimeout(() => {
      timer = undefined;
      running = round();
    }, seconds * 1000);
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
