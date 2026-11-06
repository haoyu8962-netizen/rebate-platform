// B1-29a rule-test helpers (BR-WATCH-05 (2) runs, BR-PROD-03 stable_7d, BR-TEXT-11 plain dates;
// orchestrator rulings B.1-B.11 in couli-runs/B1-29a/decision-orchestrator.md). Everything under
// test comes from the public catalog/index.ts; expectations are literals or derived here by an
// independent model, never read from the implementation.
import fc from 'fast-check';
import { vi } from 'vitest';
import type {
  PriceSnapshotSourceKind,
  PriceTrend,
  PriceTrendRow,
  PriceTrendRowsQuery,
  PriceTrendStore,
} from '../../../../apps/api/src/modules/catalog/index.ts';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** +08:00 has no daylight saving: a fixed offset. */
const OFFSET = 8 * HOUR;

/** The configuration key (04 §10; default 2). */
export const MIN_DAYS_KEY = 'price_trend.min_distinct_days';

export const KINDS: readonly PriceSnapshotSourceKind[] = [
  'detail',
  'search',
  'quote',
  'convert',
  'watch',
];
/** Ruling B.4: detail, then search, then quote; convert and watch are never read. */
const PRIORITY: readonly PriceSnapshotSourceKind[] = ['detail', 'search', 'quote'];

/** The instant of a Beijing wall-clock time, e.g. bj('2031-03-10', '23:59:59.999'). */
export function bj(day: string, time = '12:00:00.000'): Date {
  return new Date(`${day}T${time}+08:00`);
}

/** Epoch ms of 00:00:00.000 +08:00 of a YYYY-MM-DD day. */
export function dayStartMs(day: string): number {
  return bj(day, '00:00:00.000').getTime();
}

/** The +08:00 date (YYYY-MM-DD) of an epoch ms. */
export function dateOfMs(ms: number): string {
  return new Date(ms + OFFSET).toISOString().slice(0, 10);
}

/** day shifted by n natural days. */
export function shiftDay(day: string, n: number): string {
  return dateOfMs(dayStartMs(day) + n * DAY);
}

/** One run row; last defaults to first (a single observation). */
export function row(
  sourceKind: PriceSnapshotSourceKind,
  finalPriceFen: bigint,
  first: Date,
  last: Date = first,
  couponFen = 0n,
): PriceTrendRow {
  return { sourceKind, couponFen, finalPriceFen, firstObservedAt: first, lastObservedAt: last };
}

/** The exact no_data result (ruling B.10). */
export const NO_DATA: PriceTrend = {
  status: 'no_data',
  points: [],
  start_date: null,
  window_days: 30,
  source_key: 'price_trend.source.general',
  mode_price_fen: null,
};

/**
 * B1-29c (BR-WATCH-19 细则「最常见价」): the daily price seen on the most days, exact fen
 * comparison, a tie goes to the price whose latest day is the most recent. Points are in
 * ascending date order, one per day.
 */
function modeOfPoints(points: readonly { final_price_fen: bigint }[]): bigint | null {
  const seen = new Map<bigint, { days: number; lastIndex: number }>();
  points.forEach((point, index) => {
    const entry = seen.get(point.final_price_fen);
    seen.set(point.final_price_fen, { days: (entry?.days ?? 0) + 1, lastIndex: index });
  });
  let best: { fen: bigint; days: number; lastIndex: number } | null = null;
  for (const [fen, { days, lastIndex }] of seen) {
    if (best === null || days > best.days || (days === best.days && lastIndex > best.lastIndex)) {
      best = { fen, days, lastIndex };
    }
  }
  return best === null ? null : best.fen;
}

/**
 * Independent model of rulings B.1-B.8 and B.10 (and, B1-29c, mode_price_fen by modeOfPoints).
 * Same-kind rows must be disjoint (as the writer produces them), so the "latest instant inside
 * the day" never ties.
 */
export function modelTrend(
  rows: readonly PriceTrendRow[],
  nowMs: number,
  minDistinctDays: number,
): PriceTrend {
  const today = dateOfMs(nowMs);
  const points: { date: string; final_price_fen: bigint }[] = [];
  let lastCoupon = 0n;
  for (let back = 29; back >= 0; back -= 1) {
    const day = shiftDay(today, -back);
    const start = dayStartMs(day);
    const end = start + DAY; // exclusive
    for (const kind of PRIORITY) {
      let best: PriceTrendRow | null = null;
      let bestAt = -Infinity;
      for (const r of rows) {
        if (r.sourceKind !== kind) continue;
        const first = r.firstObservedAt.getTime();
        const last = r.lastObservedAt.getTime();
        if (first >= end || last < start) continue;
        const inDay = Math.min(last, end - 1);
        if (inDay > bestAt) {
          best = r;
          bestAt = inDay;
        }
      }
      if (best !== null) {
        points.push({ date: day, final_price_fen: best.finalPriceFen });
        lastCoupon = best.couponFen;
        break;
      }
    }
  }
  if (points.length < minDistinctDays) return NO_DATA;
  return {
    status: 'ok',
    points,
    start_date: points[0]!.date,
    window_days: 30,
    source_key: lastCoupon > 0n ? 'price_trend.source' : 'price_trend.source.general',
    mode_price_fen: modeOfPoints(points),
  };
}

/** A fake store: answers `stability` and returns `rows` whatever the window asked. */
export function fakeStore(
  stability: Awaited<ReturnType<PriceTrendStore['keyStability']>>,
  rows: readonly PriceTrendRow[],
) {
  const keyStability = vi.fn<PriceTrendStore['keyStability']>(async () => stability);
  const readRows = vi.fn<(query: PriceTrendRowsQuery) => Promise<readonly PriceTrendRow[]>>(
    async () => rows,
  );
  const store: PriceTrendStore = { keyStability, rows: readRows };
  return { store, keyStability, readRows };
}

/** A configuration reader answering `value` for the min-days key (undefined → no entry). */
export function minDaysConfig(value: unknown, fail = false) {
  const configValue = vi.fn(async (_appId: string, key: string) => {
    if (fail) throw new Error('config store down');
    if (key !== MIN_DAYS_KEY || value === undefined) return null;
    return { value: value as never, version: 1 };
  });
  return { configValue };
}

/**
 * Property-test variant of fakeStore: plain async functions, no vi.fn spies. Vitest keeps every
 * vi.fn (with its calls and results) in its mock registry, so a spy per fast-check run exhausts
 * the heap at CI run counts. Same answers as fakeStore.
 */
export function plainStore(
  stability: Awaited<ReturnType<PriceTrendStore['keyStability']>>,
  rows: readonly PriceTrendRow[],
): PriceTrendStore {
  return {
    keyStability: async () => stability,
    rows: async () => rows,
  };
}

/** Property-test variant of minDaysConfig: a plain async function, no vi.fn spy. */
export function plainConfig(value: unknown) {
  return {
    configValue: async (_appId: string, key: string) => {
      if (key !== MIN_DAYS_KEY || value === undefined) return null;
      return { value: value as never, version: 1 };
    },
  };
}

// ---- fast-check arbitraries ----

/** Amounts: 0, 1, odd numbers, around 2^31 and beyond (bigint, never float). */
export const fenArb: fc.Arbitrary<bigint> = fc.oneof(
  fc.constantFrom(0n, 1n, 3n, 999n, 2n ** 31n - 1n, 2n ** 31n, 2n ** 31n + 1n, 2n ** 53n + 1n),
  fc.bigInt({ min: 0n, max: 2n ** 62n }),
);

/** A time of day in ms, biased to both sides of the +08:00 midnight. */
export const timeOfDayArb: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, 1, DAY - 2, DAY - 1, 16 * HOUR - 1, 16 * HOUR),
  fc.integer({ min: 0, max: DAY - 1 }),
);

/** A base day; `today` is this plus 0..800 days, so months, years and leap days are crossed. */
export const BASE_DAY = '2031-01-01';

/** Now: today at a time biased to 00:00:00.000 and 23:59:59.999 +08:00. */
export const nowArb: fc.Arbitrary<number> = fc
  .tuple(fc.integer({ min: 0, max: 800 }), timeOfDayArb)
  .map(([d, t]) => dayStartMs(BASE_DAY) + d * DAY + t);

/** An instant `dayOffset` days from `today`'s start (negative = earlier) at a biased time. */
export function instantArb(
  minDay: number,
  maxDay: number,
): fc.Arbitrary<{ day: number; t: number }> {
  return fc.record({ day: fc.integer({ min: minDay, max: maxDay }), t: timeOfDayArb });
}

/**
 * Disjoint runs of one kind as [first, last] ms pairs relative to today's start, each run either a
 * single observation or a span (possibly several days), all at or before nowMs.
 */
export function disjointRuns(
  kind: PriceSnapshotSourceKind,
  stamps: readonly number[],
  singles: readonly boolean[],
  fens: readonly bigint[],
  coupons: readonly bigint[],
): PriceTrendRow[] {
  const sorted = [...new Set(stamps)].sort((a, b) => a - b);
  const out: PriceTrendRow[] = [];
  let i = 0;
  let k = 0;
  while (i < sorted.length) {
    const single = singles[k % Math.max(singles.length, 1)] ?? true;
    const first = sorted[i]!;
    const last = single || i + 1 >= sorted.length ? first : sorted[i + 1]!;
    out.push(
      row(
        kind,
        fens[k % Math.max(fens.length, 1)] ?? 1n,
        new Date(first),
        new Date(last),
        coupons[k % Math.max(coupons.length, 1)] ?? 0n,
      ),
    );
    i += last === first ? 1 : 2;
    k += 1;
  }
  return out;
}

/**
 * Arbitrary price_snapshot rows of all five kinds around the window of `nowMs`: from 40 days
 * before today (runs crossing the window start) up to nowMs, same-kind runs disjoint.
 */
export function rowsArb(nowMs: number): fc.Arbitrary<PriceTrendRow[]> {
  const todayStart = dayStartMs(dateOfMs(nowMs));
  const stamp = instantArb(-40, 0)
    .map(({ day, t }) => todayStart + day * DAY + t)
    .filter((ms) => ms <= nowMs);
  const perKind = (kind: PriceSnapshotSourceKind) =>
    fc
      .record({
        stamps: fc.array(stamp, { maxLength: 12 }),
        singles: fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        fens: fc.array(fenArb, { minLength: 1, maxLength: 6 }),
        coupons: fc.array(fenArb, { minLength: 1, maxLength: 6 }),
      })
      .map(({ stamps, singles, fens, coupons }) =>
        disjointRuns(kind, stamps, singles, fens, coupons),
      );
  return fc
    .tuple(...KINDS.map(perKind))
    .chain((groups) => fc.shuffledSubarray(groups.flat(), { minLength: groups.flat().length }));
}
