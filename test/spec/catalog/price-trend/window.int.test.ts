// B1-29a: the window start in SQL (review r1 S1). createKyselyPriceTrendStore must not drop a
// single observation early on the first window day (+08:00): a UTC-midnight window start would.
// BR-WATCH-05 (2) runs, BR-TEXT-11 +08:00 dates; orchestrator rulings B.1, B.2, B.9, B.11.
// Every test builds the store before any fixture SQL, so on the skeleton it fails with
// NotImplemented.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createKyselyPriceTrendStore,
  getPriceTrend,
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

/** One single-observation detail run; coupon 0 so price_fen = final_price_fen. */
async function insertSingle(appId: string, productKey: string, fen: bigint, at: Date) {
  await sql`
    INSERT INTO app.price_snapshot (app_id, platform, product_key, sku_key, source_kind, price_fen,
      coupon_fen, final_price_fen, in_stock, goods_sign_plan, first_observed_at, last_observed_at,
      observation_count)
    VALUES (${appId}, 'taobao', ${productKey}, NULL, 'detail', ${fen.toString()}::bigint, 0,
      ${fen.toString()}::bigint, true, NULL, ${at}, ${at}, 1)
  `.execute(db);
}

function optionsOf(store: PriceTrendStore) {
  return { store, clock: new FixedClock(NOW), config: minDaysConfig(undefined) };
}

it('[AC-B1-29a#40] 连库：today = 03-10，窗口首日 02-09 01:00 +08:00（UTC 02-08 17:00）与 00:00:00.000 的单次观测都被读到，与 03-09 一起出两个点；02-08 23:59:59.999 的不计', async () => {
  const store = createKyselyPriceTrendStore(db);
  await sql`UPDATE app.platforms SET key_stability = 'stable_7d' WHERE code = 'taobao'`.execute(db);
  const appId = 'pt-int-win';

  await insertSingle(appId, 'tb:w1', 210n, bj('2031-02-09', '01:00:00.000'));
  await insertSingle(appId, 'tb:w1', 190n, bj('2031-03-09', '10:00:00.000'));
  expect(
    await getPriceTrend(optionsOf(store), { appId, platform: 'taobao', productKey: 'tb:w1' }),
  ).toEqual({
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

  await insertSingle(appId, 'tb:w0', 220n, bj('2031-02-09', '00:00:00.000'));
  await insertSingle(appId, 'tb:w0', 200n, bj('2031-03-09', '10:00:00.000'));
  expect(
    await getPriceTrend(optionsOf(store), { appId, platform: 'taobao', productKey: 'tb:w0' }),
  ).toEqual({
    status: 'ok',
    points: [
      { date: '2031-02-09', final_price_fen: 220n },
      { date: '2031-03-09', final_price_fen: 200n },
    ],
    start_date: '2031-02-09',
    window_days: 30,
    source_key: 'price_trend.source.general',
    mode_price_fen: 200n,
  });

  await insertSingle(appId, 'tb:wx', 230n, bj('2031-02-08', '23:59:59.999'));
  await insertSingle(appId, 'tb:wx', 205n, bj('2031-03-09', '10:00:00.000'));
  expect(
    await getPriceTrend(optionsOf(store), { appId, platform: 'taobao', productKey: 'tb:wx' }),
  ).toEqual(NO_DATA);
}, 30_000);
