// The worker's stale W gauge (B2-09ze; BR-WDR-18 ② and 细则「多通道的 W」; D10-805 ④):
// couli_payout_water_stale, one sample per app_id. The value comes from payout's read-only port,
// wired by entry.ts (platform imports no business module). Only the worker exports it; couli-fund.yaml
// alerts on it > 0. An app without enterprise Alipay withdrawals waiting to be executed has no
// sample: it is never 1.
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

/** One scrape's values. */
export interface WaterStaleSnapshot {
  /**
   * app_id → 1 (withdrawals waiting to be executed and no fresh W) or 0. An app without waiting
   * withdrawals is never 1.
   */
  readonly waterStale: Readonly<Record<string, number>>;
}

/** The gauge and its label. */
export const WATER_STALE_GAUGE = {
  name: 'couli_payout_water_stale',
  help: 'Whether an app has enterprise Alipay withdrawals waiting to be executed while the channel has no fresh W (1) or has one (0); no sample without waiting withdrawals (BR-WDR-18).',
  label: 'app_id',
} as const;

/** Default freshness of a cached snapshot: 5 minutes (规划/02 §13 common granularity). */
const DEFAULT_TTL_MS = 300_000;

/**
 * The worker's collection cached like the water level one (5 minutes by default): never a rejected
 * snapshot, so a failed read fails the scrape and the next scrape reads again.
 */
export function cacheWaterStaleCollector(
  collect: () => Promise<WaterStaleSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<WaterStaleSnapshot> {
  return cacheCollector(collect, clock, ttlMs);
}
