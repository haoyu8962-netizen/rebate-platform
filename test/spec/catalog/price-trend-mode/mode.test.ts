// B1-29c: computePriceTrend's mode_price_fen, deterministic cases (BR-WATCH-19 细则「商品详情价格
// 走势的最常见价」: the daily prices of the trend, i.e. the last final price of each of the last
// 30 natural days +08:00 with B1-29a's same-day source order; the price seen on the most days,
// exact fen; a tie goes to the price seen most recently; null when the trend is no_data). Pure
// function, no database. Expected values are literals worked out by hand from the rule.
import { expect, it } from 'vitest';
import { computePriceTrend } from '../../../../apps/api/src/modules/catalog/index.ts';
import { NO_DATA, bj, row } from '../price-trend/kit.ts';
import { dailyPoints, dailyRows } from './kit.ts';

const NOW = bj('2031-03-10', '12:00:00.000');
const TODAY = '2031-03-10';

it('[AC-S1-141][AC-B1-29c#1] 例：最近 5 天当天最后价 4990、4990、4790、4678、4678 → 4990 与 4678 都出现 2 天，并列取最近出现的 4678', () => {
  const prices = [4990n, 4990n, 4790n, 4678n, 4678n];
  expect(computePriceTrend(dailyRows(TODAY, prices), NOW, 2)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, prices),
    start_date: '2031-03-06',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 4678n,
  });
}, 10_000);

it('[AC-B1-29c#2] 按分精确比较：4989 两天、4990 / 4991 / 4992 各一天 → 4989（不按角或元合并）；2^53+1 两天、2^53 一天（最近）→ 2^53+1（不经浮点）', () => {
  const near = [4989n, 4989n, 4990n, 4991n, 4992n];
  expect(computePriceTrend(dailyRows(TODAY, near), NOW, 2)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, near),
    start_date: '2031-03-06',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 4989n,
  });
  const big = [9007199254740993n, 9007199254740993n, 9007199254740992n];
  const result = computePriceTrend(dailyRows(TODAY, big), NOW, 2);
  expect(result.mode_price_fen).toBe(9007199254740993n);
  expect(typeof result.mode_price_fen).toBe('bigint');
}, 10_000);

it('[AC-B1-29c#3] 三方并列：300、200、100、300、100、200 各出现 2 天 → 取最近一天出现的 200', () => {
  const prices = [300n, 200n, 100n, 300n, 100n, 200n];
  expect(computePriceTrend(dailyRows(TODAY, prices), NOW, 2)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, prices),
    start_date: '2031-03-05',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 200n,
  });
}, 10_000);

it('[AC-B1-29c#4] 并列者的最近一天不在最后一天：500、400、500、400、300 → 500 与 400 各 2 天，400 最近出现在倒数第 2 天 → 400（不是最后一天的 300，也不是先出现的 500）', () => {
  const prices = [500n, 400n, 500n, 400n, 300n];
  expect(computePriceTrend(dailyRows(TODAY, prices), NOW, 2)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, prices),
    start_date: '2031-03-06',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 400n,
  });
}, 10_000);

it('[AC-B1-29c#5] 并列看的是各价最后一次出现的日子而不是第一次：600、700、700、600、800、900 → 600 与 700 各 2 天，600 最后出现在第 4 天、700 在第 3 天 → 600', () => {
  const prices = [600n, 700n, 700n, 600n, 800n, 900n];
  expect(computePriceTrend(dailyRows(TODAY, prices), NOW, 2)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, prices),
    start_date: '2031-03-05',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 600n,
  });
}, 10_000);

it('[AC-B1-29c#6] 天数多者优先于最近：700 三天、最后一天 600 → 700', () => {
  const prices = [700n, 700n, 700n, 600n];
  expect(computePriceTrend(dailyRows(TODAY, prices), NOW, 2)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, prices),
    start_date: '2031-03-07',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 700n,
  });
}, 10_000);

it('[AC-B1-29c#7] 按天计数：一条游程行 800 覆盖 03-01..03-04 记 4 天；750 只在 03-06、03-08、03-10 记 3 天，空档日不延续 → 800', () => {
  const rows = [
    row('detail', 800n, bj('2031-03-01', '10:00:00.000'), bj('2031-03-04', '10:00:00.000')),
    row('detail', 750n, bj('2031-03-06', '10:00:00.000')),
    row('detail', 750n, bj('2031-03-08', '10:00:00.000')),
    row('detail', 750n, bj('2031-03-10', '10:00:00.000')),
  ];
  expect(computePriceTrend(rows, NOW, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-01', final_price_fen: 800n },
      { date: '2031-03-02', final_price_fen: 800n },
      { date: '2031-03-03', final_price_fen: 800n },
      { date: '2031-03-04', final_price_fen: 800n },
      { date: '2031-03-06', final_price_fen: 750n },
      { date: '2031-03-08', final_price_fen: 750n },
      { date: '2031-03-10', final_price_fen: 750n },
    ],
    start_date: '2031-03-01',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 800n,
  });
}, 10_000);

it('[AC-B1-29c#8] 只数每天当天最后一次的价：03-08、03-09 各有 900（早）与 850（晚），03-10 只有 900 → 每日价 850、850、900 → 850（不是记录条数最多的 900）', () => {
  const rows = [
    row('detail', 900n, bj('2031-03-08', '08:00:00.000')),
    row('detail', 850n, bj('2031-03-08', '20:00:00.000')),
    row('detail', 900n, bj('2031-03-09', '09:00:00.000')),
    row('detail', 850n, bj('2031-03-09', '21:00:00.000')),
    row('detail', 900n, bj('2031-03-10', '10:00:00.000')),
  ];
  expect(computePriceTrend(rows, NOW, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 850n },
      { date: '2031-03-09', final_price_fen: 850n },
      { date: '2031-03-10', final_price_fen: 900n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 850n,
  });
}, 10_000);

it('[AC-B1-29c#9] 同日多来源沿用走势口径：03-08、03-09 detail 100 压过更晚的 search 90，03-10 只有 search 90 → 每日价 100、100、90 → 100', () => {
  const rows = [
    row('detail', 100n, bj('2031-03-08', '08:00:00.000')),
    row('search', 90n, bj('2031-03-08', '22:00:00.000')),
    row('detail', 100n, bj('2031-03-09', '08:00:00.000')),
    row('search', 90n, bj('2031-03-09', '22:00:00.000')),
    row('search', 90n, bj('2031-03-10', '10:00:00.000')),
  ];
  expect(computePriceTrend(rows, NOW, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 100n },
      { date: '2031-03-09', final_price_fen: 100n },
      { date: '2031-03-10', final_price_fen: 90n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 100n,
  });
}, 10_000);

it('[AC-B1-29c#10] 只是统计每日价：窗外的行、跨窗口起点游程行在窗外的日子、convert / watch 的行都不计 → 60（02-09 一天）、70（两天）、80（一天）→ 70', () => {
  const rows = [
    // Crosses the window start (02-09): counts on 02-09 only, not on its 39 earlier days.
    row('search', 60n, bj('2031-01-01', '10:00:00.000'), bj('2031-02-09', '00:30:00.000')),
    // Wholly before the window.
    row('detail', 80n, bj('2031-01-20', '10:00:00.000'), bj('2031-02-08', '23:59:59.999')),
    row('detail', 70n, bj('2031-03-07', '10:00:00.000')),
    row('detail', 70n, bj('2031-03-08', '10:00:00.000')),
    row('detail', 80n, bj('2031-03-09', '10:00:00.000')),
    row('convert', 80n, bj('2031-03-07', '11:00:00.000')),
    row('convert', 80n, bj('2031-03-08', '11:00:00.000')),
    row('convert', 80n, bj('2031-03-10', '11:00:00.000')),
    row('watch', 80n, bj('2031-03-07', '11:30:00.000')),
    row('watch', 80n, bj('2031-03-08', '11:30:00.000')),
    row('watch', 80n, bj('2031-03-10', '11:30:00.000')),
  ];
  expect(computePriceTrend(rows, NOW, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-02-09', final_price_fen: 60n },
      { date: '2031-03-07', final_price_fen: 70n },
      { date: '2031-03-08', final_price_fen: 70n },
      { date: '2031-03-09', final_price_fen: 80n },
    ],
    start_date: '2031-02-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 70n,
  });
}, 10_000);

it('[AC-B1-29c#11] 按券后价 final_price_fen 计：500（有券）、500（无券）、450 → 500 两天 → 500；券额不同不拆成两个价', () => {
  const rows = [
    row('detail', 500n, bj('2031-03-08', '10:00:00.000'), bj('2031-03-08', '10:00:00.000'), 100n),
    row('detail', 500n, bj('2031-03-09', '10:00:00.000'), bj('2031-03-09', '10:00:00.000'), 0n),
    row('detail', 450n, bj('2031-03-10', '10:00:00.000'), bj('2031-03-10', '10:00:00.000'), 0n),
  ];
  expect(computePriceTrend(rows, NOW, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 500n },
      { date: '2031-03-09', final_price_fen: 500n },
      { date: '2031-03-10', final_price_fen: 450n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 500n,
  });
}, 10_000);

it('[AC-B1-29c#12] 跨 +08:00 零点的游程行在两天都算：[03-08 23:59:59.999, 03-09 00:00:00.000] 的 700 两天，03-10 的 710 一天 → 700', () => {
  const rows = [
    row('detail', 700n, bj('2031-03-08', '23:59:59.999'), bj('2031-03-09', '00:00:00.000')),
    row('detail', 710n, bj('2031-03-10', '10:00:00.000')),
  ];
  expect(computePriceTrend(rows, NOW, 2)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 700n },
      { date: '2031-03-09', final_price_fen: 700n },
      { date: '2031-03-10', final_price_fen: 710n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 700n,
  });
}, 10_000);

it('[AC-B1-29c#13] 0 分也是一个价：0、0、5 → 0；5、0 并列 → 最近的 0（不是 null）', () => {
  const zeros = [0n, 0n, 5n];
  expect(computePriceTrend(dailyRows(TODAY, zeros), NOW, 2)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, zeros),
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 0n,
  });
  expect(computePriceTrend(dailyRows(TODAY, [5n, 0n]), NOW, 2).mode_price_fen).toBe(0n);
}, 10_000);

it('[AC-B1-29c#14] no_data 时为 null：只有 1 天记录（min = 2）、没有行、全在窗外、只有 convert / watch → 与 NO_DATA 相等且 mode_price_fen 为 null', () => {
  const oneDay = [
    row('detail', 100n, bj('2031-03-09', '08:00:00.000')),
    row('search', 100n, bj('2031-03-09', '20:00:00.000')),
  ];
  const outside = [row('detail', 100n, bj('2031-01-01'), bj('2031-02-08', '23:59:59.999'))];
  const sideOnly = [
    row('convert', 100n, bj('2031-03-08')),
    row('convert', 100n, bj('2031-03-09')),
    row('watch', 100n, bj('2031-03-08', '13:00:00.000')),
    row('watch', 100n, bj('2031-03-09', '13:00:00.000')),
  ];
  for (const rows of [oneDay, [], outside, sideOnly]) {
    const result = computePriceTrend(rows, NOW, 2);
    expect(result).toEqual(NO_DATA);
    expect(result.mode_price_fen).toBeNull();
  }
}, 10_000);

it('[AC-B1-29c#15] 显示门槛与走势共用：min = 3 时 2 天 → no_data、null；刚好 3 天 → ok 且有值；min = 1 时 1 天 → ok、取这一天的价', () => {
  const twoDays = dailyRows(TODAY, [120n, 110n]);
  const twoResult = computePriceTrend(twoDays, NOW, 3);
  expect(twoResult).toEqual(NO_DATA);
  expect(twoResult.mode_price_fen).toBeNull();
  const three = [120n, 110n, 120n];
  expect(computePriceTrend(dailyRows(TODAY, three), NOW, 3)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, three),
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 120n,
  });
  expect(computePriceTrend(dailyRows(TODAY, [555n]), NOW, 1)).toEqual({
    status: 'ok',
    points: [{ date: TODAY, final_price_fen: 555n }],
    start_date: TODAY,
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 555n,
  });
}, 10_000);
