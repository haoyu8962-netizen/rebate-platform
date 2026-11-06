// B1-29a: getPriceTrend with createKyselyPriceTrendStore on a real PostgreSQL as couli_app
// (BR-WATCH-05 (2) runs read from app.price_snapshot; BR-PROD-03 platforms.key_stability;
// orchestrator rulings B.1-B.11). Tables come from merged migrations (0017 platforms, 0030
// price_snapshot, B1-17a). Every test builds the store before any fixture SQL, so on the skeleton
// it fails with NotImplemented.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createKyselyPriceTrendStore,
  getPriceTrend,
  type PriceSnapshotSourceKind,
  type PriceTrendStore,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { NO_DATA, bj, minDaysConfig } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 60_000);
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
}, 60_000);

const NOW = bj('2031-03-10', '12:00:00.000');

interface Fixture {
  appId: string;
  platform: string;
  productKey: string;
  kind: PriceSnapshotSourceKind;
  fen: bigint;
  coupon?: bigint;
  first: Date;
  last?: Date;
}

/** One price_snapshot run; price_fen = final + coupon keeps the row valid. */
async function insertRun(f: Fixture): Promise<void> {
  const coupon = f.coupon ?? 0n;
  const last = f.last ?? f.first;
  await sql`
    INSERT INTO app.price_snapshot (app_id, platform, product_key, sku_key, source_kind, price_fen,
      coupon_fen, final_price_fen, in_stock, goods_sign_plan, first_observed_at, last_observed_at,
      observation_count)
    VALUES (${f.appId}, ${f.platform}, ${f.productKey}, NULL, ${f.kind},
      ${(f.fen + coupon).toString()}::bigint, ${coupon.toString()}::bigint,
      ${f.fen.toString()}::bigint, true, NULL, ${f.first}, ${last}, 1)
  `.execute(db);
}

async function setStability(platform: string, value: string): Promise<void> {
  await sql`UPDATE app.platforms SET key_stability = ${value} WHERE code = ${platform}`.execute(db);
}

function optionsOf(store: PriceTrendStore, config = minDaysConfig(undefined)) {
  return { store, clock: new FixedClock(NOW), config };
}

it('[AC-B1-29a#32] 连库：只按 (app_id, platform, product_key) 读 price_snapshot；跨窗口起点的游程行（first 在 DEFAULT 分区的旧月份）计入；同日后一行与来源优先生效；窗外行、他 app / 他商品 / 他平台的行不计', async () => {
  const store = createKyselyPriceTrendStore(db);
  await setStability('taobao', 'stable_7d');
  const key = { appId: 'pt-int-a', platform: 'taobao', productKey: 'tb:1' };
  await insertRun({
    ...key,
    kind: 'detail',
    fen: 500n,
    first: bj('2030-12-20', '10:00:00.000'),
    last: bj('2031-02-10', '09:00:00.000'),
  });
  await insertRun({ ...key, kind: 'detail', fen: 450n, first: bj('2031-02-10', '10:00:00.000') });
  await insertRun({ ...key, kind: 'search', fen: 430n, first: bj('2031-02-10', '23:00:00.000') });
  await insertRun({ ...key, kind: 'quote', fen: 420n, first: bj('2031-03-01', '08:00:00.000') });
  await insertRun({
    ...key,
    kind: 'search',
    fen: 410n,
    coupon: 100n,
    first: bj('2031-03-01', '09:00:00.000'),
  });
  await insertRun({ ...key, kind: 'watch', fen: 1n, first: bj('2031-03-02', '09:00:00.000') });
  await insertRun({
    ...key,
    kind: 'detail',
    fen: 400n,
    coupon: 50n,
    first: bj('2031-03-09', '23:59:59.999'),
    last: bj('2031-03-10', '00:00:00.000'),
  });
  await insertRun({
    ...key,
    kind: 'quote',
    fen: 996n,
    first: bj('2031-01-01', '10:00:00.000'),
    last: bj('2031-02-08', '23:59:59.999'),
  });
  await insertRun({
    ...key,
    productKey: 'tb:2',
    kind: 'detail',
    fen: 999n,
    first: bj('2031-03-05'),
  });
  await insertRun({
    ...key,
    appId: 'pt-int-b',
    kind: 'detail',
    fen: 998n,
    first: bj('2031-03-06'),
  });
  await insertRun({ ...key, platform: 'jd', kind: 'detail', fen: 997n, first: bj('2031-03-07') });

  const result = await getPriceTrend(optionsOf(store), key);
  expect(result).toEqual({
    status: 'ok',
    points: [
      { date: '2031-02-09', final_price_fen: 500n },
      { date: '2031-02-10', final_price_fen: 450n },
      { date: '2031-03-01', final_price_fen: 410n },
      { date: '2031-03-09', final_price_fen: 400n },
      { date: '2031-03-10', final_price_fen: 400n },
    ],
    start_date: '2031-02-09',
    window_days: 30,
    source_key: 'price_trend.source',
    mode_price_fen: 400n,
  });
  expect(Object.keys(result).sort()).toEqual([
    'mode_price_fen',
    'points',
    'source_key',
    'start_date',
    'status',
    'window_days',
  ]);
}, 30_000);

it('[AC-B1-29a#33] 连库：platforms.key_stability 为 unverified、stable_24h、unstable 时 no_data，改成 stable_7d 后同一批行才出走势', async () => {
  const store = createKyselyPriceTrendStore(db);
  const key = { appId: 'pt-int-c', platform: 'jd', productKey: 'jd:1' };
  await insertRun({ ...key, kind: 'detail', fen: 300n, first: bj('2031-03-07') });
  await insertRun({ ...key, kind: 'detail', fen: 2147483649n, first: bj('2031-03-08') });
  await insertRun({ ...key, kind: 'detail', fen: 1n, first: bj('2031-03-09') });

  await setStability('jd', 'unverified');
  expect(await getPriceTrend(optionsOf(store), key)).toEqual(NO_DATA);
  await setStability('jd', 'stable_24h');
  expect(await getPriceTrend(optionsOf(store), key)).toEqual(NO_DATA);
  await setStability('jd', 'unstable');
  expect(await getPriceTrend(optionsOf(store), key)).toEqual(NO_DATA);
  await setStability('jd', 'stable_7d');
  expect(await getPriceTrend(optionsOf(store), key)).toEqual({
    status: 'ok',
    points: [
      { date: '2031-03-07', final_price_fen: 300n },
      { date: '2031-03-08', final_price_fen: 2147483649n },
      { date: '2031-03-09', final_price_fen: 1n },
    ],
    start_date: '2031-03-07',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 1n,
  });
}, 30_000);

it('[AC-B1-29a#34] 连库：只有 1 天记录 → 默认 no_data；price_trend.min_distinct_days = 1 → ok', async () => {
  const store = createKyselyPriceTrendStore(db);
  await setStability('taobao', 'stable_7d');
  const key = { appId: 'pt-int-d', platform: 'taobao', productKey: 'tb:9' };
  await insertRun({ ...key, kind: 'detail', fen: 700n, first: bj('2031-03-09', '08:00:00.000') });
  await insertRun({ ...key, kind: 'search', fen: 690n, first: bj('2031-03-09', '20:00:00.000') });

  expect(await getPriceTrend(optionsOf(store), key)).toEqual(NO_DATA);
  expect(await getPriceTrend(optionsOf(store, minDaysConfig(1)), key)).toEqual({
    status: 'ok',
    points: [{ date: '2031-03-09', final_price_fen: 700n }],
    start_date: '2031-03-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 700n,
  });
}, 30_000);

it('[AC-B1-29a#35] 连库：没有记录的商品、未知平台代码 → no_data', async () => {
  const store = createKyselyPriceTrendStore(db);
  await setStability('taobao', 'stable_7d');
  expect(
    await getPriceTrend(optionsOf(store), {
      appId: 'pt-int-e',
      platform: 'taobao',
      productKey: 'tb:404',
    }),
  ).toEqual(NO_DATA);
  const ghost = { appId: 'pt-int-e', platform: 'nosuchplatform', productKey: 'tb:405' };
  await insertRun({ ...ghost, kind: 'detail', fen: 100n, first: bj('2031-03-08') });
  await insertRun({ ...ghost, kind: 'detail', fen: 110n, first: bj('2031-03-09') });
  expect(await getPriceTrend(optionsOf(store), ghost)).toEqual(NO_DATA);
}, 30_000);
