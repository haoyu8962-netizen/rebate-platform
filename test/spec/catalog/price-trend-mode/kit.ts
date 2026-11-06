// B1-29c rule-test helpers: the most common daily price (BR-WATCH-19 细则「商品详情价格走势的
// 最常见价」) and the source key by platform and coupon (CT-22e; 08 BR-TEXT-14 表 C「价格走势·
// 拼多多」). Builds on the B1-29a kit (test/spec/catalog/price-trend/kit.ts) without changing it.
// Expectations are literals or derived here by an independent model, never from the implementation.
import fc from 'fast-check';
import type {
  PriceSnapshotSourceKind,
  PriceTrendRow,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { bj, modelTrend, row, shiftDay } from '../price-trend/kit.ts';

/** Every platform code of the contract enum (contracts/enums/platform.yaml). */
export const PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const;
export type PlatformCode = (typeof PLATFORMS)[number];

/** The four source keys (CT-22e: Pinduoduo has its own pair). */
export const SOURCE = 'price_trend.source';
export const SOURCE_GENERAL = 'price_trend.source.general';
export const SOURCE_PDD = 'price_trend.source.pdd';
export const SOURCE_PDD_GENERAL = 'price_trend.source.pdd.general';

/** The source key of an ok trend: by platform, then by the coupon of the last point's row. */
export function sourceKeyOf(platform: string, lastCoupon: bigint): string {
  if (platform === 'pdd') return lastCoupon > 0n ? SOURCE_PDD : SOURCE_PDD_GENERAL;
  return lastCoupon > 0n ? SOURCE : SOURCE_GENERAL;
}

/**
 * Independent model of the most common price over daily prices in ascending date order (one per
 * day): count the days of each exact fen, keep the highest count, then walk back from the most
 * recent day and take the first price with that count. Empty → null.
 */
export function expectedMode(daily: readonly bigint[]): bigint | null {
  const counts = new Map<bigint, number>();
  for (const fen of daily) counts.set(fen, (counts.get(fen) ?? 0) + 1);
  let top = 0;
  for (const count of counts.values()) top = Math.max(top, count);
  for (let index = daily.length - 1; index >= 0; index -= 1) {
    const fen = daily[index]!;
    if (counts.get(fen) === top) return fen;
  }
  return null;
}

/**
 * One single-observation row per consecutive day, the last on `lastDay`, at `time` +08:00 (default
 * 10:00, before a 12:00 now). prices[0] is the earliest day.
 */
export function dailyRows(
  lastDay: string,
  prices: readonly bigint[],
  kind: PriceSnapshotSourceKind = 'detail',
  coupon = 0n,
  time = '10:00:00.000',
): PriceTrendRow[] {
  return prices.map((fen, index) =>
    row(kind, fen, bj(shiftDay(lastDay, index - prices.length + 1), time), undefined, coupon),
  );
}

/** The ok points of `dailyRows(lastDay, prices)`. */
export function dailyPoints(lastDay: string, prices: readonly bigint[]) {
  return prices.map((fen, index) => ({
    date: shiftDay(lastDay, index - prices.length + 1),
    final_price_fen: fen,
  }));
}

/**
 * The B1-29a model (now with mode_price_fen) with the source key chosen by platform as well:
 * Pinduoduo ok trends use the .pdd pair. no_data is left to the B1-29a model.
 */
export function modelTrendFor(
  rows: readonly PriceTrendRow[],
  nowMs: number,
  minDistinctDays: number,
  platform: string,
) {
  const base = modelTrend(rows, nowMs, minDistinctDays);
  if (base.status !== 'ok' || platform !== 'pdd') return base;
  const coupon = base.source_key === SOURCE ? 1n : 0n;
  return { ...base, source_key: sourceKeyOf(platform, coupon) };
}

/** Small fen pools so that equal prices and ties are frequent; includes 0 and > 2^53. */
export const tieFenArb: fc.Arbitrary<bigint> = fc.constantFrom(
  0n,
  1n,
  4678n,
  4790n,
  4989n,
  4990n,
  9007199254740992n,
  9007199254740993n,
);
