// B1-09i: pure rules of the console's manual order sync (01 F-ORD-10; 02 §7.1). No Nest, no I/O.
// - manualSyncFilterDigest: the sha256 hex digest of the normalised filter (platform, mode, the
//   window or the order numbers, status_filter) that order_sync_requests.filter_digest stores and the
//   window jobs' singletonKey carries (`platform:account:kind:scene:manual:<digest>:window_start`).
//   Equal filters give equal digests whatever offset the instants were written in.
// - manualSyncLimits: per platform, the earliest window start the farthest look-back range of 02 §7.1
//   allows at `now` (taobao 90 days, jd 30 days, pdd 90 days) and the most order numbers one request
//   may carry (50, 01 F-ORD-10; 0 outside MANUAL_SYNC_ORDER_NO_PLATFORMS). GET
//   /admin/v1/order-syncs/limits returns it and POST checks it. Only platforms with a fixed window
//   cap (INCREMENT_WINDOW_CAP_MS: pdd and jd today) are listed.
import { createHash } from 'node:crypto';
import type { RegisteredPlatform } from '../../union/index.ts';
import { INCREMENT_WINDOW_CAP_MS, isoAt } from './sync-window.ts';

/** The filter of one manual sync request, as the console sent it. */
export type ManualSyncFilter =
  | {
      readonly platform: RegisteredPlatform;
      readonly mode: 'window';
      readonly from: string;
      readonly to: string;
      readonly status_filter: string | null;
    }
  | {
      readonly platform: RegisteredPlatform;
      readonly mode: 'order_nos';
      readonly order_nos: readonly string[];
    };

/** The manual sync limits of one platform (contract AdminOrderSyncPlatformLimit). */
export interface ManualSyncPlatformLimit {
  readonly platform: RegisteredPlatform;
  readonly earliest_from: string;
  readonly max_order_nos: number;
}

const DAY_MS = 86_400_000;

/** 01 F-ORD-10: at most 50 order numbers in one request. */
export const MANUAL_SYNC_MAX_ORDER_NOS = 50;

/** The farthest look-back range of 02 §7.1, in days (taobao weekly 90, jd daily 30, pdd daily 90). */
export const MANUAL_SYNC_LOOK_BACK_DAYS: Readonly<Record<'taobao' | 'jd' | 'pdd', number>> =
  Object.freeze({ taobao: 90, jd: 30, pdd: 90 });

/**
 * The platforms a manual sync can run for: a window cap of 02 §7.1 is fixed for them
 * (INCREMENT_WINDOW_CAP_MS) and the worker's order-sync handler takes their windows.
 */
// TODO(规划/11 §4.5): 淘宝手动同步（窗口上限、按单号查询） — blocked on CAP-TB-07
export function manualSyncPlatforms(): readonly (keyof typeof MANUAL_SYNC_LOOK_BACK_DAYS)[] {
  return (
    Object.keys(MANUAL_SYNC_LOOK_BACK_DAYS) as (keyof typeof MANUAL_SYNC_LOOK_BACK_DAYS)[]
  ).filter((platform) => INCREMENT_WINDOW_CAP_MS[platform] !== undefined);
}

/**
 * Platforms whose order numbers can be fetched one by one (union's getPddOrderDetail). jd stays out
 * for good: its order API only queries by time window.
 */
export const MANUAL_SYNC_ORDER_NO_PLATFORMS: readonly RegisteredPlatform[] = Object.freeze(['pdd']);

/**
 * The status_filter values registered per platform in specs/union/<platform>.md (K-6). No platform
 * registers one yet, so every status_filter is refused (20001 [status_filter]).
 */
// TODO(规划/11 §4.5): 各平台订单查询的状态筛选取值 — blocked on CAP-TB-07 / CAP-JD-07 / CAP-PDD-07
export const MANUAL_SYNC_STATUS_FILTERS: Readonly<
  Partial<Record<RegisteredPlatform, readonly string[]>>
> = Object.freeze({});

export function manualSyncStatusFilterRegistered(
  platform: RegisteredPlatform,
  value: string,
): boolean {
  return MANUAL_SYNC_STATUS_FILTERS[platform]?.includes(value) ?? false;
}

/** Strict ISO 8601 instant with an offset (Z or ±hh:mm); epoch ms, or null when not one. */
export function parseOffsetInstantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/i.exec(
      value,
    );
  if (m === null) return null;
  const [month, day, hour, minute, second] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Canonical instant: epoch ms, whatever offset the input was written in. */
function canonicalInstant(value: string): number {
  const ms = parseOffsetInstantMs(value) ?? Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError('manual sync: invalid instant');
  return ms;
}

export function manualSyncFilterDigest(filter: ManualSyncFilter): string {
  const canonical =
    filter.mode === 'window'
      ? {
          platform: filter.platform,
          mode: filter.mode,
          from: canonicalInstant(filter.from),
          to: canonicalInstant(filter.to),
          status_filter: filter.status_filter,
        }
      : {
          platform: filter.platform,
          mode: filter.mode,
          order_nos: [...new Set(filter.order_nos)].sort(),
        };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function manualSyncLimits(now: Date): readonly ManualSyncPlatformLimit[] {
  return manualSyncPlatforms().map((platform) => ({
    platform,
    earliest_from: isoAt(now, now.getTime() - MANUAL_SYNC_LOOK_BACK_DAYS[platform] * DAY_MS),
    max_order_nos: MANUAL_SYNC_ORDER_NO_PLATFORMS.includes(platform)
      ? MANUAL_SYNC_MAX_ORDER_NOS
      : 0,
  }));
}

/** [from, to) cut into consecutive windows of at most `capMs` each. */
export function manualSyncWindows(
  fromMs: number,
  toMs: number,
  capMs: number,
  like: Date,
): readonly { readonly window_start: string; readonly window_end: string }[] {
  const windows: { window_start: string; window_end: string }[] = [];
  for (let start = fromMs; start < toMs; start += capMs) {
    windows.push({
      window_start: isoAt(like, start),
      window_end: isoAt(like, Math.min(start + capMs, toMs)),
    });
  }
  return windows;
}

/**
 * The request's status after one of its job rows ended (order_sync_request_windows): failed as soon
 * as a row failed, done once no row is left queued or running, running otherwise.
 */
export function manualSyncRequestAfterJob(
  jobStatus: 'done' | 'failed',
  liveRows: number,
): 'running' | 'done' | 'failed' {
  if (jobStatus === 'failed') return 'failed';
  return liveRows === 0 ? 'done' : 'running';
}
