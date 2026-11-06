// B1-28p: app.product_feedbacks keeps only what 08 BR-ID-30 细则「商品反馈记录」 lists (platform,
// product_key, the detail's link_id, the shown final price and rebate, the quote time, the reason,
// the optional note, the device, user_id when logged in) plus id, app_id and created_at (brief
// §9.2 ②); no contact column. The table is read through pg_attribute, so before the migration the
// column list is empty and the test fails as an assertion.
// Only the orchestrator runs this file, with the shared integration global setup.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { STORED_COLUMNS, columnsOf } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-28p#31] 新表 app.product_feedbacks 只有所列字段，没有联系方式列', async () => {
  const columns = await columnsOf(db);
  expect(columns, 'app.product_feedbacks must exist').not.toEqual([]);
  expect(
    columns.filter((name) => /phone|mobile|contact|wechat|weixin|email|qq/i.test(name)),
  ).toEqual([]);
  expect(columns).toEqual([...STORED_COLUMNS].sort());
}, 30_000);
