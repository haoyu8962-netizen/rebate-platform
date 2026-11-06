// B1-29a: the read use case of the price trend (no route here; B1-29b registers it).
import { computePriceTrend, noPriceTrend } from './compute.ts';
import type { PriceTrend, PriceTrendOptions, PriceTrendQuery } from './types.ts';
import { dateAt, windowStart } from './window.ts';

/**
 * Orchestrator rulings B.5, B.6, B.9, B.11:
 *   1. store.keyStability(query.platform) is not 'stable_7d' (or null) → no_data; reading the
 *      rows is then optional.
 *   2. price_trend.min_distinct_days through options.config.configValue(appId, key); default 2
 *      when missing, not a positive safe integer, or the read fails.
 *   3. store.rows for exactly (appId, platform, productKey) and the window of options.clock.now(),
 *      then computePriceTrend with query.platform (source_key pair, B1-29c). Only price_snapshot is read: no observation table, no union call.
 * The result has only the PriceTrend fields; nothing from the caller beyond the query is used.
 */
export async function getPriceTrend(
  options: PriceTrendOptions,
  query: PriceTrendQuery,
): Promise<PriceTrend> {
  const now = structuredClone(options.clock.now());
  const { appId, platform, productKey } = query;
  if ((await options.store.keyStability(platform)) !== 'stable_7d') return noPriceTrend();

  let minDistinctDays = 2;
  try {
    const entry = await options.config.configValue(appId, 'price_trend.min_distinct_days');
    const value = entry?.value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      minDistinctDays = value;
    }
  } catch {
    // Configuration outages use the same default as a missing or invalid value.
  }

  const rows = await options.store.rows({
    appId,
    platform,
    productKey,
    from: windowStart(now),
    // The store's upper bound is exclusive; include the captured Clock instant.
    until: dateAt(now, now.getTime() + 1),
  });
  return computePriceTrend(rows, now, minDistinctDays, platform);
}
