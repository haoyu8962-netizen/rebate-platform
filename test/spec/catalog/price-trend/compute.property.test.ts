// B1-29a: computePriceTrend, properties (05 验收句: 跨日、同日多来源、游程行跨越窗口起点、只有 1 天
// 记录; BR-WATCH-05 (2); BR-TEXT-11; orchestrator rulings B.1-B.8, B.10). Amounts cover 0, 1, odd
// and > 2^31; instants are biased to both sides of the +08:00 midnight. Pure function, no database.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  computePriceTrend,
  type PriceSnapshotSourceKind,
  type PriceTrendRow,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  DAY,
  KINDS,
  NO_DATA,
  dateOfMs,
  dayStartMs,
  fenArb,
  modelTrend,
  nowArb,
  row,
  rowsArb,
  shiftDay,
  timeOfDayArb,
} from './kit.ts';

/** Start (epoch ms) of the window's first day for a given now. */
function windowStartMs(nowMs: number): number {
  return dayStartMs(shiftDay(dateOfMs(nowMs), -29));
}

it('[AC-B1-29a#16] 属性：任意五类来源、任意顺序、跨窗口起点的行与任意 now、min_distinct_days 下，结果与独立模型一致', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb.chain((nowMs) => fc.tuple(fc.constant(nowMs), rowsArb(nowMs))),
      fc.integer({ min: 1, max: 5 }),
      ([nowMs, rows], minDays) => {
        const result = computePriceTrend(rows, new Date(nowMs), minDays);
        expect(result).toEqual(modelTrend(rows, nowMs, minDays));
        expect(computePriceTrend([...rows].reverse(), new Date(nowMs), minDays)).toEqual(result);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-29a#17] 属性（跨日）：一条 detail 游程行从窗口第 a 天覆盖到第 b 天 → a..b 每天一点、同一价格、日期连续升序，start_date = 第 a 天', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb,
      fc.integer({ min: 0, max: 29 }),
      fc.integer({ min: 0, max: 29 }),
      timeOfDayArb,
      timeOfDayArb,
      fenArb,
      fenArb,
      (nowMs, x, y, t1, t2, fen, coupon) => {
        const a = Math.min(x, y);
        const b = Math.max(x, y);
        const start = windowStartMs(nowMs);
        const lastMs = Math.min(start + b * DAY + t2, nowMs);
        const firstMs = Math.min(start + a * DAY + t1, lastMs);
        const rows = [row('detail', fen, new Date(firstMs), new Date(lastMs), coupon)];
        const startDay = dateOfMs(start);
        const days = b - a + 1;
        const expectedPoints = Array.from({ length: days }, (_, i) => ({
          date: shiftDay(startDay, a + i),
          final_price_fen: fen,
        }));
        expect(computePriceTrend(rows, new Date(nowMs), 1)).toEqual({
          status: 'ok',
          points: expectedPoints,
          start_date: shiftDay(startDay, a),
          window_days: 30,
          source_key: coupon > 0n ? 'price_trend.source' : 'price_trend.source.general',
          // Every point carries the same fen, so it is the most common daily price.
          mode_price_fen: fen,
        });
        expect(computePriceTrend(rows, new Date(nowMs), days + 1)).toEqual(NO_DATA);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

const optionalRun = fc.option(
  fc.record({ t1: timeOfDayArb, t2: timeOfDayArb, fen: fenArb, coupon: fenArb }),
  { nil: null },
);

it('[AC-B1-29a#18] 属性（同日多来源）：某天五类来源任意出现、任意时刻 → 该天取 detail，否则 search，否则 quote；只有 convert / watch 则无点', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb,
      fc.integer({ min: 0, max: 28 }),
      fc.tuple(optionalRun, optionalRun, optionalRun, optionalRun, optionalRun),
      fenArb,
      (nowMs, d, runs, anchorFen) => {
        const start = windowStartMs(nowMs);
        const startDay = dateOfMs(start);
        const today = dateOfMs(nowMs);
        const dayMs = start + d * DAY;
        const rows: PriceTrendRow[] = [
          // Anchor: today 00:00:00.000 (never after now), so two distinct days are possible.
          row('detail', anchorFen, new Date(dayStartMs(today))),
        ];
        const byKind = new Map<PriceSnapshotSourceKind, { fen: bigint; coupon: bigint }>();
        runs.forEach((r, i) => {
          if (r === null) return;
          const kind = KINDS[i]!;
          const first = dayMs + Math.min(r.t1, r.t2);
          const last = dayMs + Math.max(r.t1, r.t2);
          rows.push(row(kind, r.fen, new Date(first), new Date(last), r.coupon));
          byKind.set(kind, { fen: r.fen, coupon: r.coupon });
        });
        const chosen = byKind.get('detail') ?? byKind.get('search') ?? byKind.get('quote');
        const result = computePriceTrend(rows, new Date(nowMs), 1);
        const anchorPoint = { date: today, final_price_fen: anchorFen };
        if (chosen === undefined) {
          expect(result).toEqual({
            status: 'ok',
            points: [anchorPoint],
            start_date: today,
            window_days: 30,
            source_key: 'price_trend.source.general',
            mode_price_fen: anchorFen,
          });
        } else {
          const date = shiftDay(startDay, d);
          expect(result).toEqual({
            status: 'ok',
            points: [{ date, final_price_fen: chosen.fen }, anchorPoint],
            start_date: date,
            window_days: 30,
            source_key: 'price_trend.source.general',
            // Equal fen → 2 days; different → 1 day each and today (the anchor) is the latest.
            mode_price_fen: anchorFen,
          });
        }
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-29a#19] 属性（游程行跨越窗口起点）：first 在窗口起点前 k 天、last 在窗口第 j 天 → 第 0..j 天每天一点，start_date = 窗口第一天；j = 0 且 min = 2 → no_data', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb,
      fc.integer({ min: 1, max: 60 }),
      fc.integer({ min: 0, max: 28 }),
      timeOfDayArb,
      timeOfDayArb,
      fenArb,
      fenArb,
      (nowMs, k, j, t1, t2, fen, coupon) => {
        const start = windowStartMs(nowMs);
        const startDay = dateOfMs(start);
        const rows = [
          row(
            'search',
            fen,
            new Date(start - k * DAY + t1),
            new Date(start + j * DAY + t2),
            coupon,
          ),
        ];
        const expected = {
          status: 'ok',
          points: Array.from({ length: j + 1 }, (_, i) => ({
            date: shiftDay(startDay, i),
            final_price_fen: fen,
          })),
          start_date: startDay,
          window_days: 30,
          source_key: coupon > 0n ? 'price_trend.source' : 'price_trend.source.general',
          // Every point carries the same fen.
          mode_price_fen: fen,
        };
        expect(computePriceTrend(rows, new Date(nowMs), 1)).toEqual(expected);
        expect(computePriceTrend(rows, new Date(nowMs), 2)).toEqual(j === 0 ? NO_DATA : expected);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-29a#20] 属性（只有 1 天记录）：所有行落在同一天（任意来源与时刻）→ min_distinct_days ≥ 2 一律 no_data；= 1 时与独立模型一致', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb,
      fc.integer({ min: 0, max: 28 }),
      fc.array(
        fc.record({
          kind: fc.constantFrom(...KINDS),
          t: timeOfDayArb,
          fen: fenArb,
          coupon: fenArb,
        }),
        { minLength: 1, maxLength: 8 },
      ),
      fc.integer({ min: 2, max: 30 }),
      (nowMs, d, obs, minDays) => {
        const dayMs = windowStartMs(nowMs) + d * DAY;
        // One single-observation row per (kind, instant): same-kind rows stay disjoint.
        const seen = new Set<string>();
        const rows = obs
          .filter((o) => {
            const key = `${o.kind}:${o.t}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((o) => row(o.kind, o.fen, new Date(dayMs + o.t), new Date(dayMs + o.t), o.coupon));
        expect(computePriceTrend(rows, new Date(nowMs), minDays)).toEqual(NO_DATA);
        expect(computePriceTrend(rows, new Date(nowMs), 1)).toEqual(modelTrend(rows, nowMs, 1));
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-29a#21] 属性（+08:00 窗口边界）：任意 now，窗口第一天 00:00:00.000 的行计入、早 1 ms 的行不计；今天 00:00:00.000 的行计入今天', () => {
  let checked = 0;
  fc.assert(
    fc.property(nowArb, fenArb, fenArb, fenArb, (nowMs, before, first, today) => {
      const start = windowStartMs(nowMs);
      const todayStart = dayStartMs(dateOfMs(nowMs));
      const rows = [
        row('detail', before, new Date(start - 1)),
        row('detail', first, new Date(start)),
        row('detail', today, new Date(todayStart)),
      ];
      expect(computePriceTrend(rows, new Date(nowMs), 2)).toEqual({
        status: 'ok',
        points: [
          { date: dateOfMs(start), final_price_fen: first },
          { date: dateOfMs(nowMs), final_price_fen: today },
        ],
        start_date: dateOfMs(start),
        window_days: 30,
        source_key: 'price_trend.source.general',
        // Equal fen → 2 days; different → 1 day each and today is the latest.
        mode_price_fen: today,
      });
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
