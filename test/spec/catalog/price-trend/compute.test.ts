// B1-29a: computePriceTrend, deterministic cases (BR-WATCH-05 (2) runs; BR-TEXT-11 plain dates in
// +08:00; orchestrator rulings B.1-B.8, B.10). Pure function, no database. Expected values are
// literals worked out by hand from the rulings.
import { expect, it } from 'vitest';
import { computePriceTrend } from '../../../../apps/api/src/modules/catalog/index.ts';
import { NO_DATA, bj, row } from './kit.ts';

const EDGE_ROWS = [
  row('detail', 100n, bj('2031-02-08', '23:59:59.999')),
  row('detail', 200n, bj('2031-02-09', '00:00:00.000')),
  row('detail', 300n, bj('2031-03-09', '23:59:59.999')),
  row('detail', 400n, bj('2031-03-10', '00:00:00.000')),
];

it('[AC-B1-29a#1] 窗口 = [今天−29, 今天]（+08:00）：now = 03-10 00:00:00.000 → 02-08 23:59:59.999 在窗外，02-09 00:00 起算，03-09 23:59:59.999 与 03-10 00:00 分属两天', () => {
  expect(computePriceTrend(EDGE_ROWS, bj('2031-03-10', '00:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-02-09', final_price_fen: 200n },
      { date: '2031-03-09', final_price_fen: 300n },
      { date: '2031-03-10', final_price_fen: 400n },
    ],
    start_date: '2031-02-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 400n,
  });
}, 10_000);

it('[AC-B1-29a#2] now = 03-10 23:59:59.999 +08:00 仍是 03-10，窗口不变', () => {
  expect(computePriceTrend(EDGE_ROWS, bj('2031-03-10', '23:59:59.999'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-02-09', final_price_fen: 200n },
      { date: '2031-03-09', final_price_fen: 300n },
      { date: '2031-03-10', final_price_fen: 400n },
    ],
    start_date: '2031-02-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 400n,
  });
}, 10_000);

it('[AC-B1-29a#3] now = 03-11 00:00:00.000 +08:00 → 窗口 02-10..03-11，02-09 的点移出，start_date 随之变为 03-09', () => {
  expect(computePriceTrend(EDGE_ROWS, bj('2031-03-11', '00:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 300n },
      { date: '2031-03-10', final_price_fen: 400n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 400n,
  });
}, 10_000);

it('[AC-B1-29a#4] 日期按 +08:00 而不是 UTC：03-09 08:00 与 03-10 07:00（UTC 同为 03-09）是两个点；now = 03-10 07:59:59.999 +08:00 的今天是 03-10', () => {
  const rows = [
    row('detail', 510n, bj('2031-03-09', '08:00:00.000')),
    row('detail', 520n, bj('2031-03-10', '07:00:00.000')),
  ];
  expect(computePriceTrend(rows, bj('2031-03-10', '07:59:59.999'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 510n },
      { date: '2031-03-10', final_price_fen: 520n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 520n,
  });
}, 10_000);

it('[AC-B1-29a#5] 跨年与闰月：now = 2032-01-15 00:00 → 起点 2031-12-17；now = 2032-03-01 08:00 → 起点 2032-02-01，含 02-29', () => {
  const yearRows = [
    row('detail', 11n, bj('2031-12-16', '23:59:59.999')),
    row('detail', 12n, bj('2031-12-17', '00:00:00.000')),
    row('detail', 13n, bj('2032-01-15', '00:00:00.000')),
  ];
  expect(computePriceTrend(yearRows, bj('2032-01-15', '00:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-12-17', final_price_fen: 12n },
      { date: '2032-01-15', final_price_fen: 13n },
    ],
    start_date: '2031-12-17',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 13n,
  });
  const leapRows = [
    row('detail', 21n, bj('2032-01-31', '23:59:59.999')),
    row('detail', 22n, bj('2032-02-01', '00:00:00.000')),
    row('detail', 23n, bj('2032-02-29', '12:00:00.000')),
  ];
  expect(computePriceTrend(leapRows, bj('2032-03-01', '08:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2032-02-01', final_price_fen: 22n },
      { date: '2032-02-29', final_price_fen: 23n },
    ],
    start_date: '2032-02-01',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 23n,
  });
}, 10_000);

it('[AC-B1-29a#6] 游程行跨越窗口起点：01-01~02-11 09:00 的 500 在 02-09、02-10 有值，start_date 是窗口内第一天而不是 first_observed_at；空档日不延续；整段在窗外的行不计', () => {
  const rows = [
    row('detail', 500n, bj('2031-01-01', '10:00:00.000'), bj('2031-02-11', '09:00:00.000')),
    row('detail', 450n, bj('2031-02-11', '10:00:00.000')),
    row('detail', 480n, bj('2031-02-14', '08:00:00.000')),
    row('search', 999n, bj('2031-01-05', '10:00:00.000'), bj('2031-02-08', '23:59:59.999')),
  ];
  expect(computePriceTrend(rows, bj('2031-03-10', '12:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-02-09', final_price_fen: 500n },
      { date: '2031-02-10', final_price_fen: 500n },
      { date: '2031-02-11', final_price_fen: 450n },
      { date: '2031-02-14', final_price_fen: 480n },
    ],
    start_date: '2031-02-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 500n,
  });
}, 10_000);

it('[AC-B1-29a#7] 同日多来源：detail 优先于 search、search 优先于 quote，与观测时刻先后无关；convert、watch 不读，只有它们的日子没有点', () => {
  const rows = [
    row('quote', 300n, bj('2031-03-01', '23:00:00.000')),
    row('search', 200n, bj('2031-03-01', '22:00:00.000')),
    row('detail', 100n, bj('2031-03-01', '08:00:00.000')),
    row('convert', 50n, bj('2031-03-01', '23:30:00.000')),
    row('watch', 40n, bj('2031-03-01', '23:59:59.999')),
    row('quote', 301n, bj('2031-03-02', '23:00:00.000')),
    row('search', 210n, bj('2031-03-02', '01:00:00.000')),
    row('quote', 320n, bj('2031-03-03', '12:00:00.000')),
    row('convert', 60n, bj('2031-03-04', '12:00:00.000')),
    row('watch', 70n, bj('2031-03-04', '13:00:00.000')),
  ];
  expect(computePriceTrend(rows, bj('2031-03-10', '12:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-01', final_price_fen: 100n },
      { date: '2031-03-02', final_price_fen: 210n },
      { date: '2031-03-03', final_price_fen: 320n },
    ],
    start_date: '2031-03-01',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 320n,
  });
}, 10_000);

it('[AC-B1-29a#8] 当日最后一次记录：同一来源一天多行取当日内最晚观测时刻 min(last, 当日结束) 最大的行；跨日行在次日仍有值', () => {
  const rows = [
    row('detail', 600n, bj('2031-03-05', '08:00:00.000'), bj('2031-03-05', '09:00:00.000')),
    row('detail', 610n, bj('2031-03-05', '10:00:00.000')),
    row('detail', 620n, bj('2031-03-05', '11:00:00.000'), bj('2031-03-07', '01:00:00.000')),
    row('detail', 630n, bj('2031-03-07', '02:00:00.000')),
  ];
  expect(computePriceTrend(rows, bj('2031-03-10', '12:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-05', final_price_fen: 620n },
      { date: '2031-03-06', final_price_fen: 620n },
      { date: '2031-03-07', final_price_fen: 630n },
    ],
    start_date: '2031-03-05',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 620n,
  });
}, 10_000);

it('[AC-B1-29a#9] 跨 +08:00 零点的游程行：[03-08 23:59:59.999, 03-09 00:00:00.000] 在两天都有值；03-09 00:00:00.001 的新行接管 03-09', () => {
  const rows = [
    row('detail', 700n, bj('2031-03-08', '23:59:59.999'), bj('2031-03-09', '00:00:00.000')),
    row('detail', 710n, bj('2031-03-09', '00:00:00.001')),
  ];
  expect(computePriceTrend(rows, bj('2031-03-10', '12:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 700n },
      { date: '2031-03-09', final_price_fen: 710n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 710n,
  });
  const onlyRun = [row('detail', 700n, bj('2031-03-08', '23:59:59.999'), bj('2031-03-09'))];
  expect(computePriceTrend(onlyRun, bj('2031-03-10', '12:00:00.000'), 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 700n },
      { date: '2031-03-09', final_price_fen: 700n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 700n,
  });
}, 10_000);

it('[AC-B1-29a#10] source_key：最后一个点所用那一行 coupon_fen > 0 → price_trend.source；= 0 → price_trend.source.general（前面的点不算）', () => {
  const now = bj('2031-03-10', '12:00:00.000');
  const couponLast = [
    row('detail', 1000n, bj('2031-03-08'), bj('2031-03-08'), 0n),
    row('detail', 900n, bj('2031-03-09'), bj('2031-03-09'), 100n),
  ];
  expect(computePriceTrend(couponLast, now, 2).source_key).toBe('price_trend.source');
  const couponFirst = [
    row('detail', 900n, bj('2031-03-08'), bj('2031-03-08'), 100n),
    row('detail', 1000n, bj('2031-03-09'), bj('2031-03-09'), 0n),
  ];
  expect(computePriceTrend(couponFirst, now, 2).source_key).toBe('price_trend.source.general');
}, 10_000);

it('[AC-B1-29a#11] source_key 跟随当天实际选中的行：detail 无券压过更晚的有券 search → general；同来源当日后一行无券 → general；只有有券 search → source', () => {
  const now = bj('2031-03-10', '12:00:00.000');
  const base = row('detail', 1000n, bj('2031-03-08'), bj('2031-03-08'), 0n);
  const detailWins = [
    base,
    row('detail', 900n, bj('2031-03-09', '08:00:00.000'), bj('2031-03-09', '08:00:00.000'), 0n),
    row('search', 800n, bj('2031-03-09', '20:00:00.000'), bj('2031-03-09', '20:00:00.000'), 200n),
  ];
  expect(computePriceTrend(detailWins, now, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 1000n },
      { date: '2031-03-09', final_price_fen: 900n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 900n,
  });
  const laterNoCoupon = [
    base,
    row('detail', 900n, bj('2031-03-09', '08:00:00.000'), bj('2031-03-09', '08:00:00.000'), 100n),
    row('detail', 950n, bj('2031-03-09', '20:00:00.000'), bj('2031-03-09', '20:00:00.000'), 0n),
  ];
  expect(computePriceTrend(laterNoCoupon, now, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 1000n },
      { date: '2031-03-09', final_price_fen: 950n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 950n,
  });
  const searchOnly = [
    base,
    row('search', 800n, bj('2031-03-09', '20:00:00.000'), bj('2031-03-09', '20:00:00.000'), 200n),
  ];
  expect(computePriceTrend(searchOnly, now, 2).source_key).toBe('price_trend.source');
}, 10_000);

it('[AC-B1-29a#12] 只有 1 天记录（多来源、多行、有券）且 min_distinct_days = 2 → no_data：points 空、start_date null、source_key general', () => {
  const rows = [
    row('detail', 100n, bj('2031-03-09', '00:00:00.000'), bj('2031-03-09', '08:00:00.000'), 50n),
    row('detail', 90n, bj('2031-03-09', '09:00:00.000'), bj('2031-03-09', '23:59:59.999'), 50n),
    row('search', 80n, bj('2031-03-09', '10:00:00.000'), bj('2031-03-09', '10:00:00.000'), 50n),
    row('quote', 70n, bj('2031-03-09', '11:00:00.000'), bj('2031-03-09', '11:00:00.000'), 50n),
  ];
  expect(computePriceTrend(rows, bj('2031-03-10', '12:00:00.000'), 2)).toEqual(NO_DATA);
}, 10_000);

it('[AC-B1-29a#13] min_distinct_days = 1 → 1 天也是 ok；= 3 → 2 天 no_data、3 天 ok；只有 convert / watch 的日子不算不同日期', () => {
  const now = bj('2031-03-10', '12:00:00.000');
  const one = [row('detail', 90n, bj('2031-03-09', '09:00:00.000'), bj('2031-03-09'), 50n)];
  expect(computePriceTrend(one, now, 1)).toEqual({
    status: 'ok',
    points: [{ date: '2031-03-09', final_price_fen: 90n }],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source',
    mode_price_fen: 90n,
  });
  const two = [
    row('detail', 90n, bj('2031-03-07')),
    row('search', 91n, bj('2031-03-08')),
    row('watch', 92n, bj('2031-03-09')),
    row('convert', 93n, bj('2031-03-10')),
  ];
  expect(computePriceTrend(two, now, 3)).toEqual(NO_DATA);
  const three = [...two, row('quote', 94n, bj('2031-03-10', '01:00:00.000'))];
  expect(computePriceTrend(three, now, 3)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-07', final_price_fen: 90n },
      { date: '2031-03-08', final_price_fen: 91n },
      { date: '2031-03-10', final_price_fen: 94n },
    ],
    start_date: '2031-03-07',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 94n,
  });
}, 10_000);

it('[AC-B1-29a#14] 没有行、或所有行都在窗口外 → no_data', () => {
  const now = bj('2031-03-10', '12:00:00.000');
  expect(computePriceTrend([], now, 2)).toEqual(NO_DATA);
  const outside = [
    row('detail', 100n, bj('2031-01-01'), bj('2031-02-08', '23:59:59.999')),
    row('search', 200n, bj('2031-02-01'), bj('2031-02-08', '12:00:00.000')),
  ];
  expect(computePriceTrend(outside, now, 2)).toEqual(NO_DATA);
}, 10_000);

it('[AC-B1-29a#15] 金额是 bigint 原值：2^53+1、2^31+1、奇数 1 都不经浮点、原样作为 final_price_fen', () => {
  const rows = [
    row('detail', 9007199254740993n, bj('2031-03-07')),
    row('detail', 2147483649n, bj('2031-03-08')),
    row('detail', 1n, bj('2031-03-09')),
  ];
  const result = computePriceTrend(rows, bj('2031-03-10', '12:00:00.000'), 2);
  expect(result.points).toEqual([
    { date: '2031-03-07', final_price_fen: 9007199254740993n },
    { date: '2031-03-08', final_price_fen: 2147483649n },
    { date: '2031-03-09', final_price_fen: 1n },
  ]);
  expect(result.points.map((p) => typeof p.final_price_fen)).toEqual([
    'bigint',
    'bigint',
    'bigint',
  ]);
}, 10_000);
