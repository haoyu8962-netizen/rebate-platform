import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECK_VIOLATION, newOrder, useDb } from '../kit.ts';
import { requireAttrPidScene } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
  useDb(db);
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08zzi#10] 场景列是无默认值的可空 text，应用角色可更新且已校验的 CHECK 限制取值', async () => {
  expect(await requireAttrPidScene(db)).toEqual({
    data_type: 'text',
    is_nullable: 'YES',
    column_default: null,
  });

  const { rows: constraints } = await sql<{ convalidated: boolean }>`
    SELECT convalidated
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app.orders'::regclass
      AND contype = 'c' AND conname = 'orders_attr_pid_scene_check'
  `.execute(db);
  expect(constraints).toEqual([{ convalidated: true }]);

  const key = await newOrder();
  async function writeScene(scene: string | null) {
    const { rows } = await sql<{ attr_pid_scene: string | null }>`
      UPDATE app.orders
      SET attr_pid_scene = ${scene}
      WHERE app_id = 'couli' AND order_id = ${key.orderId} AND attr_at = ${key.attrAt}
      RETURNING attr_pid_scene
    `.execute(db);
    return rows;
  }

  for (const scene of ['self_buy', 'agent', 'share', 'taolijin', 'fallback', 'query', null]) {
    expect(await writeScene(scene)).toEqual([{ attr_pid_scene: scene }]);
  }
  await expect(writeScene('normal')).rejects.toMatchObject({
    code: CHECK_VIOLATION,
    constraint: 'orders_attr_pid_scene_check',
  });
});
