// B1-29c: computePriceTrend's mode_price_fen, properties (BR-WATCH-19 细则「商品详情价格走势的最常见
// 价」). Daily prices are drawn from a small pool so that ties are frequent; amounts include 0 and
// values beyond 2^53. Expected values come from expectedMode in ./kit.ts (an independent model
// walking back from the most recent day) and the B1-29a model in ../price-trend/kit.ts.
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
  dateOfMs,
  dayStartMs,
  modelTrend,
  nowArb,
  row,
  rowsArb,
  shiftDay,
  timeOfDayArb,
} from '../price-trend/kit.ts';
import { expectedMode, tieFenArb } from './kit.ts';

/** 30 window days, oldest first: a price on that day, or null for a day without any record. */
const dailyArb = fc.array(fc.option(tieFenArb, { nil: null, freq: 3 }), {
  minLength: 30,
  maxLength: 30,
});

/** One detail row per non-null day at a biased time, never after nowMs; the expected points. */
function rowsOfDaily(nowMs: number, daily: readonly (bigint | null)[], times: readonly number[]) {
  const firstDay = shiftDay(dateOfMs(nowMs), -29);
  const rows: PriceTrendRow[] = [];
  const points: { date: string; final_price_fen: bigint }[] = [];
  daily.forEach((fen, index) => {
    if (fen === null) return;
    const date = shiftDay(firstDay, index);
    const at = Math.min(dayStartMs(date) + (times[index % times.length] ?? 0), nowMs);
    rows.push(row('detail', fen, new Date(at)));
    points.push({ date, final_price_fen: fen });
  });
  return { rows, points };
}

it('[AC-B1-29c#16] 属性：任意 30 天每日价（含空档日、0 与 2^53 以上、大量并列）→ 走势 ok 时 mode_price_fen = 出现天数最多、并列取最近一天的价；没有记录时 no_data、null', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb,
      dailyArb,
      fc.array(timeOfDayArb, { minLength: 1, maxLength: 30 }),
      (nowMs, daily, times) => {
        const { rows, points } = rowsOfDaily(nowMs, daily, times);
        const result = computePriceTrend(rows, new Date(nowMs), 1);
        const prices = points.map((p) => p.final_price_fen);
        const mode = expectedMode(prices);
        if (points.length === 0) {
          expect(result.mode_price_fen).toBeNull();
          expect(result.status).toBe('no_data');
        } else {
          expect(result).toEqual({
            status: 'ok',
            points,
            start_date: points[0]!.date,
            window_days: 30,
            source_key: 'price_trend.source.general',
            mode_price_fen: mode,
          });
        }
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-29c#17] 属性：任意五类来源、跨窗口起点、任意顺序的行 → mode_price_fen 与独立模型一致，且等于由结果每日价按规则算出的价；行顺序不影响结果', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb.chain((nowMs) => fc.tuple(fc.constant(nowMs), rowsArb(nowMs))),
      fc.integer({ min: 1, max: 5 }),
      ([nowMs, rows], minDays) => {
        const result = computePriceTrend(rows, new Date(nowMs), minDays);
        const model = modelTrend(rows, nowMs, minDays);
        expect(result).toEqual(model);
        if (model.status === 'ok') {
          const daily = model.points.map((p) => p.final_price_fen);
          expect(result.mode_price_fen).toBe(expectedMode(daily));
        } else {
          expect(result.mode_price_fen).toBeNull();
        }
        const reversed = computePriceTrend([...rows].reverse(), new Date(nowMs), minDays);
        expect(reversed.mode_price_fen).toBe(result.mode_price_fen);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

const SIDE_KINDS: readonly PriceSnapshotSourceKind[] = ['convert', 'watch'];
const READ_KINDS: readonly PriceSnapshotSourceKind[] = ['detail', 'search', 'quote'];

it('[AC-B1-29c#18] 属性（只是统计）：在每日价之外加任意 convert / watch 行（窗口内任意日子与价）和整段在窗口起点之前的任意来源行 → mode_price_fen 不变', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      nowArb,
      dailyArb,
      fc.array(
        fc.record({
          kind: fc.constantFrom(...SIDE_KINDS),
          day: fc.integer({ min: 0, max: 29 }),
          t: timeOfDayArb,
          fen: tieFenArb,
        }),
        { maxLength: 20 },
      ),
      fc.array(
        fc.record({
          kind: fc.constantFrom(...READ_KINDS),
          back: fc.integer({ min: 1, max: 60 }),
          span: fc.integer({ min: 0, max: DAY * 10 }),
          fen: tieFenArb,
        }),
        { maxLength: 6 },
      ),
      (nowMs, daily, side, before) => {
        const { rows, points } = rowsOfDaily(nowMs, daily, [12 * 3_600_000]);
        const windowStart = dayStartMs(shiftDay(dateOfMs(nowMs), -29));
        const noise: PriceTrendRow[] = [];
        for (const s of side) {
          const at = Math.min(windowStart + s.day * DAY + s.t, nowMs);
          noise.push(row(s.kind, s.fen, new Date(at)));
        }
        // Rows wholly before the window, ending 1 ms before its start; one per kind (disjoint).
        const usedKinds = new Set<PriceSnapshotSourceKind>();
        for (const b of before) {
          if (usedKinds.has(b.kind)) continue;
          usedKinds.add(b.kind);
          const last = windowStart - 1;
          const first = Math.max(last - b.span, windowStart - b.back * DAY);
          noise.push(row(b.kind, b.fen, new Date(first), new Date(last)));
        }
        const result = computePriceTrend([...noise, ...rows], new Date(nowMs), 1);
        expect(result.mode_price_fen).toBe(
          points.length === 0 ? null : expectedMode(points.map((p) => p.final_price_fen)),
        );
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-29c#19] 属性（门槛与走势共用）：每日价有 k 个不同日期、min_distinct_days = m → k ≥ m 时 ok 且有值，k < m 时 no_data 且 null', () => {
  let checked = 0;
  fc.assert(
    fc.property(nowArb, dailyArb, fc.integer({ min: 1, max: 31 }), (nowMs, daily, minDays) => {
      const { rows, points } = rowsOfDaily(nowMs, daily, [0]);
      const result = computePriceTrend(rows, new Date(nowMs), minDays);
      if (points.length >= minDays && points.length > 0) {
        expect(result.status).toBe('ok');
        expect(result.mode_price_fen).toBe(expectedMode(points.map((p) => p.final_price_fen)));
      } else {
        expect(result.mode_price_fen).toBeNull();
        expect(result.status).toBe('no_data');
      }
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
