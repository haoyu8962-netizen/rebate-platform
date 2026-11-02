// B1-04zv：order_sync_pending.reason 的 CHECK 加 ORDER_ROW_INVALID（先 NOT VALID 再 validate，走迁移队列）。
// 原有九个取值都还能写，未知值仍被拒绝，约束是已验证的。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  connect,
  expectCheck,
  fixture,
  insert,
  REASONS,
  requireTable,
  sqlState,
} from '../../db/orders-sync/kit.ts';

const TABLE = 'order_sync_pending';
const REASON = 'ORDER_ROW_INVALID';

let database: TestDatabase | undefined;
let app: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
}, 180_000);
afterAll(async () => {
  try {
    if (app) await destroyDb(app);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-04zv#15] CHECK 接受 ORDER_ROW_INVALID，拒绝未知值，原有取值都还能写，约束已验证', async () => {
  await requireTable(app, TABLE);
  expect(await sqlState(insert(app, TABLE, await fixture(TABLE, { reason: REASON })))).toBe(
    'no error',
  );
  for (const reason of REASONS) {
    expect(await sqlState(insert(app, TABLE, await fixture(TABLE, { reason }))), reason).toBe(
      'no error',
    );
  }
  for (const reason of ['ORDER_ROW_UNKNOWN', 'order_row_invalid', '']) {
    expect(await sqlState(insert(app, TABLE, await fixture(TABLE, { reason }))), reason).toBe(
      '23514',
    );
  }
  await expectCheck(app, TABLE, 'reason', [...REASONS, REASON]);
  const checks = await sql<{ def: string; validated: boolean }>`
    SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated
    FROM pg_constraint
    WHERE conrelid = to_regclass('app.order_sync_pending') AND contype = 'c'
  `.execute(app);
  expect(checks.rows.filter((check) => check.def.includes(REASON))).toEqual([
    expect.objectContaining({ validated: true }),
  ]);
});
