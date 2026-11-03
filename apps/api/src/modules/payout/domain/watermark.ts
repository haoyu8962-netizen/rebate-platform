// B2-06c: the pure part of the watermark check of EXECUTE (规划/08 BR-WDR-18 ①②③, BR-WDR-12 ③).
// No I/O and no clock: the caller passes `now` and the amounts it read on its transaction.
//   forecastWindow  the last 7 complete natural days (+08:00) before the day of `now`:
//                   [today 00:00 +08:00 − 7 days, today 00:00 +08:00).
//   forecastFen     P = round_half_up(seven-day total / 7) × 3 (bigint fen).
//   judgeWatermark  in this order: no reading, or now − t_W > 2 hours → watermark_stale (exactly
//                   2 hours still passes); W < P → watermark_below_forecast;
//                   Σ batch net + Σ PAYING net + Σ net paid after t_W > W × usable_bp / 10000 →
//                   watermark_usable_exceeded (equality passes); otherwise ok.
// Amounts are bigint fen; sums go through @couli/money.
import { accountingDate, chinaDayRange } from '@couli/domain';
import { addFen, mulDivFloor } from '@couli/money';

export type WatermarkRejectReason =
  'watermark_stale' | 'watermark_below_forecast' | 'watermark_usable_exceeded';

/** The latest payout_watermarks row of one channel: W and its measuring time t_W. */
export interface WatermarkReading {
  readonly availableFen: bigint;
  readonly measuredAt: Date;
}

export interface WatermarkCheckInput {
  readonly now: Date;
  /** null: no row for the channel (treated as stale). */
  readonly reading: WatermarkReading | null;
  /** P of BR-WDR-18. */
  readonly forecastFen: bigint;
  /** Σ net_fen of the withdrawals this EXECUTE would move to PAYING. */
  readonly batchNetFen: bigint;
  /** Σ net_fen of the withdrawals already in PAYING. */
  readonly payingNetFen: bigint;
  /** Σ net_fen of the withdrawals that reached PAID_API / PAID_MANUAL after t_W. */
  readonly paidSinceNetFen: bigint;
  /** payout.watermark_usable_bp (0..10000). */
  readonly usableBp: number;
}

export type WatermarkVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: WatermarkRejectReason };

export interface ForecastWindow {
  /** Inclusive start: 00:00 +08:00 seven days before the day of `now`. */
  readonly from: Date;
  /** Exclusive end: 00:00 +08:00 of the day of `now`. */
  readonly to: Date;
}

const DAY_MS = 86_400_000;
/** BR-WDR-18 ②: a reading older than this is stale (exactly this age still passes). */
const MAX_READING_AGE_MS = 2 * 3_600_000;
const FORECAST_DAYS = 7n;
const FORECAST_HORIZON_DAYS = 3n;
const BP_DENOMINATOR = 10_000n;

/** BR-WDR-18 细则 (D10-241): up to this far ahead of now is clock skew; further is refused. */
const MAX_READING_AHEAD_MS = 5 * 60_000;

/**
 * Whether a W may be entered with this measuring time (D10-241, D10-592): at most 5 minutes after
 * now, at most 2 hours before now (a reading older than that would already be stale), and not
 * before the channel's latest reading (the same time is fine). Each limit itself passes.
 */
export function readingTimeAcceptable(input: {
  readonly now: Date;
  readonly measuredMs: number;
  readonly latest: WatermarkReading | null;
}): boolean {
  const { measuredMs, latest } = input;
  const nowMs = input.now.getTime();
  if (measuredMs > nowMs + MAX_READING_AHEAD_MS) return false;
  if (measuredMs < nowMs - MAX_READING_AGE_MS) return false;
  return latest === null || measuredMs >= latest.measuredAt.getTime();
}

/** A copy of `at` moved to `ms` (structuredClone + setTime: no `new Date` outside platform/clock). */
function instant(at: Date, ms: number): Date {
  const copy = structuredClone(at);
  copy.setTime(ms);
  return copy;
}

export function forecastWindow(now: Date): ForecastWindow {
  // 00:00 +08:00 of the day of `now`, through the domain calendar (the one natural-day definition).
  const toMs = Date.parse(chinaDayRange(accountingDate(now)).start);
  return { from: instant(now, toMs - Number(FORECAST_DAYS) * DAY_MS), to: instant(now, toMs) };
}

export function forecastFen(sevenDayTotalFen: bigint): bigint {
  // round_half_up(total / 7) = floor((2 × total + 7) / 14) for a non-negative total.
  const doubled = addFen(sevenDayTotalFen, sevenDayTotalFen);
  const dailyAverage = mulDivFloor(addFen(doubled, FORECAST_DAYS), 1n, 2n * FORECAST_DAYS);
  return mulDivFloor(dailyAverage, FORECAST_HORIZON_DAYS, 1n);
}

export function judgeWatermark(input: WatermarkCheckInput): WatermarkVerdict {
  const { reading } = input;
  if (reading === null || input.now.getTime() - reading.measuredAt.getTime() > MAX_READING_AGE_MS) {
    return { ok: false, reason: 'watermark_stale' };
  }
  if (reading.availableFen < input.forecastFen) {
    return { ok: false, reason: 'watermark_below_forecast' };
  }
  const committed = addFen(addFen(input.batchNetFen, input.payingNetFen), input.paidSinceNetFen);
  // Σ > W × bp / 10000 compared exactly: Σ × 10000 > W × bp, no rounding of the bound.
  const scaledSum = mulDivFloor(committed, BP_DENOMINATOR, 1n);
  const usable = mulDivFloor(reading.availableFen, BigInt(input.usableBp), 1n);
  if (scaledSum > usable) return { ok: false, reason: 'watermark_usable_exceeded' };
  return { ok: true };
}
