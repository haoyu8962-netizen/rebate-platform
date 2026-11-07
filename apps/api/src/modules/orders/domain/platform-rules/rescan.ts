// B1-04zm: the platform differences of the order rescan (规划/02 §7.1; D10-543), apart from
// PlatformRules: these are defaults of order_sync.rescan.<platform>.enabled / .days, not rules of the
// platform. Only the listed platforms ever rescan; any other code has no entry.
import type { OrderQueryOpt, RegisteredPlatform } from '../../../union/index.ts';

export interface RescanDefaults {
  readonly enabled: boolean;
  readonly days: number;
}

/**
 * B1-04zzr (FU-TB-RESCAN-TIERS, D10-798): the query_kind of a rescan stream. 'rescan' is the single
 * tier of jd / pdd and Taobao's day tier (the existing cursor row); 'rescan_hour' / 'rescan_week'
 * are Taobao's hour and week tiers, each a stream with its own cursor.
 */
export type RescanQueryKind = 'rescan' | 'rescan_hour' | 'rescan_week';

/** B1-04zzr: which order time a rescan tier filters on (OrderQueryOpt.timeBasis). */
export type RescanTimeBasis = Extract<NonNullable<OrderQueryOpt['timeBasis']>, 'pay' | 'update'>;

/** B1-04zzr: one rescan tier of a platform that rescans in tiers. */
export interface RescanTier {
  readonly queryKind: RescanQueryKind;
  /** How far back a round starts, by default (the day tier's .days key overrides it). */
  readonly depthMs: number;
  /** How long one round over the depth should take. */
  readonly periodMs: number;
  readonly timeBasis: RescanTimeBasis;
  /** On when its enabled key is unset. */
  readonly enabled: boolean;
}

/**
 * B1-04zzr: the tiers of a platform that rescans in tiers (Taobao: day, hour, week); null for a
 * single-tier platform (jd, pdd, which keep rescanDefaults) and for any other code.
 */
export function rescanTiers(platform: string): readonly RescanTier[] | null {
  if (!Object.hasOwn(RESCAN_TIERS, platform)) return null;
  return RESCAN_TIERS[platform as RegisteredPlatform] ?? null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RESCAN_TIERS: Readonly<Partial<Record<RegisteredPlatform, readonly RescanTier[]>>> =
  Object.freeze({
    // 02 §7.1 淘宝行：每小时按付款回扫近 3 小时；每天近 30 天（按更新）；每周近 90 天（按付款，
    // 默认关：FU-TB-RESCAN-WEEK-ON）。D10-798。
    taobao: Object.freeze([
      Object.freeze({
        queryKind: 'rescan',
        depthMs: 30 * DAY_MS,
        periodMs: DAY_MS,
        timeBasis: 'update',
        enabled: true,
      }),
      Object.freeze({
        queryKind: 'rescan_hour',
        depthMs: 3 * HOUR_MS,
        periodMs: HOUR_MS,
        timeBasis: 'pay',
        enabled: true,
      }),
      Object.freeze({
        queryKind: 'rescan_week',
        depthMs: 90 * DAY_MS,
        periodMs: 7 * DAY_MS,
        timeBasis: 'pay',
        enabled: false,
      }),
    ] satisfies RescanTier[]),
  });

const RESCAN_DEFAULTS: Readonly<Partial<Record<RegisteredPlatform, RescanDefaults>>> =
  Object.freeze({
    jd: Object.freeze({ enabled: true, days: 30 }),
    // 淘宝天档（rescanTiers 的 'rescan'）沿用这组键与默认值。
    taobao: Object.freeze({ enabled: true, days: 30 }),
    pdd: Object.freeze({ enabled: false, days: 90 }),
  });

/** The defaults of a platform that may rescan; null for any other code. */
export function rescanDefaults(platform: string): RescanDefaults | null {
  if (!Object.hasOwn(RESCAN_DEFAULTS, platform)) return null;
  return RESCAN_DEFAULTS[platform as RegisteredPlatform] ?? null;
}

/** B1-04zzr: the hour tier's window is at most this long (author ruling on round 1, D10-798). */
const HOUR_TIER_WINDOW_CAP_MS = 20 * 60_000;

/**
 * B1-04zzr: a tier's window from the tiered rescan's effective window cap: the hour tier takes at
 * most 20 minutes (a 3-hour round holds whole windows), the other tiers the cap itself.
 */
export function rescanTierWindowMs(queryKind: RescanQueryKind, capMs: number): number {
  return queryKind === 'rescan_hour' ? Math.min(capMs, HOUR_TIER_WINDOW_CAP_MS) : capMs;
}

/**
 * B1-04zzr: whether a tier's round starts with the start margin (now − depth + margin). The hour
 * tier starts at now − 3 hours; the day and week tiers keep the margin, so the week tier's windows
 * stay inside the 90 days the order query accepts.
 */
export function rescanTierHasStartMargin(queryKind: RescanQueryKind): boolean {
  return queryKind !== 'rescan_hour';
}
