// B1-04zm: 'rescan.window' job on the order-sync queue (规划/02 §7.1; D10-524). Payload rules follow
// jobs/order-sync.ts with query_kind 'rescan' only and `platforms` in place of scheduledPlatforms().
// A window fetches every page and sends each order through the existing pipeline, then advances the
// rescan cursor once. An order the pipeline first inserts here is one the increment missed, so the
// window also logs order_sync_rescan_found_missing; logs carry the counters, never order data.
// D10-545: a retry finds those rows unchanged, so a window that fails after a first insert still
// logs found_missing with the counts so far (finished pages and rows), then rethrows.
// A row seen again is settled by the pipeline's content_hash short-circuit; no branch here.
// B1-04zt: application/fetch-window.ts takes a window the upstream calls too large apart inside this
// job; the counts stay one set for the job's window, and the cursor moves once, by that window.
import type { ReceivedJob } from '../../platform/index.ts';
import type { RegisteredPlatform } from '../../union/index.ts';
import { parseInstantMs } from '../domain/sync-window.ts';
import { fetchWindow } from '../application/fetch-window.ts';
import type { OrderPipelineContext, OrderPipelinePort } from '../application/pipeline-types.ts';
import type {
  OrderRescanWindow,
  SyncAccessPort,
  SyncCursorStore,
  SyncLogger,
  SyncRegistry,
} from '../application/sync-ports.ts';
import { OrderSyncPayloadError } from './order-sync.ts';

export interface OrderRescanHandlerDeps {
  readonly access: SyncAccessPort;
  readonly cursors: Pick<SyncCursorStore, 'advance'>;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
  /** Platforms a window may name; production passes scheduledPlatforms(). */
  readonly platforms: readonly RegisteredPlatform[];
  readonly logger?: SyncLogger;
}

interface WindowCounts {
  pages: number;
  count: number;
  inserted: number;
}

/** Validates the queued payload; a malformed job fails (and dead-letters) instead of syncing. */
function parseOrderRescanWindow(
  payload: ReceivedJob['payload'],
  platforms: readonly RegisteredPlatform[],
): OrderRescanWindow {
  const str = (key: string): string => {
    const v = payload[key];
    if (typeof v !== 'string' || v === '') throw new OrderSyncPayloadError(`invalid ${key}`);
    return v;
  };
  const platform = str('platform');
  if (!(platforms as readonly string[]).includes(platform)) {
    throw new OrderSyncPayloadError('invalid platform');
  }
  if (str('query_kind') !== 'rescan') throw new OrderSyncPayloadError('invalid query_kind');
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
    query_kind: 'rescan',
    scene: '-',
    window_start: windowStart,
    window_end: windowEnd,
  };
}

/** Every page in order; `counts` holds what was finished when this throws. */
async function processPages(
  job: ReceivedJob,
  win: OrderRescanWindow,
  deps: OrderRescanHandlerDeps,
  counts: WindowCounts,
): Promise<void> {
  const adapter = deps.registry.get(win.platform);
  const requestId = `order-sync:${job.id}:${job.attempt}`;
  const range = { from: win.window_start, to: win.window_end };
  // OrderPipelineContext's query_kind is the literal 'increment', and the pipeline does not read
  // the field: it takes app, platform and account from the context. The rescan cursor is advanced
  // from `win`, so this value goes nowhere near a cursor.
  const ctx: OrderPipelineContext = { ...win, query_kind: 'increment', requestId };
  await fetchWindow(range, {
    adapter,
    call: { appId: win.app_id, requestId, purpose: 'order_sync' },
    onPage: async (orders) => {
      counts.pages += 1;
      for (const order of orders) {
        const outcome = await deps.pipeline.process(order, ctx);
        counts.count += 1;
        if (outcome !== undefined && outcome.kind === 'inserted') counts.inserted += 1;
      }
    },
  });
}

export async function handleOrderRescanWindow(
  job: ReceivedJob,
  deps: OrderRescanHandlerDeps,
): Promise<void> {
  const win = parseOrderRescanWindow(job.payload, deps.platforms);
  const fields = {
    platform: win.platform,
    account: win.union_account_id,
    window_start: win.window_start,
    window_end: win.window_end,
  };
  // D10-36: a window of any account but the credential owner would fetch someone else's orders.
  // Finish without fetching or advancing; retrying cannot change the answer.
  if (deps.access.queryableAccount !== undefined) {
    const queryable = await deps.access.queryableAccount(win.platform);
    if (queryable !== win.union_account_id) {
      deps.logger?.error(
        {
          ...fields,
          attempt: job.attempt,
          reason: queryable === null ? 'no_queryable_account' : 'not_queryable_account',
        },
        'order_sync_rescan_window_account_mismatch',
      );
      return;
    }
  }
  // BR-ID-24 ④: the cursor stays, so the scheduler re-dispatches from there after re-auth.
  if (!(await deps.access.siteAuthAvailable(win))) {
    deps.logger?.info(
      { ...fields, attempt: job.attempt },
      'order_sync_rescan_window_paused_site_auth',
    );
    return;
  }
  const counts: WindowCounts = { pages: 0, count: 0, inserted: 0 };
  const warnMissing = (): void => {
    if (counts.inserted > 0) {
      deps.logger?.warn({ ...fields, ...counts }, 'order_sync_rescan_found_missing');
    }
  };
  let advanced: boolean;
  try {
    await processPages(job, win, deps, counts);
    advanced = await deps.cursors.advance(win);
  } catch (error) {
    warnMissing();
    throw error;
  }
  deps.logger?.info(
    { ...fields, ...counts, attempt: job.attempt, advanced },
    'order_sync_rescan_window_done',
  );
  warnMissing();
}
