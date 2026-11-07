import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';
import { casCreditOrder } from './credit-store.ts';

/** A Kysely whose driver records each compiled statement and answers no rows. */
function recordingDb(): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });
  return { db, queries };
}

it('[AC-B2-04m] casCreditOrder writes credited_at = the injected now in the same CAS statement as R5 and the booked pair', async () => {
  const { db, queries } = recordingDb();
  const now = new Date('2026-10-23T08:00:00.000Z');
  const attrAt = new Date('2026-09-01T00:00:00.000Z');
  const written = await db.transaction().execute((trx) =>
    casCreditOrder(trx, {
      app_id: 'couli',
      order_id: '019a0000-0000-7000-8000-000000000001',
      attr_at: attrAt,
      from: 'WAITING',
      to: 'CREDITED',
      row_version: 3,
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      at: now,
    }),
  );
  expect(written).toBe(false);
  const updates = queries.filter((q) => q.sql.startsWith('update'));
  expect(updates).toHaveLength(1);
  expect(updates[0]!.sql).toBe(
    'update "app"."orders" set "rebate_status" = $1, "booked_base_fen" = $2, "booked_n_fen" = $3, "credited_at" = $4, "refunded_quantity_at_credit" = "refunded_quantity", "row_version" = $5, "updated_at" = $6 where "app_id" = $7 and "order_id" = $8 and "attr_at" = $9 and "rebate_status" = $10 and "row_version" = $11',
  );
  expect(updates[0]!.parameters).toEqual([
    'CREDITED',
    850n,
    1000n,
    now,
    4,
    now,
    'couli',
    '019a0000-0000-7000-8000-000000000001',
    attrAt,
    'WAITING',
    3,
  ]);
});
