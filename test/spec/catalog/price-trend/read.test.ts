// B1-29a: getPriceTrend over a fake store, a FixedClock and a fake CatalogConfigReader (BR-PROD-03
// stable_7d; 05 验收句: 未达 stable_7d、返回里没有任何用户标识 (10 AC-S1-141); orchestrator rulings
// B.5, B.6, B.9-B.11). No database: the Kysely store is covered by read.int.test.ts.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  getPriceTrend,
  type PriceTrendQuery,
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
  row,
  rowsArb,
} from './kit.ts';

const NOW = bj('2031-03-10', '12:00:00.000');
const QUERY: PriceTrendQuery = { appId: 'pt-app', platform: 'taobao', productKey: 'tb:123' };

const ONE_DAY = [row('detail', 100n, bj('2031-03-09', '10:00:00.000'))];
const TWO_DAYS = [...ONE_DAY, row('detail', 90n, bj('2031-03-10', '08:00:00.000'))];
const THREE_DAYS = [row('detail', 110n, bj('2031-03-08', '10:00:00.000')), ...TWO_DAYS];

const TWO_DAYS_OK = {
  status: 'ok',
  points: [
    { date: '2031-03-09', final_price_fen: 100n },
    { date: '2031-03-10', final_price_fen: 90n },
  ],
  start_date: '2031-03-09',
  window_days: 30,
  source_key: 'price_trend.source.general',
  mode_price_fen: 90n,
};

function options(
  stability: Parameters<typeof fakeStore>[0],
  rows: Parameters<typeof fakeStore>[1],
  config = minDaysConfig(undefined),
  now: Date = NOW,
) {
  const fake = fakeStore(stability, rows);
  return { fake, config, opts: { store: fake.store, clock: new FixedClock(now), config } };
}

/** Property runs: plain functions, no vi.fn per run (vitest's mock registry would keep them all). */
function plainOptions(
  stability: Parameters<typeof plainStore>[0],
  rows: Parameters<typeof plainStore>[1],
  minDays: unknown,
  now: Date,
) {
  return {
    opts: {
      store: plainStore(stability, rows),
      clock: new FixedClock(now),
      config: plainConfig(minDays),
    },
  };
}

it('[AC-B1-29a#22] stable_7d：按 (appId, platform, productKey) 读行并计算；平台按 query.platform 查 key_stability', async () => {
  const { fake, opts } = options('stable_7d', TWO_DAYS);
  expect(await getPriceTrend(opts, QUERY)).toEqual(TWO_DAYS_OK);
  expect(fake.keyStability).toHaveBeenCalledWith('taobao');
  expect(fake.readRows).toHaveBeenCalled();
  for (const [query] of fake.readRows.mock.calls) {
    expect(query).toMatchObject({ appId: 'pt-app', platform: 'taobao', productKey: 'tb:123' });
  }
}, 10_000);

it.each([['unverified'], ['stable_24h'], ['unstable'], [null]] as const)(
  '[AC-B1-29a#23] 平台 key_stability = %s（未达 stable_7d 或无此平台）→ no_data，即使行足够',
  async (stability) => {
    const { opts } = options(stability, THREE_DAYS);
    expect(await getPriceTrend(opts, QUERY)).toEqual(NO_DATA);
  },
  10_000,
);

it('[AC-B1-29a#24] 属性（未达 stable_7d）：任意 key_stability 与任意行，非 stable_7d 一律 no_data，stable_7d 与独立模型（默认 min = 2）一致', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      nowArb.chain((nowMs) => fc.tuple(fc.constant(nowMs), rowsArb(nowMs))),
      fc.constantFrom('unverified', 'stable_24h', 'stable_7d', 'unstable', null),
      async ([nowMs, rows], stability) => {
        const { opts } = plainOptions(stability, rows, undefined, new Date(nowMs));
        const result = await getPriceTrend(opts, QUERY);
        expect(result).toEqual(stability === 'stable_7d' ? modelTrend(rows, nowMs, 2) : NO_DATA);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-29a#25] price_trend.min_distinct_days 按 appId 经 CatalogConfigReader 读；没有配置 → 默认 2（1 天 no_data、2 天 ok）', async () => {
  const one = options('stable_7d', ONE_DAY);
  expect(await getPriceTrend(one.opts, QUERY)).toEqual(NO_DATA);
  const two = options('stable_7d', TWO_DAYS);
  expect(await getPriceTrend(two.opts, QUERY)).toEqual(TWO_DAYS_OK);
  expect(two.config.configValue).toHaveBeenCalledWith('pt-app', MIN_DAYS_KEY);
}, 10_000);

it('[AC-B1-29a#26] 非默认值：min_distinct_days = 3 → 2 天 no_data、3 天 ok；= 1 → 1 天 ok', async () => {
  expect(await getPriceTrend(options('stable_7d', TWO_DAYS, minDaysConfig(3)).opts, QUERY)).toEqual(
    NO_DATA,
  );
  expect(
    await getPriceTrend(options('stable_7d', THREE_DAYS, minDaysConfig(3)).opts, QUERY),
  ).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-08', final_price_fen: 110n },
      { date: '2031-03-09', final_price_fen: 100n },
      { date: '2031-03-10', final_price_fen: 90n },
    ],
    start_date: '2031-03-08',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 90n,
  });
  expect(await getPriceTrend(options('stable_7d', ONE_DAY, minDaysConfig(1)).opts, QUERY)).toEqual({
    status: 'ok',
    points: [{ date: '2031-03-09', final_price_fen: 100n }],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 100n,
  });
}, 10_000);

it.each([
  ['0', 0],
  ['-1', -1],
  ['1.5', 1.5],
  ['对象 {days: 1}', { days: 1 }],
] as const)(
  '[AC-B1-29a#27] min_distinct_days 非正整数（%s）→ 按 2：1 天 no_data、2 天 ok',
  async (_label, value) => {
    expect(
      await getPriceTrend(options('stable_7d', ONE_DAY, minDaysConfig(value)).opts, QUERY),
    ).toEqual(NO_DATA);
    expect(
      await getPriceTrend(options('stable_7d', TWO_DAYS, minDaysConfig(value)).opts, QUERY),
    ).toEqual(TWO_DAYS_OK);
  },
  10_000,
);

it('[AC-B1-29a#28] 读配置失败 → 按 2，不抛错：1 天 no_data、2 天 ok', async () => {
  expect(
    await getPriceTrend(options('stable_7d', ONE_DAY, minDaysConfig(undefined, true)).opts, QUERY),
  ).toEqual(NO_DATA);
  expect(
    await getPriceTrend(options('stable_7d', TWO_DAYS, minDaysConfig(undefined, true)).opts, QUERY),
  ).toEqual(TWO_DAYS_OK);
}, 10_000);

it('[AC-B1-29a#29] 时间只读注入的 Clock：同一批行，Clock 在 03-11 00:00:00.000 与 03-10 23:59:59.999 +08:00 两侧，窗口不同', async () => {
  const rows = [
    row('detail', 200n, bj('2031-02-09', '00:00:00.000')),
    row('detail', 300n, bj('2031-03-09', '23:59:59.999')),
    row('detail', 400n, bj('2031-03-10', '00:00:00.000')),
  ];
  const before = options('stable_7d', rows, minDaysConfig(3), bj('2031-03-10', '23:59:59.999'));
  expect(await getPriceTrend(before.opts, QUERY)).toEqual({
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
  const after = options('stable_7d', rows, minDaysConfig(3), bj('2031-03-11', '00:00:00.000'));
  expect(await getPriceTrend(after.opts, QUERY)).toEqual(NO_DATA);
}, 10_000);

it('[AC-B1-29a#30] 返回里没有任何用户标识（10 AC-S1-141）：只有五个字段、点只有 date 与 final_price_fen；调用方夹带的用户 / 设备标识不进结果，也不进读行查询', async () => {
  const { fake, opts } = options('stable_7d', [
    row('detail', 100n, bj('2031-03-09'), bj('2031-03-09'), 30n),
    row('search', 90n, bj('2031-03-10', '08:00:00.000'), bj('2031-03-10', '08:00:00.000'), 30n),
  ]);
  const smuggled = {
    ...QUERY,
    userId: 'user-marker-7781',
    deviceId: 'device-marker-5521',
    relationId: 'relation-marker-3302',
  } as PriceTrendQuery;
  const result = await getPriceTrend(opts, smuggled);
  expect(Object.keys(result).sort()).toEqual([
    'mode_price_fen',
    'points',
    'source_key',
    'start_date',
    'status',
    'window_days',
  ]);
  for (const point of result.points) {
    expect(Object.keys(point).sort()).toEqual(['date', 'final_price_fen']);
  }
  const text = JSON.stringify(result, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  const queries = JSON.stringify(fake.readRows.mock.calls);
  for (const marker of ['user-marker-7781', 'device-marker-5521', 'relation-marker-3302']) {
    expect(text).not.toContain(marker);
    expect(queries).not.toContain(marker);
  }
  expect(result).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 100n },
      { date: '2031-03-10', final_price_fen: 90n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source',
    mode_price_fen: 90n,
  });
}, 10_000);

it('[AC-B1-29a#31] 属性（无用户标识）：任意行与 now 下，结果键集合恒为五个字段，点键恒为 date、final_price_fen，金额是 bigint', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      nowArb.chain((nowMs) => fc.tuple(fc.constant(nowMs), rowsArb(nowMs))),
      fc.integer({ min: 1, max: 3 }),
      async ([nowMs, rows], minDays) => {
        const { opts } = plainOptions('stable_7d', rows, minDays, new Date(nowMs));
        const result = await getPriceTrend(opts, QUERY);
        expect(Object.keys(result).sort()).toEqual([
          'mode_price_fen',
          'points',
          'source_key',
          'start_date',
          'status',
          'window_days',
        ]);
        for (const point of result.points) {
          expect(Object.keys(point).sort()).toEqual(['date', 'final_price_fen']);
          expect(typeof point.final_price_fen).toBe('bigint');
          expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        expect(result).toEqual(modelTrend(rows, nowMs, minDays));
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
