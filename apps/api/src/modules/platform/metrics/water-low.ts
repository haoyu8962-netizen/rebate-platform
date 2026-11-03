// The worker's water level gauge (B2-09j; BR-WDR-18「W < 1.5P 时告警财务」; D10-592):
// couli_payout_water_low, one sample per app_id. The value comes from payout's read-only port, wired
// by entry.ts (platform imports no business module). Only the worker exports it; couli-fund.yaml
// alerts on it > 0. An app without a conclusion has no sample: 0 means "checked, not low".
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

/** One scrape's values. */
export interface WaterLowSnapshot {
  /**
   * app_id → 1 (W < 1.5P) or 0 (not low). An app_id without a conclusion (no W, or W older than
   * 2 hours) has no key at all: 0 means "checked, not low".
   */
  readonly waterLow: Readonly<Record<string, number>>;
}

/** The gauge and its label. */
export const WATER_LOW_GAUGE = {
  name: 'couli_payout_water_low',
  help: 'Whether the enterprise Alipay balance W is below 1.5 times the forecast P (1) or not (0); no sample without a fresh W (BR-WDR-18).',
  label: 'app_id',
} as const;

/** Default freshness of a cached snapshot: 5 minutes (规划/02 §13 common granularity). */
const DEFAULT_TTL_MS = 300_000;

/**
 * The worker's collection cached like the fund one: within ttlMs the last successful snapshot, never
 * a rejected one, so a failed read fails the scrape and the next scrape reads again.
 */
export function cacheWaterLowCollector(
  collect: () => Promise<WaterLowSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<WaterLowSnapshot> {
  return cacheCollector(collect, clock, ttlMs);
}
