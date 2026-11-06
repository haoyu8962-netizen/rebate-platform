// B1-29a: the price trend of one product from its price_snapshot runs, a pure function.
import type { PriceTrend, PriceTrendPoint, PriceTrendRow, PriceTrendSourceKey } from './types.ts';
import { DAY_MS, WINDOW_DAYS, dayLabel, dayNumber, windowStart } from './window.ts';

export function noPriceTrend(): PriceTrend {
  return {
    status: 'no_data',
    points: [],
    start_date: null,
    window_days: WINDOW_DAYS,
    source_key: 'price_trend.source.general',
    mode_price_fen: null,
  };
}

/**
 * BR-WATCH-19 细则「商品详情价格走势的最常见价」: the daily price seen on the most days, compared
 * exactly in fen; on a tie the price whose latest day is the most recent. Points are ascending,
 * one per day. Empty → null.
 */
export function modePriceFen(points: readonly PriceTrendPoint[]): bigint | null {
  const seen = new Map<bigint, { days: number; lastIndex: number }>();
  points.forEach((point, index) => {
    const days = (seen.get(point.final_price_fen)?.days ?? 0) + 1;
    seen.set(point.final_price_fen, { days, lastIndex: index });
  });
  let best: bigint | null = null;
  let bestDays = 0;
  let bestIndex = -1;
  for (const [fen, { days, lastIndex }] of seen) {
    if (days > bestDays || (days === bestDays && lastIndex > bestIndex)) {
      best = fen;
      bestDays = days;
      bestIndex = lastIndex;
    }
  }
  return best;
}

/** By platform (Pinduoduo has its own pair, CT-22e), then by the last point's coupon. */
function sourceKeyOf(platform: string | undefined, lastCoupon: bigint): PriceTrendSourceKey {
  if (platform === 'pdd') {
    return lastCoupon > 0n ? 'price_trend.source.pdd' : 'price_trend.source.pdd.general';
  }
  return lastCoupon > 0n ? 'price_trend.source' : 'price_trend.source.general';
}

const SOURCE_PRIORITY = { detail: 0, search: 1, quote: 2 } as const;

interface DailyChoice {
  readonly row: PriceTrendRow;
  readonly priority: number;
  readonly observedAt: number;
}

/**
 * Orchestrator rulings B.1-B.8 and B.10 (couli-runs/B1-29a/decision-orchestrator.md):
 *   window   the 30 natural days (+08:00) [today − 29, today], today = the +08:00 date of `now`;
 *   a day D  has a row's value iff the row's [firstObservedAt, lastObservedAt] meets D (runs
 *            crossing the window start or several days included; no carry-forward over gaps);
 *   per day  within one source the row whose latest instant inside D (min(last, end of D)) is
 *            greatest; across sources detail, then search, then quote; convert and watch ignored;
 *   points   one per day with a value, ascending; fewer distinct days than minDistinctDays →
 *            no_data (points [], start_date null, source_key 'price_trend.source.general');
 *   ok       start_date = first point's date; source_key from the coupon_fen of the row behind
 *            the last point (> 0 'price_trend.source', = 0 'price_trend.source.general'; for
 *            platform 'pdd' the .pdd / .pdd.general pair, B1-29c); mode_price_fen = modePriceFen
 *            of the points (B1-29c). no_data keeps source_key .general on every platform.
 * `platform` is the query's platform code; omitted means not Pinduoduo. minDistinctDays is a
 * positive integer (the caller normalises it). Rows may come in any order.
 */
export function computePriceTrend(
  rows: readonly PriceTrendRow[],
  now: Date,
  minDistinctDays: number,
  platform?: string,
): PriceTrend {
  const nowMs = now.getTime();
  const firstDay = dayNumber(nowMs) - WINDOW_DAYS + 1;
  const fromMs = windowStart(now).getTime();
  const choices: (DailyChoice | undefined)[] = Array.from({ length: WINDOW_DAYS });

  for (const row of rows) {
    if (row.sourceKind === 'convert' || row.sourceKind === 'watch') continue;
    const priority = SOURCE_PRIORITY[row.sourceKind];
    const firstMs = row.firstObservedAt.getTime();
    const lastMs = Math.min(row.lastObservedAt.getTime(), nowMs);
    if (firstMs > lastMs || lastMs < fromMs) continue;
    const start = Math.max(0, dayNumber(firstMs) - firstDay);
    const end = Math.min(WINDOW_DAYS - 1, dayNumber(lastMs) - firstDay);

    // A run contributes only on days it actually intersects, never across a gap.
    for (let index = start; index <= end; index += 1) {
      const observedAt = Math.min(lastMs, fromMs + (index + 1) * DAY_MS - 1);
      const previous = choices[index];
      if (
        previous === undefined ||
        priority < previous.priority ||
        (priority === previous.priority &&
          (observedAt > previous.observedAt ||
            (observedAt === previous.observedAt &&
              firstMs > previous.row.firstObservedAt.getTime())))
      ) {
        choices[index] = { row, priority, observedAt };
      }
    }
  }

  const points: PriceTrendPoint[] = [];
  let lastCoupon = 0n;
  for (let index = 0; index < WINDOW_DAYS; index += 1) {
    const choice = choices[index];
    if (choice === undefined) continue;
    points.push({
      date: dayLabel(now, firstDay + index),
      final_price_fen: choice.row.finalPriceFen,
    });
    lastCoupon = choice.row.couponFen;
  }
  const first = points[0];
  if (first === undefined || points.length < minDistinctDays) return noPriceTrend();
  return {
    status: 'ok',
    points,
    start_date: first.date,
    window_days: WINDOW_DAYS,
    source_key: sourceKeyOf(platform, lastCoupon),
    mode_price_fen: modePriceFen(points),
  };
}
