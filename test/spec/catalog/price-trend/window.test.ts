// B1-29a: the window that getPriceTrend asks the store for (review r1 S1: the window start is
// 00:00 +08:00 of today − 29, not UTC midnight; the from/until passed to store.rows are bound by
// tests). BR-WATCH-05 (2) runs, BR-TEXT-11 +08:00 dates; orchestrator rulings B.1, B.2, B.9, B.11.
// The fake store here answers like the SQL must: only runs whose [first, last] meets [from, until).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import {
  getPriceTrend,
  type PriceTrendQuery,
  type PriceTrendRow,
  type PriceTrendRowsQuery,
  type PriceTrendStore,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  NO_DATA,
  bj,
  dateOfMs,
  dayStartMs,
  minDaysConfig,
  modelTrend,
  nowArb,
  plainConfig,
  row,
  rowsArb,
  shiftDay,
} from './kit.ts';

const QUERY: PriceTrendQuery = { appId: 'pt-win', platform: 'taobao', productKey: 'tb:77' };

/** A store that filters like the SQL must: runs whose [first, last] meets [from, until). */
function windowStore(rows: readonly PriceTrendRow[]) {
  const readRows = vi.fn(async (query: PriceTrendRowsQuery) =>
    rows.filter(
      (r) =>
        r.firstObservedAt.getTime() < query.until.getTime() &&
        r.lastObservedAt.getTime() >= query.from.getTime(),
    ),
  );
  const store: PriceTrendStore = { keyStability: async () => 'stable_7d', rows: readRows };
  return { store, readRows };
}

function optionsAt(now: Date, rows: readonly PriceTrendRow[], minDays: unknown = undefined) {
  const fake = windowStore(rows);
  return {
    fake,
    opts: { store: fake.store, clock: new FixedClock(now), config: minDaysConfig(minDays) },
  };
}

it.each([
  ['2031-03-10 12:00:00.000', bj('2031-03-10', '12:00:00.000'), '2031-02-09'],
  ['2031-03-10 23:59:59.999', bj('2031-03-10', '23:59:59.999'), '2031-02-09'],
  ['2031-03-11 00:00:00.000', bj('2031-03-11', '00:00:00.000'), '2031-02-10'],
  ['2031-03-10 07:59:59.999', bj('2031-03-10', '07:59:59.999'), '2031-02-09'],
] as const)(
  '[AC-B1-29a#36] 传给 store.rows 的窗口：Clock = %s +08:00 → from 不晚于 %s 00:00:00.000 +08:00（窗口首日按 +08:00，不按 UTC 零点），until 晚于 now；身份三元组原样传入',
  async (_label, now, firstDay) => {
    const { fake, opts } = optionsAt(now, [row('detail', 100n, now)]);
    await getPriceTrend(opts, QUERY);
    expect(fake.readRows).toHaveBeenCalled();
    for (const [query] of fake.readRows.mock.calls) {
      expect(query.from).toBeInstanceOf(Date);
      expect(query.until).toBeInstanceOf(Date);
      expect(query.from.getTime()).toBeLessThanOrEqual(bj(firstDay, '00:00:00.000').getTime());
      expect(query.until.getTime()).toBeGreaterThan(now.getTime());
      expect(query).toMatchObject({ appId: 'pt-win', platform: 'taobao', productKey: 'tb:77' });
    }
  },
  10_000,
);

it.each([
  ['00:00:00.000', bj('2031-02-09', '00:00:00.000'), bj('2031-02-09', '00:00:00.000')],
  ['01:00:00.000', bj('2031-02-09', '01:00:00.000'), bj('2031-02-09', '01:00:00.000')],
  ['07:59:59.999', bj('2031-02-09', '07:59:59.999'), bj('2031-02-09', '07:59:59.999')],
  [
    '跨窗口起点（01-20 起到 02-09 00:30）',
    bj('2031-01-20', '10:00:00.000'),
    bj('2031-02-09', '00:30:00.000'),
  ],
] as const)(
  '[AC-B1-29a#37] 窗口首日 02-09 %s +08:00 的观测经按窗口过滤的 store 仍被读到：today = 03-10，与 03-09 一起出两个点',
  async (_label, first, last) => {
    const rows = [
      row('detail', 210n, first, last),
      row('detail', 190n, bj('2031-03-09', '10:00:00.000')),
    ];
    const { opts } = optionsAt(bj('2031-03-10', '12:00:00.000'), rows);
    expect(await getPriceTrend(opts, QUERY)).toEqual({
      status: 'ok',
      points: [
        { date: '2031-02-09', final_price_fen: 210n },
        { date: '2031-03-09', final_price_fen: 190n },
      ],
      start_date: '2031-02-09',
      window_days: 30,
      source_key: 'price_trend.source.general',
      mode_price_fen: 190n,
    });
  },
  10_000,
);

it('[AC-B1-29a#38] 窗口首日前一刻 02-08 23:59:59.999 +08:00 的单次观测不计；now 本刻的观测计入（until 不能截掉 now）', async () => {
  const now = bj('2031-03-10', '12:00:00.000');
  const before = optionsAt(now, [
    row('detail', 210n, bj('2031-02-08', '23:59:59.999')),
    row('detail', 190n, bj('2031-03-09', '10:00:00.000')),
  ]);
  expect(await getPriceTrend(before.opts, QUERY)).toEqual(NO_DATA);
  const atNow = optionsAt(now, [
    row('detail', 190n, bj('2031-03-09', '10:00:00.000')),
    row('detail', 180n, now),
  ]);
  expect(await getPriceTrend(atNow.opts, QUERY)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 190n },
      { date: '2031-03-10', final_price_fen: 180n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 180n,
  });
}, 10_000);

/**
 * Property runs: the same filtering store as windowStore, but plain functions that record the
 * queries in an array, no vi.fn per run (vitest's mock registry would keep every spy and its calls).
 */
function plainOptionsAt(now: Date, rows: readonly PriceTrendRow[], minDays: unknown) {
  const queries: PriceTrendRowsQuery[] = [];
  const store: PriceTrendStore = {
    keyStability: async () => 'stable_7d',
    rows: async (query: PriceTrendRowsQuery) => {
      queries.push(query);
      return rows.filter(
        (r) =>
          r.firstObservedAt.getTime() < query.until.getTime() &&
          r.lastObservedAt.getTime() >= query.from.getTime(),
      );
    },
  };
  return { queries, opts: { store, clock: new FixedClock(now), config: plainConfig(minDays) } };
}

it('[AC-B1-29a#39] 属性（跨日、游程行跨越窗口起点）：store 只返回与 [from, until) 相交的行时，任意 now（偏向 +08:00 零点两侧）与任意行下结果仍与独立模型一致，且 from 不晚于窗口首日 00:00 +08:00', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      nowArb.chain((nowMs) => fc.tuple(fc.constant(nowMs), rowsArb(nowMs))),
      fc.integer({ min: 1, max: 3 }),
      async ([nowMs, rows], minDays) => {
        const { queries, opts } = plainOptionsAt(new Date(nowMs), rows, minDays);
        const result = await getPriceTrend(opts, QUERY);
        expect(result).toEqual(modelTrend(rows, nowMs, minDays));
        const windowStart = dayStartMs(shiftDay(dateOfMs(nowMs), -29));
        for (const query of queries) {
          expect(query.from.getTime()).toBeLessThanOrEqual(windowStart);
          expect(query.until.getTime()).toBeGreaterThan(nowMs);
        }
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
