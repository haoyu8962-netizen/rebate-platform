// B1-04zza: the 'rights.window' / 'punish.window' jobs on the order-sync queue (application/
// rights-sync.ts has the scheduler and the writer).
// - Payload checks as jobs/order-sync.ts (OrderSyncPayloadError); the window account must be the
//   queryable one and site auth available, else the job ends without fetching or moving a cursor.
// - rights.window: every page of listRefunds (timeBasis update, purpose order_sync), each refund
//   through the writer as type RIGHTS, platform_rights_no = refund_id, deduction = refund_fen,
//   occurred_at = refund_created_at (absent: the Clock). rights_status PROCESSING / SUCCEEDED /
//   FAILED as is, CLOSED_NO_CHARGE → FAILED (counted), null → nothing written (counted). The
//   stream's cursor moves once, after every page.
// - punish.window: every page of listPunishments, each as type PUNISH, status SUCCEEDED,
//   platform_rights_no = punishment_id, occurred_at = the Clock; no cursor.
// - not_found (an order of someone else's slot) is counted only; logs never carry order numbers.
import type { Clock, ReceivedJob } from '../../platform/index.ts';
import {
  isRegisteredPlatform,
  type RegisteredPlatform,
  type UnionPunish,
  type UnionRefund,
} from '../../union/index.ts';
import { parseInstantMs } from '../domain/sync-window.ts';
import type {
  PunishSyncWindow,
  RightsCursorStore,
  RightsSyncItem,
  RightsSyncRegistry,
  RightsSyncTarget,
  RightsSyncWindow,
  RightsSyncWriteResult,
  RightsSyncWriter,
} from '../application/rights-sync.ts';
import type { SyncAccessPort, SyncLogger } from '../application/sync-ports.ts';
import { OrderSyncPayloadError } from './order-sync.ts';

export interface RightsSyncHandlerDeps {
  /** occurred_at of punishments and of refunds without a creation time. */
  readonly clock: Clock;
  readonly access: SyncAccessPort;
  readonly cursors: Pick<RightsCursorStore, 'advance'>;
  readonly registry: RightsSyncRegistry;
  readonly writer: RightsSyncWriter;
  readonly logger?: SyncLogger;
}

interface WindowFields {
  readonly platform: RegisteredPlatform;
  readonly account: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly attempt: number;
}

/** Counters only: logs never carry order numbers, refund ids or amounts. */
interface WindowCounts {
  pages: number;
  count: number;
  applied: number;
  duplicate: number;
  not_applicable: number;
  not_found: number;
  closed_no_charge: number;
  unknown_status: number;
}

function newCounts(): WindowCounts {
  return {
    pages: 0,
    count: 0,
    applied: 0,
    duplicate: 0,
    not_applicable: 0,
    not_found: 0,
    closed_no_charge: 0,
    unknown_status: 0,
  };
}

interface ParsedWindow {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly query_kind: string;
  readonly scene: string;
  readonly window_start: string;
  readonly window_end: string;
}

/** The payload checks of jobs/order-sync.ts; `kind` and `scenes` are what this job accepts. */
function parseWindow(
  payload: ReceivedJob['payload'],
  kind: 'rights' | 'punish',
  scenes: readonly string[],
): ParsedWindow {
  const str = (key: string): string => {
    const v = payload[key];
    if (typeof v !== 'string' || v === '') throw new OrderSyncPayloadError(`invalid ${key}`);
    return v;
  };
  const platform = str('platform');
  if (!isRegisteredPlatform(platform)) throw new OrderSyncPayloadError('invalid platform');
  if (str('query_kind') !== kind) throw new OrderSyncPayloadError('invalid query_kind');
  const scene = str('scene');
  if (!scenes.includes(scene)) throw new OrderSyncPayloadError('invalid scene');
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
    platform,
    union_account_id: str('union_account_id'),
    query_kind: kind,
    scene,
    window_start: windowStart,
    window_end: windowEnd,
  };
}

function parseRightsWindow(payload: ReceivedJob['payload']): RightsSyncWindow {
  const win = parseWindow(payload, 'rights', ['-', 'rescan']);
  return { ...win, query_kind: 'rights', scene: win.scene === 'rescan' ? 'rescan' : '-' };
}

function parsePunishWindow(payload: ReceivedJob['payload']): PunishSyncWindow {
  return { ...parseWindow(payload, 'punish', ['-']), query_kind: 'punish', scene: '-' };
}

function fieldsOf(win: ParsedWindow, job: ReceivedJob): WindowFields {
  return {
    platform: win.platform,
    account: win.union_account_id,
    window_start: win.window_start,
    window_end: win.window_end,
    attempt: job.attempt,
  };
}

/**
 * D10-36: only the account whose credentials the adapter holds may be fetched; BR-ID-24 ④: a job
 * queued before site auth lapsed is taken off without fetching. Retrying cannot change either.
 */
async function windowOpen(
  win: ParsedWindow,
  fields: WindowFields,
  deps: RightsSyncHandlerDeps,
  event: string,
): Promise<boolean> {
  if (deps.access.queryableAccount !== undefined) {
    const queryable = await deps.access.queryableAccount(win.platform);
    if (queryable !== win.union_account_id) {
      deps.logger?.error(
        {
          ...fields,
          reason: queryable === null ? 'no_queryable_account' : 'not_queryable_account',
        },
        `${event}_account_mismatch`,
      );
      return false;
    }
  }
  if (!(await deps.access.siteAuthAvailable(win))) {
    deps.logger?.info(fields, `${event}_paused_site_auth`);
    return false;
  }
  return true;
}

function tally(counts: WindowCounts, result: RightsSyncWriteResult): void {
  counts[result.kind] += 1;
}

function targetOf(win: ParsedWindow, orderId: string): RightsSyncTarget {
  return { app_id: win.app_id, platform: win.platform, sub_order_id: orderId };
}

/**
 * D10-645 ②: the union's normalized state as rights.record takes it. CLOSED_NO_CHARGE (ended
 * without charging us) is recorded as FAILED; anything else (missing, unknown) is null and never
 * taken as a success.
 */
function rightsStatusOf(
  refund: UnionRefund,
  counts: WindowCounts,
): RightsSyncItem['status'] | null {
  switch (refund.rights_status) {
    case 'PROCESSING':
    case 'SUCCEEDED':
    case 'FAILED':
      return refund.rights_status;
    case 'CLOSED_NO_CHARGE':
      counts.closed_no_charge += 1;
      return 'FAILED';
    default:
      counts.unknown_status += 1;
      return null;
  }
}

/** Every page of the window in order, the next page asked with the previous page's cursor. */
async function eachPage<T>(
  fetch: (cursor: string | undefined) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor: string | null;
  }>,
  onPage: (items: readonly T[]) => Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await fetch(cursor);
    await onPage(page.items);
    if (page.nextCursor === null) return;
    if (page.nextCursor === cursor) throw new Error('orders: rights page cursor did not move');
    cursor = page.nextCursor;
  }
}

function logDone(
  deps: RightsSyncHandlerDeps,
  fields: WindowFields,
  counts: WindowCounts,
  extra: Readonly<Record<string, unknown>>,
  event: string,
): void {
  deps.logger?.info({ ...fields, ...counts, ...extra }, `${event}_done`);
  if (counts.unknown_status > 0) {
    // Not taken as a success and not written: someone has to look at the unknown codes.
    deps.logger?.warn(
      { ...fields, unknown_status: counts.unknown_status },
      `${event}_unknown_status`,
    );
  }
}

/** rights.window: every page of listRefunds, each refund to the writer; the cursor moves once. */
export async function handleRightsWindow(
  job: ReceivedJob,
  deps: RightsSyncHandlerDeps,
): Promise<void> {
  const win = parseRightsWindow(job.payload);
  const fields = fieldsOf(win, job);
  const event = 'order_rights_sync_window';
  if (!(await windowOpen(win, fields, deps, event))) return;
  const adapter = deps.registry.get(win.platform);
  // money r1 S2 ①: an adapter that declares no refund source as configured has none.
  const listRefunds = adapter.rightsSources?.refunds === false ? undefined : adapter.listRefunds;
  if (listRefunds === undefined) {
    deps.logger?.error(fields, `${event}_no_source`);
    return;
  }
  const ctx = {
    appId: win.app_id,
    requestId: `order-sync:${job.id}:${job.attempt}`,
    purpose: 'order_sync' as const,
  };
  const range = { from: win.window_start, to: win.window_end };
  const counts = newCounts();
  await eachPage(
    (cursor) =>
      listRefunds.call(
        adapter,
        range,
        ctx,
        cursor === undefined ? { timeBasis: 'update' } : { timeBasis: 'update', cursor },
      ),
    async (refunds) => {
      counts.pages += 1;
      for (const refund of refunds) {
        counts.count += 1;
        const status = rightsStatusOf(refund, counts);
        if (status === null) continue;
        const result = await deps.writer.write(targetOf(win, refund.order_id), {
          type: 'RIGHTS',
          status,
          amount_fen: null,
          deduction_commission_fen: refund.refund_fen,
          occurred_at: refund.refund_created_at ?? deps.clock.now(),
          platform_rights_no: refund.refund_id,
        });
        tally(counts, result);
      }
    },
  );
  const advanced = await deps.cursors.advance(win);
  logDone(deps, fields, counts, { scene: win.scene, advanced }, event);
}

/** punish.window: every page of listPunishments, each as PUNISH / SUCCEEDED; no cursor. */
export async function handlePunishWindow(
  job: ReceivedJob,
  deps: RightsSyncHandlerDeps,
): Promise<void> {
  const win = parsePunishWindow(job.payload);
  const fields = fieldsOf(win, job);
  const event = 'order_punish_sync_window';
  if (!(await windowOpen(win, fields, deps, event))) return;
  const adapter = deps.registry.get(win.platform);
  const listPunishments =
    adapter.rightsSources?.punishments === false ? undefined : adapter.listPunishments;
  if (listPunishments === undefined) {
    deps.logger?.error(fields, `${event}_no_source`);
    return;
  }
  const ctx = {
    appId: win.app_id,
    requestId: `order-sync:${job.id}:${job.attempt}`,
    purpose: 'order_sync' as const,
  };
  const range = { from: win.window_start, to: win.window_end };
  // D10-645 ③: a punishment has no time of its own; it is recorded at the sync instant.
  const syncedAt = deps.clock.now();
  const counts = newCounts();
  await eachPage(
    (cursor) => listPunishments.call(adapter, range, ctx, cursor === undefined ? {} : { cursor }),
    async (punishments: readonly UnionPunish[]) => {
      counts.pages += 1;
      for (const punishment of punishments) {
        counts.count += 1;
        const result = await deps.writer.write(targetOf(win, punishment.order_id), {
          type: 'PUNISH',
          status: 'SUCCEEDED',
          amount_fen: null,
          deduction_commission_fen: punishment.deduction_fen,
          occurred_at: syncedAt,
          platform_rights_no: punishment.punishment_id,
        });
        tally(counts, result);
      }
    },
  );
  logDone(deps, fields, counts, {}, event);
}
