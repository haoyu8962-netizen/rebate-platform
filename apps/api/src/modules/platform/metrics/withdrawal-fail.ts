// The worker's payout failure gauges (B2-09zj; BR-WDR-24 前两项; D10-1157, D10-1186 ①, D10-1203): per
// app_id, today's W6 count, today's W5 + W6 count (the +08:00 day of the injected clock) and the W6
// streak: the app's W5 / W6 ordered by (transition time, id) and cut into runs of consecutive W6 (a W5
// ends a run); the length of the longest run whose last W6 lies in the last 24 hours, counted whole
// (it may reach back before them); 0 without such a run. The values come from payout's read-only
// port, wired by entry.ts (platform imports no business module). Only the worker exports them;
// couli-fund.yaml alerts on the ratio and on the run. An app without any W5 or W6 in the day or in the
// 24 hours has no sample.
import { accountingDate } from '@couli/domain';
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

/** One scrape's values, each app_id → count. */
export interface WithdrawalFailSnapshot {
  /** W6 transitions (PAYING → FAILED by the channel) in the current +08:00 day. */
  readonly w6Today: Readonly<Record<string, number>>;
  /** W5 plus W6 transitions in the current +08:00 day (W8 and W10 not counted). */
  readonly w5w6Today: Readonly<Record<string, number>>;
  /**
   * The longest run of consecutive W6 (W5 / W6 ordered by (withdrawals.updated_at, id), a W5 ends a
   * run) whose last W6 lies in (now − 24h, now] of the injected clock, counted whole however far back
   * it reaches; 0 without such a run; not cut at the day (D10-1203).
   */
  readonly w6Streak: Readonly<Record<string, number>>;
}

/** The three gauges: snapshot key → metric name and help text (label WITHDRAWAL_FAIL_LABEL). */
export const WITHDRAWAL_FAIL_GAUGES: Readonly<
  Record<keyof WithdrawalFailSnapshot, { readonly name: string; readonly help: string }>
> = {
  w6Today: {
    name: 'couli_withdrawals_w6_today',
    help: 'Withdrawals failed by the channel (W6, no manual resolution) in the current +08:00 day, by transition time (updated_at), per app_id (BR-WDR-24).',
  },
  w5w6Today: {
    name: 'couli_withdrawals_w5w6_today',
    help: 'Withdrawals paid (W5) or failed (W6) by the channel in the current +08:00 day, by transition time (updated_at), per app_id; W8, W10 and W11 not counted (BR-WDR-24).',
  },
  w6Streak: {
    name: 'couli_withdrawals_w6_streak',
    help: 'Consecutive W6 of the app_id: its W5 / W6 ordered by transition time (updated_at, then id) and cut into runs of W6 by each W5; the length of the longest run whose last W6 is within the last 24 hours, counted whole even where it reaches back before them; 0 without one; not cut at the day; W8, W9, W10 and W11 neither count nor break it (BR-WDR-24).',
  },
};

/** The one label of the three gauges. */
export const WITHDRAWAL_FAIL_LABEL = 'app_id';

/** Default freshness of a cached snapshot: 5 minutes (规划/02 §13 common granularity). */
const DEFAULT_TTL_MS = 300_000;

/**
 * The worker's collection cached like the water level one (5 minutes by default): never a rejected
 * snapshot, so a failed read fails the scrape and the next scrape reads again. Like the auto-payout
 * one, a snapshot is also kept only within its +08:00 day: the day's counts never outlive midnight.
 */
export function cacheWithdrawalFailCollector(
  collect: () => Promise<WithdrawalFailSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<WithdrawalFailSnapshot> {
  return cacheCollector(collect, clock, ttlMs, accountingDate);
}
