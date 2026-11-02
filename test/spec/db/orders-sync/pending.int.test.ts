import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  LATER,
  REASONS,
  connect,
  expectCheck,
  fixture,
  insert,
  orderId,
  repeat,
  requireTable,
  sqlState,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});
const TABLE = 'order_sync_pending';

it('[AC-B1-08c#8] named CHECKs admit exactly nine reasons and three disposition states', async () => {
  await requireTable(app, TABLE);
  await expectCheck(app, TABLE, 'reason', [...REASONS, 'ORDER_ROW_INVALID']);
  await expectCheck(app, TABLE, 'status', ['open', 'resolved', 'dismissed']);
  for (const reason of [...REASONS, 'ORDER_ROW_INVALID']) {
    for (const status of ['open', 'resolved', 'dismissed']) {
      const row = await fixture(TABLE, { reason, status });
      expect(await sqlState(insert(app, TABLE, row)), `${reason}/${status}`).toBe('no error');
    }
  }
  for (const changes of [
    { reason: 'UNKNOWN' },
    { reason: '' },
    { reason: 'unmapped_status' },
    { status: 'OPEN' },
    { status: 'closed' },
    { status: '' },
  ]) {
    expect(await sqlState(insert(app, TABLE, await fixture(TABLE, changes)))).toBe('23514');
  }
});

it('[AC-B1-08c#9] pending accepts absent order and raw status; payload ids remain logical references', async () => {
  await requireTable(app, TABLE);
  const row = await fixture(TABLE, { raw_payload_id: 9007199254740993n });
  const result = await insert(app, TABLE, row);
  expect(result.rows).toEqual([
    expect.objectContaining({
      order_id: null,
      raw_status: null,
      raw_payload_id: 9007199254740993n,
      detected_at: AT,
    }),
  ]);
  expect(
    await sqlState(
      insert(
        app,
        TABLE,
        await fixture(TABLE, {
          order_id: await orderId(),
          raw_status: 'synthetic-unmapped-status',
        }),
      ),
    ),
  ).toBe('no error');
  expect(
    await sqlState(
      insert(
        app,
        TABLE,
        await fixture(TABLE, {
          order_id: randomUUID(),
        }),
      ),
    ),
  ).toBe('23503');
});

it('[AC-B1-08c#10] the named partial unique index covers only open cases', async () => {
  await requireTable(app, TABLE);
  const indexes = await sql<{ name: string; cols: string[]; predicate: string | null }>`
    SELECT c.relname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS cols,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('app.order_sync_pending') AND i.indisunique
      AND i.indisvalid AND i.indisready
  `.execute(app);
  const index = indexes.rows.find(
    (i) => i.cols.join(',') === 'app_id,platform,sub_order_id,reason',
  );
  expect(index).toBeDefined();
  expect(index?.name.length).toBeGreaterThan(0);
  expect(index?.predicate).toMatch(/\bstatus\b.*'open'/);
  const row = await fixture(TABLE);
  expect(await sqlState(insert(app, TABLE, row))).toBe('no error');
  expect(await sqlState(repeat(app, TABLE, row))).toBe('23505');
  for (const changes of [
    { app_id: 'couli_two' },
    { platform: 'jd' },
    { sub_order_id: randomUUID() },
    { reason: 'NO_RECEIVED_AT' },
    { status: 'resolved' },
    { status: 'resolved' },
    { status: 'dismissed' },
    { status: 'dismissed' },
  ]) {
    expect(await sqlState(repeat(app, TABLE, row, changes))).toBe('no error');
  }
});

it('[AC-B1-08c#11] concurrent attempts at the same unresolved case leave one row', async () => {
  await requireTable(app, TABLE);
  const row = await fixture(TABLE);
  const states = await Promise.all([
    sqlState(repeat(app, TABLE, row)),
    sqlState(repeat(app, TABLE, row)),
  ]);
  expect(states.sort()).toEqual(['23505', 'no error']);
  const stored = await sql<{ count: bigint }>`SELECT count(*) AS count FROM app.order_sync_pending
    WHERE sub_order_id = ${row['sub_order_id']}`.execute(app);
  expect(stored.rows).toEqual([{ count: 1n }]);
});

it('[AC-B1-08c#12] detected_at can refresh in place and disposition frees the open key', async () => {
  await requireTable(app, TABLE);
  for (const status of ['resolved', 'dismissed']) {
    const row = await fixture(TABLE);
    const inserted = await insert(app, TABLE, row);
    const id = inserted.rows[0]?.['id'];
    expect(id).toBeDefined();
    expect(
      await sqlState(
        sql`UPDATE app.order_sync_pending SET detected_at = ${LATER}
      WHERE id = ${id}`.execute(app),
      ),
    ).toBe('no error');
    const refreshed = await sql<{ detected_at: Date; status: string }>`
      SELECT detected_at, status FROM app.order_sync_pending WHERE id = ${id}`.execute(app);
    expect(refreshed.rows).toEqual([{ detected_at: LATER, status: 'open' }]);
    expect(await sqlState(repeat(app, TABLE, row))).toBe('23505');
    expect(
      await sqlState(
        sql`UPDATE app.order_sync_pending
      SET status = ${status}, resolved_at = ${LATER}, resolution_note = 'synthetic disposition'
      WHERE id = ${id}`.execute(app),
      ),
    ).toBe('no error');
    const resolved = await sql<{ status: string; resolved_at: Date; resolution_note: string }>`
      SELECT status, resolved_at, resolution_note FROM app.order_sync_pending WHERE id = ${id}`.execute(
      app,
    );
    expect(resolved.rows).toEqual([
      { status, resolved_at: LATER, resolution_note: 'synthetic disposition' },
    ]);
    expect(await sqlState(repeat(app, TABLE, row))).toBe('no error');
    expect(
      await sqlState(
        sql`UPDATE app.order_sync_pending SET status = 'open'
      WHERE id = ${id}`.execute(app),
      ),
    ).toBe('23505');
  }
});

it('[AC-B1-08c#13] pending mandatory fields reject NULL and missing status has no implicit open default', async () => {
  await requireTable(app, TABLE);
  for (const column of ['app_id', 'platform', 'sub_order_id', 'reason', 'detected_at', 'status']) {
    expect(
      await sqlState(insert(app, TABLE, await fixture(TABLE, { [column]: null }))),
      column,
    ).toBe('23502');
  }
  const row = await fixture(TABLE);
  delete row['status'];
  expect(await sqlState(insert(app, TABLE, row))).toBe('23502');
});
