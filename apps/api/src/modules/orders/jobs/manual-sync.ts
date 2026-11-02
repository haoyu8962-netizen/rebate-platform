// B1-09i: the order-sync queue's jobs of a console manual sync (application/manual-sync.ts sends
// them; 01 F-ORD-10; 02 §7.1). A window job ('manual_window') fetches its fixed
// [window_start, window_end) like a scheduled window, through application/fetch-window.ts (B1-04zt:
// a window the upstream calls too large is halved inside the job, its counts one row's); an
// order-number job ('manual_order_nos', pdd only) fetches every number through union's
// getPddOrderDetail. Every order goes to the pipeline in order. sync_cursors is never read nor
// advanced.
// Write-back (order_sync_requests and the job's own row `sync_seq` in order_sync_request_windows):
// the first job taken moves the request queued → running; a job ends its row done with its counts
// once all its orders are processed (fetched = orders returned, stored = pipeline inserted /
// updated), and the request is done only when no row of it is left queued or running, its counts
// the sum of its rows (infra/order-sync-requests.ts). A row ends once, so a redelivered job counts
// nothing twice. Any fetch or pipeline failure is rethrown with nothing counted, so the queue
// retries the whole job; on the last attempt (attempt > the queue's retryLimit, after which the job
// goes to order-sync.dead) the row and the request are failed first ('retries_exhausted'), so a
// dead window never leaves the request running. A job taken while the site authorization is paused
// (BR-ID-24 ④), while the worker's offline breaker of the platform is open (02 §6.2; the breaker
// lives in this process only) or whose account is not the adapter's credential owner (D10-36)
// fetches nothing and fails its row and the request (error, finished_at), which frees its filter;
// jobs of an ended (done or failed) request are dropped.
import type { JobPayload, ReceivedJob } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder } from '../../union/index.ts';
import { MANUAL_SYNC_ORDER_NO_PLATFORMS } from '../domain/manual-sync.ts';
import { parseInstantMs, scheduledPlatforms } from '../domain/sync-window.ts';
import { fetchWindow } from '../application/fetch-window.ts';
import type { OrderPipelineContext, OrderPipelinePort } from '../application/pipeline-types.ts';
import type { SyncAccessPort, SyncLogger, SyncRegistry } from '../application/sync-ports.ts';
import {
  MANUAL_SYNC_ORDER_NOS_JOB,
  MANUAL_SYNC_ORDER_NOS_KIND,
  MANUAL_SYNC_WINDOW_JOB,
} from '../application/manual-sync.ts';
import type { OrderSyncRequestProgress } from '../infra/order-sync-requests.ts';
import { OrderSyncPayloadError } from './order-sync.ts';

/**
 * retryLimit of the order-sync queue (platform's queue catalog: the business queue defaults). The
 * handler's attempt runs 1..retryLimit + 1; a failure on the last one dead-letters the job.
 */
export const MANUAL_SYNC_RETRY_LIMIT = 5;

export interface ManualSyncHandlerDeps {
  readonly access: SyncAccessPort;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
  readonly requests: OrderSyncRequestProgress;
  readonly logger?: SyncLogger;
  /** Defaults to MANUAL_SYNC_RETRY_LIMIT. */
  readonly retryLimit?: number;
}

export function isManualSyncJob(job: Pick<ReceivedJob, 'name'>): boolean {
  return job.name === MANUAL_SYNC_WINDOW_JOB || job.name === MANUAL_SYNC_ORDER_NOS_JOB;
}

interface ManualJob {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly sync_id: string;
  readonly seq: number;
  readonly window: { readonly window_start: string; readonly window_end: string } | null;
  readonly order_nos: readonly string[] | null;
}

function parseManualJob(job: ReceivedJob): ManualJob {
  const payload: JobPayload = job.payload;
  const str = (key: string): string => {
    const v = payload[key];
    if (typeof v !== 'string' || v === '') throw new OrderSyncPayloadError(`invalid ${key}`);
    return v;
  };
  const platform = str('platform');
  if (!(scheduledPlatforms() as readonly string[]).includes(platform)) {
    throw new OrderSyncPayloadError('invalid platform');
  }
  if (str('scene') !== '-') throw new OrderSyncPayloadError('invalid scene');
  const base = {
    app_id: str('app_id'),
    platform: platform as RegisteredPlatform,
    union_account_id: str('union_account_id'),
    sync_id: str('sync_id'),
    seq: seqOf(payload['sync_seq']),
  };
  if (job.name === MANUAL_SYNC_ORDER_NOS_JOB) {
    if (str('query_kind') !== MANUAL_SYNC_ORDER_NOS_KIND) {
      throw new OrderSyncPayloadError('invalid query_kind');
    }
    if (!MANUAL_SYNC_ORDER_NO_PLATFORMS.includes(base.platform)) {
      throw new OrderSyncPayloadError('invalid platform');
    }
    const numbers = payload['order_nos'];
    if (
      !Array.isArray(numbers) ||
      numbers.length === 0 ||
      numbers.some((n) => typeof n !== 'string' || n === '')
    ) {
      throw new OrderSyncPayloadError('invalid order_nos');
    }
    return { ...base, window: null, order_nos: numbers as string[] };
  }
  if (str('query_kind') !== 'increment') throw new OrderSyncPayloadError('invalid query_kind');
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
  return { ...base, window: { window_start: windowStart, window_end: windowEnd }, order_nos: null };
}

function seqOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderSyncPayloadError('invalid sync_seq');
  }
  return value;
}

const STORED: ReadonlySet<string> = new Set(['inserted', 'updated']);

export async function handleManualSyncJob(
  job: ReceivedJob,
  deps: ManualSyncHandlerDeps,
): Promise<void> {
  const m = parseManualJob(job);
  const fields = {
    platform: m.platform,
    account: m.union_account_id,
    sync_id: m.sync_id,
    seq: m.seq,
    attempt: job.attempt,
    ...(m.window ?? {}),
  };
  const status = await deps.requests.status(m.app_id, m.sync_id);
  // An ended request has no row left queued or running: a redelivered job of it fetches nothing.
  if (status === null || status === 'failed' || status === 'done') {
    deps.logger?.info({ ...fields, status }, 'order_manual_sync_job_dropped');
    return;
  }
  const refuse = async (reason: string): Promise<void> => {
    deps.logger?.warn({ ...fields, reason }, 'order_manual_sync_job_refused');
    await deps.requests.finish(m.app_id, m.sync_id, m.seq, { status: 'failed', error: reason });
  };
  // D10-36: the adapter queries one credential set per platform.
  if (deps.access.queryableAccount !== undefined) {
    const queryable = await deps.access.queryableAccount(m.platform);
    if (queryable !== m.union_account_id) {
      await refuse(queryable === null ? 'no_queryable_account' : 'not_queryable_account');
      return;
    }
  }
  // BR-ID-24 ④: a job taken while the site authorization is paused fetches nothing.
  const stream = { app_id: m.app_id, platform: m.platform, union_account_id: m.union_account_id };
  const scheduled = { ...stream, query_kind: 'increment', scene: '-' };
  if (!(await deps.access.siteAuthAvailable(scheduled))) {
    await refuse('site_auth_paused');
    return;
  }
  // 02 §6.2: nothing is fetched while the platform's offline breaker is open; the request ends so
  // the filter is free again instead of the job burning its retries on circuit_open.
  if (await deps.access.offlineCircuitOpen(m.platform)) {
    await refuse('offline_circuit_open');
    return;
  }
  await deps.requests.start(m.app_id, m.sync_id, m.seq);
  try {
    await fetchAndRecord(job, m, deps, fields);
  } catch (error) {
    if (job.attempt > (deps.retryLimit ?? MANUAL_SYNC_RETRY_LIMIT)) {
      deps.logger?.warn(
        { ...fields, reason: 'retries_exhausted' },
        'order_manual_sync_job_refused',
      );
      await deps.requests.finish(m.app_id, m.sync_id, m.seq, {
        status: 'failed',
        error: 'retries_exhausted',
      });
    }
    throw error;
  }
}

async function fetchAndRecord(
  job: ReceivedJob,
  m: ManualJob,
  deps: ManualSyncHandlerDeps,
  fields: Record<string, unknown>,
): Promise<void> {
  const stream = { app_id: m.app_id, platform: m.platform, union_account_id: m.union_account_id };
  const adapter = deps.registry.get(m.platform);
  const requestId = `order-sync:${job.id}:${job.attempt}`;
  const call = { appId: m.app_id, requestId, purpose: 'order_sync' } as const;
  let fetched = 0;
  let stored = 0;
  const processAll = async (orders: readonly UnionOrder[], ctx: OrderPipelineContext) => {
    for (const order of orders) {
      fetched += 1;
      const result = await deps.pipeline.process(order, ctx);
      if (result !== undefined && STORED.has(result.kind)) stored += 1;
    }
  };
  if (m.window !== null) {
    const ctx: OrderPipelineContext = {
      ...stream,
      query_kind: 'increment',
      scene: '-',
      ...m.window,
      requestId,
    };
    const range = { from: m.window.window_start, to: m.window.window_end };
    await fetchWindow(range, { adapter, call, onPage: (orders) => processAll(orders, ctx) });
  } else {
    const detail = adapter.getPddOrderDetail;
    if (detail === undefined) {
      deps.logger?.warn(
        { ...fields, reason: 'order_detail_unsupported' },
        'order_manual_sync_job_refused',
      );
      await deps.requests.finish(m.app_id, m.sync_id, m.seq, {
        status: 'failed',
        error: 'order_detail_unsupported',
      });
      return;
    }
    // The pipeline context is shaped as a window's; an order-number job has no window, so the
    // bounds stay empty (the pipeline reads only app, platform and account from it).
    const ctx: OrderPipelineContext = {
      ...stream,
      query_kind: 'increment',
      scene: '-',
      window_start: '',
      window_end: '',
      requestId,
    };
    for (const orderSn of m.order_nos!) {
      const order = await detail.call(adapter, orderSn, call);
      await processAll([order], ctx);
    }
  }
  await deps.requests.finish(m.app_id, m.sync_id, m.seq, { status: 'done', fetched, stored });
  deps.logger?.info({ ...fields, fetched, stored }, 'order_manual_sync_job_done');
}
