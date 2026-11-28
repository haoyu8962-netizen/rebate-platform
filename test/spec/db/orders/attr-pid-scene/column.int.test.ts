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

function listedScenes(definition: string): Set<string> {
  return new Set(
    Array.from(definition.matchAll(/'((?:[^']|'')*)'/g), (match): string =>
      match[1]!.replaceAll("''", "'"),
    ),
  );
}

it('[AC-B1-08zzi#10] 场景列是无默认值的可空 text，应用角色可更新且已校验的 CHECK 限制取值', async () => {
  expect(await requireAttrPidScene(db)).toEqual({
    data_type: 'text',
    is_nullable: 'YES',
    column_default: null,
  });

  const { rows: constraints } = await sql<{
    convalidated: boolean;
    order_scene_check: string;
    union_scene_check: string;
  }>`
    SELECT orders_check.convalidated,
           pg_catalog.pg_get_constraintdef(orders_check.oid) AS order_scene_check,
           pg_catalog.pg_get_constraintdef(union_check.oid) AS union_scene_check
    FROM pg_catalog.pg_constraint AS orders_check
    CROSS JOIN pg_catalog.pg_constraint AS union_check
    WHERE orders_check.conrelid = 'app.orders'::regclass
      AND orders_check.contype = 'c' AND orders_check.conname = 'orders_attr_pid_scene_check'
      AND union_check.conrelid = 'app.union_pids'::regclass
      AND union_check.contype = 'c' AND union_check.conname = 'union_pids_pid_scene_check'
  `.execute(db);
  expect(constraints).toHaveLength(1);
  const constraint = constraints[0]!;
  expect(constraint.convalidated).toBe(true);
  expect(listedScenes(constraint.order_scene_check)).toEqual(
    listedScenes(constraint.union_scene_check),
  );

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
