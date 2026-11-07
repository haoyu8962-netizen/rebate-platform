// B1-05zm (S17-c1): product_refs.shop_id through catalog's public registerProductRef on a real
// database (the conditional upsert of infra/kysely-catalog-store.ts). A newer response without a
// shop id (null) keeps the stored shop_id (COALESCE) while every other mutable column moves; a
// newer response with a shop id replaces it; a first insert without one stores null. An older or
// same-instant response still changes nothing (AC-B1-05c#3, unchanged).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enabled, instant, reference, setup, START, stored } from '../base/kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

it('[AC-B1-05zm#11] 较新的响应 shop_id 为 null 时不覆盖已存的 shop_id（其余列照常更新）；带新值时更新；首写为 null 时存 null', async () => {
  const { catalog, clock } = setup(db);
  const appId = 'shop-coalesce';
  await catalog.registerProductRef(
    reference({ appId, shopId: '7300000000001', receivedAt: START }),
    enabled,
  );

  clock.advanceMs(1_000);
  await catalog.registerProductRef(
    reference({
      appId,
      shopId: null,
      rawItemId: 'X-K1-synthetic-newer',
      title: '合成新标题',
      source: 'detail',
      receivedAt: instant(1_000),
    }),
    enabled,
  );
  expect(await stored(db, appId, 'tb:K1')).toMatchObject([
    {
      shop_id: '7300000000001',
      raw_item_id: 'X-K1-synthetic-newer',
      title: '合成新标题',
      source: 'detail',
      refreshed_at: new Date(instant(1_000)),
    },
  ]);

  clock.advanceMs(1_000);
  await catalog.registerProductRef(
    reference({ appId, shopId: '7300000000002', receivedAt: instant(2_000) }),
    enabled,
  );
  expect(await stored(db, appId, 'tb:K1')).toMatchObject([
    { shop_id: '7300000000002', source: 'search', refreshed_at: new Date(instant(2_000)) },
  ]);

  await catalog.registerProductRef(
    reference({ appId: 'shop-coalesce-first', shopId: null, receivedAt: instant(2_000) }),
    enabled,
  );
  expect(await stored(db, 'shop-coalesce-first', 'tb:K1')).toMatchObject([{ shop_id: null }]);
});

it('[AC-B1-05zm#12] 先后两次较新的 null 也不清掉 shop_id；读回的 ProductRef.shopId 同库里一致', async () => {
  const { catalog, clock } = setup(db);
  const appId = 'shop-coalesce-twice';
  await catalog.registerProductRef(
    reference({ appId, shopId: '7300000000003', receivedAt: START }),
    enabled,
  );
  for (const delta of [1_000, 2_000]) {
    clock.advanceMs(1_000);
    await catalog.registerProductRef(
      reference({ appId, shopId: null, receivedAt: instant(delta) }),
      enabled,
    );
  }
  expect(await stored(db, appId, 'tb:K1')).toMatchObject([
    { shop_id: '7300000000003', refreshed_at: new Date(instant(2_000)) },
  ]);
  expect(await catalog.readProductRef(reference({ appId }))).toMatchObject({
    shopId: '7300000000003',
    receivedAt: instant(2_000),
  });
});
