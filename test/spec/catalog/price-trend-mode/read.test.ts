// B1-29c: getPriceTrend returns mode_price_fen (BR-WATCH-19 细则「商品详情价格走势的最常见价」:
// served with the trend, null when the trend shows 「暂无价格记录」 — fewer distinct days than
// price_trend.min_distinct_days, read per app and shared with the trend, or key_stability not
// stable_7d; only statistics, no new switch; the result gains exactly one field and carries no
// user identifier). Fake store, FixedClock and fake CatalogConfigReader; no database.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  getPriceTrend,
  type PriceTrendQuery,
  type PriceTrendRow,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  MIN_DAYS_KEY,
  NO_DATA,
  bj,
  fakeStore,
  minDaysConfig,
  modelTrend,
  nowArb,
  plainConfig,
  plainStore,
  rowsArb,
} from '../price-trend/kit.ts';
import { dailyPoints, dailyRows, expectedMode } from './kit.ts';

const NOW = bj('2031-03-10', '12:00:00.000');
const TODAY = '2031-03-10';
const QUERY: PriceTrendQuery = { appId: 'ptm-read', platform: 'taobao', productKey: 'tb:4678' };
const AC_PRICES = [4990n, 4990n, 4790n, 4678n, 4678n];

const SIX_KEYS = ['mode_price_fen', 'points', 'source_key', 'start_date', 'status', 'window_days'];

function optionsOf(
  rows: readonly PriceTrendRow[],
  stability: Parameters<typeof fakeStore>[0] = 'stable_7d',
  config = minDaysConfig(undefined),
) {
  const fake = fakeStore(stability, rows);
  return { fake, config, opts: { store: fake.store, clock: new FixedClock(NOW), config } };
}

it('[AC-S1-141][AC-B1-29c#26] stable_7d：getPriceTrend 随走势返回 mode_price_fen（例 4990、4990、4790、4678、4678 → 4678）；结果只比 B1-29a 多这一个字段，没有用户标识', async () => {
  const { fake, opts } = optionsOf(dailyRows(TODAY, AC_PRICES, 'detail', 30n));
  const smuggled = {
    ...QUERY,
    userId: 'user-marker-1141',
    deviceId: 'device-marker-1141',
    relationId: 'relation-marker-1141',
  } as PriceTrendQuery;
  const result = await getPriceTrend(opts, smuggled);
  expect(result).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, AC_PRICES),
    start_date: '2031-03-06',
    window_days: 30,
    source_key: 'price_trend.source',
    mode_price_fen: 4678n,
  });
  expect(Object.keys(result).sort()).toEqual(SIX_KEYS);
  expect(typeof result.mode_price_fen).toBe('bigint');
  const text = JSON.stringify(result, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  const queries = JSON.stringify(fake.readRows.mock.calls);
  for (const marker of ['user-marker-1141', 'device-marker-1141', 'relation-marker-1141']) {
    expect(text).not.toContain(marker);
    expect(queries).not.toContain(marker);
  }
}, 10_000);

it.each([['unverified'], ['stable_24h'], ['unstable'], [null]] as const)(
  '[AC-B1-29c#27] key_stability = %s（未达 stable_7d）→ no_data、mode_price_fen null，即使每日价足够',
  async (stability) => {
    const { opts } = optionsOf(dailyRows(TODAY, AC_PRICES), stability);
    const result = await getPriceTrend(opts, QUERY);
    expect(result.mode_price_fen).toBeNull();
    expect(result).toEqual(NO_DATA);
    expect(Object.keys(result).sort()).toEqual(SIX_KEYS);
  },
  10_000,
);

it('[AC-B1-29c#28] 门槛与走势共用 price_trend.min_distinct_days（按 app 读，默认 2）：1 天 → null；刚好 2 天 → ok 且有值', async () => {
  const one = optionsOf(dailyRows(TODAY, [700n]));
  const oneResult = await getPriceTrend(one.opts, QUERY);
  expect(oneResult.mode_price_fen).toBeNull();
  expect(oneResult).toEqual(NO_DATA);
  const two = optionsOf(dailyRows(TODAY, [700n, 650n]));
  expect(await getPriceTrend(two.opts, QUERY)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, [700n, 650n]),
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 650n,
  });
  expect(two.config.configValue).toHaveBeenCalledWith('ptm-read', MIN_DAYS_KEY);
}, 10_000);

it('[AC-B1-29c#29] 非默认门槛：min_distinct_days = 4 → 3 天 null；刚好 4 天 → ok 且为最常见价；= 1 → 1 天即有值', async () => {
  const three = optionsOf(dailyRows(TODAY, [300n, 300n, 200n]), 'stable_7d', minDaysConfig(4));
  const threeResult = await getPriceTrend(three.opts, QUERY);
  expect(threeResult.mode_price_fen).toBeNull();
  expect(threeResult).toEqual(NO_DATA);
  const fourPrices = [300n, 300n, 200n, 200n];
  const four = optionsOf(dailyRows(TODAY, fourPrices), 'stable_7d', minDaysConfig(4));
  expect(await getPriceTrend(four.opts, QUERY)).toEqual({
    status: 'ok',
    points: dailyPoints(TODAY, fourPrices),
    start_date: '2031-03-07',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 200n,
  });
  const single = optionsOf(dailyRows(TODAY, [321n]), 'stable_7d', minDaysConfig(1));
  expect((await getPriceTrend(single.opts, QUERY)).mode_price_fen).toBe(321n);
}, 10_000);

it('[AC-B1-29c#30] 不新增开关：读配置只读 price_trend.min_distinct_days 一个键（按本 app），有值与无值时都如此', async () => {
  for (const prices of [[800n], [800n, 800n, 790n]]) {
    const { config, opts } = optionsOf(dailyRows(TODAY, prices));
    const result = await getPriceTrend(opts, QUERY);
    expect(result.mode_price_fen).toBe(prices.length >= 2 ? 800n : null);
    expect(config.configValue).toHaveBeenCalled();
    for (const [appId, key] of config.configValue.mock.calls) {
      expect(appId).toBe('ptm-read');
      expect(key).toBe(MIN_DAYS_KEY);
    }
  }
}, 10_000);

it('[AC-B1-29c#31] 属性：任意行、now 与门槛下，结果键恒为六个字段；ok 时 mode_price_fen 是按每日价算出的 bigint，no_data 时为 null；整体与独立模型一致', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      nowArb.chain((nowMs) => fc.tuple(fc.constant(nowMs), rowsArb(nowMs))),
      fc.integer({ min: 1, max: 3 }),
      async ([nowMs, rows], minDays) => {
        const opts = {
          store: plainStore('stable_7d', rows),
          clock: new FixedClock(new Date(nowMs)),
          config: plainConfig(minDays),
        };
        const result = await getPriceTrend(opts, QUERY);
        expect(Object.keys(result).sort()).toEqual(SIX_KEYS);
        if (result.status === 'ok') {
          expect(typeof result.mode_price_fen).toBe('bigint');
          expect(result.mode_price_fen).toBe(
            expectedMode(result.points.map((p) => p.final_price_fen)),
          );
        } else {
          expect(result.mode_price_fen).toBeNull();
        }
        expect(result).toEqual(modelTrend(rows, nowMs, minDays));
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
