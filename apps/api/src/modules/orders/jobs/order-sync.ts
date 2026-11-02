// B1-08g: order-sync window job (规划/02 §7.1). The window bounds were fixed at dispatch; a retry
// replays the same [window_start, window_end). Every page is archived by union before it is
// returned (B1-08e); each order then goes to the pipeline port in order. Any failure is rethrown
// so the queue retries the whole window; the cursor moves only after every page is done.
// B1-04zt: application/fetch-window.ts takes a window the upstream calls too large apart inside this
// job; the cursor still moves once, by the job's own window.
import type { ReceivedJob } from '../../platform/index.ts';
import type { RegisteredPlatform } from '../../union/index.ts';
import { parseInstantMs, scheduledPlatforms } from '../domain/sync-window.ts';
import { fetchWindow } from '../application/fetch-window.ts';
import type { OrderPipelinePort } from '../application/pipeline-port.ts';
import type {
  OrderSyncWindow,
  SyncAccessPort,
  SyncCursorStore,
  SyncLogger,
  SyncRegistry,
} from '../application/sync-ports.ts';

export interface OrderSyncHandlerDeps {
  readonly access: SyncAccessPort;
  readonly cursors: SyncCursorStore;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
  readonly logger?: SyncLogger;
}

export class OrderSyncPayloadError extends Error {
  override readonly name = 'OrderSyncPayloadError';
}

/** Validates the queued payload; a malformed job fails (and dead-letters) instead of syncing. */
export function parseOrderSyncWindow(payload: ReceivedJob['payload']): OrderSyncWindow {
  const str = (key: string): string => {
    const v = payload[key];
    if (typeof v !== 'string' || v === '') throw new OrderSyncPayloadError(`invalid ${key}`);
    return v;
  };
  const platform = str('platform');
  if (!(scheduledPlatforms() as readonly string[]).includes(platform)) {
    throw new OrderSyncPayloadError('invalid platform');
  }
  if (str('query_kind') !== 'increment') throw new OrderSyncPayloadError('invalid query_kind');
  if (str('scene') !== '-') throw new OrderSyncPayloadError('invalid scene');
  const windowStart = str('window_start');
  const windowEnd = str('window_end');
  let start: number;
  let end: number;
  try {
    start = parseInstantMs(windowStart, 'window_start');
    end = parseInstantMs(windowEnd, 'window_end');
  } catch (error) {
    throw new OrderSyncPayloadError((error as Error).message);
  }
  if (end <= start) throw new OrderSyncPayloadError('empty window');
  return {
    app_id: str('app_id'),
    platform: platform as RegisteredPlatform,
    union_account_id: str('union_account_id'),
    query_kind: 'increment',
    scene: '-',
    window_start: windowStart,
    window_end: windowEnd,
  };
}

export async function handleOrderSyncWindow(
  job: ReceivedJob,
  deps: OrderSyncHandlerDeps,
): Promise<void> {
  const win = parseOrderSyncWindow(job.payload);
  const fields = {
    platform: win.platform,
    account: win.union_account_id,
    window_start: win.window_start,
    window_end: win.window_end,
    attempt: job.attempt,
  };
  // D10-36: the adapter's credentials belong to one account per platform; a window of any other
  // account would fetch someone else's orders and advance this account's cursor. Finish without
  // fetching or advancing; retrying cannot change the answer.
  if (deps.access.queryableAccount !== undefined) {
    const queryable = await deps.access.queryableAccount(win.platform);
    if (queryable !== win.union_account_id) {
      deps.logger?.error(
        {
          ...fields,
          union_account_id: win.union_account_id,
          reason: queryable === null ? 'no_queryable_account' : 'not_queryable_account',
        },
        'order_sync_window_account_mismatch',
      );
      return;
    }
  }
  // BR-ID-24 ④: a job already queued when site auth lapsed is taken off without fetching; the
  // cursor stays at window_start, so the scheduler re-dispatches from there after re-auth.
  if (!(await deps.access.siteAuthAvailable(win))) {
    deps.logger?.info(fields, 'order_sync_window_paused_site_auth');
    return;
  }
  const adapter = deps.registry.get(win.platform);
  const requestId = `order-sync:${job.id}:${job.attempt}`;
  const range = { from: win.window_start, to: win.window_end };
  const ctx = { ...win, requestId };
  const counts = { pages: 0, count: 0 };
  await fetchWindow(range, {
    adapter,
    call: { appId: win.app_id, requestId, purpose: 'order_sync' },
    onPage: async (orders) => {
      counts.pages += 1;
      for (const order of orders) {
        await deps.pipeline.process(order, ctx);
        counts.count += 1;
      }
    },
  });
  const advanced = await deps.cursors.advance(win);
  deps.logger?.info({ ...fields, ...counts, advanced }, 'order_sync_window_done');
}
