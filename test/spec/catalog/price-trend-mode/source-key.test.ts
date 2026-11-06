// B1-29c: source_key by platform and coupon (CT-22e; 08 BR-TEXT-14 表 C「价格走势·拼多多」:
// Pinduoduo products use price_trend.source.pdd / .pdd.general in place of price_trend.source /
// .general; the coupon of the row behind the last point decides, as in B1-29a). Read through
// getPriceTrend, which knows query.platform. The no_data source_key of a Pinduoduo product is not
// fixed by 08 or the contract (the empty state shows price_trend.empty), so it is not asserted.
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
  bj,
  fakeStore,
  minDaysConfig,
  nowArb,
  plainConfig,
  plainStore,
  row,
  rowsArb,
} from '../price-trend/kit.ts';
import {
  PLATFORMS,
  SOURCE,
  SOURCE_GENERAL,
  SOURCE_PDD,
  SOURCE_PDD_GENERAL,
  modelTrendFor,
} from './kit.ts';

const NOW = bj('2031-03-10', '12:00:00.000');
const YESTERDAY = bj('2031-03-09', '12:00:00.000');
const TODAY_AM = bj('2031-03-10', '10:00:00.000');
const PDD: PriceTrendQuery = { appId: 'ptm-app', platform: 'pdd', productKey: 'pdd:501' };

function optionsOf(
  rows: readonly PriceTrendRow[],
  stability: Parameters<typeof fakeStore>[0] = 'stable_7d',
  minDays: unknown = undefined,
) {
  const fake = fakeStore(stability, rows);
  return {
    fake,
    opts: { store: fake.store, clock: new FixedClock(NOW), config: minDaysConfig(minDays) },
  };
}

/** Every field but source_key (for Pinduoduo no_data, whose source_key is not fixed). */
function withoutSourceKey(trend: {
  status: unknown;
  points: unknown;
  start_date: unknown;
  window_days: unknown;
  mode_price_fen?: unknown;
}) {
  return {
    status: trend.status,
    points: trend.points,
    start_date: trend.start_date,
    window_days: trend.window_days,
    mode_price_fen: trend.mode_price_fen,
  };
}

it('[AC-B1-29c#20] 拼多多商品末点有券 → price_trend.source.pdd（前一点无券不算）', async () => {
  const { fake, opts } = optionsOf([
    row('detail', 1990n, YESTERDAY, YESTERDAY, 0n),
    row('detail', 1890n, TODAY_AM, TODAY_AM, 100n),
  ]);
  expect(await getPriceTrend(opts, PDD)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 1990n },
      { date: '2031-03-10', final_price_fen: 1890n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: SOURCE_PDD,
    mode_price_fen: 1890n,
  });
  expect(fake.keyStability).toHaveBeenCalledWith('pdd');
}, 10_000);

it('[AC-B1-29c#21] 拼多多商品末点无券 → price_trend.source.pdd.general（前一点有券不算）', async () => {
  const { opts } = optionsOf([
    row('detail', 1890n, YESTERDAY, YESTERDAY, 100n),
    row('detail', 1990n, TODAY_AM, TODAY_AM, 0n),
  ]);
  expect(await getPriceTrend(opts, PDD)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 1890n },
      { date: '2031-03-10', final_price_fen: 1990n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: SOURCE_PDD_GENERAL,
    mode_price_fen: 1990n,
  });
}, 10_000);

it('[AC-B1-29c#22] 拼多多：有券跟随末日实际选中的行——detail 无券压过更晚的有券 search → .pdd.general；末日只有有券 search → .pdd', async () => {
  const base = row('detail', 1000n, YESTERDAY, YESTERDAY, 0n);
  const morning = bj('2031-03-10', '08:00:00.000');
  const late = bj('2031-03-10', '11:00:00.000');
  const detailWins = optionsOf([
    base,
    row('detail', 900n, morning, morning, 0n),
    row('search', 800n, late, late, 200n),
  ]);
  expect(await getPriceTrend(detailWins.opts, PDD)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 1000n },
      { date: '2031-03-10', final_price_fen: 900n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: SOURCE_PDD_GENERAL,
    mode_price_fen: 900n,
  });
  const searchOnly = optionsOf([base, row('search', 800n, late, late, 200n)]);
  expect(await getPriceTrend(searchOnly.opts, PDD)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-09', final_price_fen: 1000n },
      { date: '2031-03-10', final_price_fen: 800n },
    ],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: SOURCE_PDD,
    mode_price_fen: 800n,
  });
}, 10_000);

const OTHER_CASES: [string, bigint][] = PLATFORMS.filter((platform) => platform !== 'pdd').flatMap(
  (platform): [string, bigint][] => [
    [platform, 100n],
    [platform, 0n],
  ],
);

it.each(OTHER_CASES)(
  '[AC-B1-29c#23] 其他平台（%s，末点券 %s 分）照旧：有券 price_trend.source、无券 price_trend.source.general',
  async (platform, coupon) => {
    const { opts } = optionsOf([
      row('detail', 1990n, YESTERDAY, YESTERDAY, 0n),
      row('detail', 1890n, TODAY_AM, TODAY_AM, coupon),
    ]);
    const query = { appId: 'ptm-app', platform, productKey: `${platform}:777` };
    expect(await getPriceTrend(opts, query)).toEqual({
      status: 'ok',
      points: [
        { date: '2031-03-09', final_price_fen: 1990n },
        { date: '2031-03-10', final_price_fen: 1890n },
      ],
      start_date: '2031-03-09',
      window_days: 30,
      source_key: coupon > 0n ? SOURCE : SOURCE_GENERAL,
      mode_price_fen: 1890n,
    });
  },
  10_000,
);

it.each([['unverified'], ['stable_24h'], ['unstable'], [null]] as const)(
  '[AC-B1-29c#24] 拼多多 no_data（key_stability = %s，或只有 1 天）→ points 空、start_date null、mode_price_fen null（source_key 口径未定，不断言）',
  async (stability) => {
    const rows = [
      row('detail', 1990n, bj('2031-03-08'), bj('2031-03-08'), 100n),
      row('detail', 1890n, YESTERDAY, YESTERDAY, 100n),
      row('detail', 1790n, TODAY_AM, TODAY_AM, 100n),
    ];
    const unstable = await getPriceTrend(optionsOf(rows, stability).opts, PDD);
    const oneDay = await getPriceTrend(optionsOf(rows.slice(2)).opts, PDD);
    for (const result of [unstable, oneDay]) {
      expect(result.mode_price_fen).toBeNull();
      expect(withoutSourceKey(result)).toEqual({
        status: 'no_data',
        points: [],
        start_date: null,
        window_days: 30,
        mode_price_fen: null,
      });
    }
  },
  10_000,
);

it('[AC-B1-29c#25] 属性：任意平台、任意行与 now → ok 时与独立模型一致（拼多多换 .pdd 两键，其他平台照旧）；no_data 时除拼多多的 source_key 外与模型一致', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      nowArb.chain((nowMs) => fc.tuple(fc.constant(nowMs), rowsArb(nowMs))),
      fc.constantFrom(...PLATFORMS),
      fc.integer({ min: 1, max: 3 }),
      async ([nowMs, rows], platform, minDays) => {
        const opts = {
          store: plainStore('stable_7d', rows),
          clock: new FixedClock(new Date(nowMs)),
          config: plainConfig(minDays),
        };
        const query = { appId: 'ptm-prop', platform, productKey: `${platform}:1` };
        const result = await getPriceTrend(opts, query);
        const model = modelTrendFor(rows, nowMs, minDays, platform);
        if (model.status === 'no_data' && platform === 'pdd') {
          expect(withoutSourceKey(result)).toEqual(withoutSourceKey(model));
          expect(Object.keys(result).sort()).toEqual(Object.keys(model).sort());
        } else {
          expect(result).toEqual(model);
        }
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
