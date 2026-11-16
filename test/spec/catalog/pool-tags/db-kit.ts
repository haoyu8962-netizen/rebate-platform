// CT-07e: pool_items.tags in the database (规划/04 §3.2: text[] NOT NULL DEFAULT '{}', existing rows
// read as []). Every int case asserts the column first, so before the migration it fails on an
// assertion and not on PostgreSQL's undefined_column error. Raw SQL keeps the files typecheckable
// before db:snapshot regenerates the row types. Seeding helpers are for setup only: the writers
// under test never go through them.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { columns, ITEMS } from '../product-pool-schema/kit.ts';

export const TIMEOUT = 120_000;

export async function requireTags(db: Kysely<DB>): Promise<void> {
  expect((await columns(db, ITEMS)).filter((column) => column.name === 'tags')).toEqual([
    { name: 'tags', type: '_text', nullable: false, default_expr: "'{}'::text[]" },
  ]);
}

export async function storedTags(
  db: Kysely<DB>,
  appId: string,
  poolId: string,
  productKey: string,
): Promise<string[]> {
  const { rows } = await sql<{ tags: string[] }>`
    SELECT tags FROM app.pool_items
    WHERE app_id = ${appId} AND pool_id = ${poolId}::uuid AND product_key = ${productKey}
  `.execute(db);
  expect(rows).toHaveLength(1);
  return rows[0]!.tags;
}

/** Seed only: sets the stored tags of one row as they are (already normalized by the caller). */
export async function seedTags(
  db: Kysely<DB>,
  appId: string,
  poolId: string,
  productKey: string,
  tags: readonly string[],
): Promise<void> {
  const { rows } = await sql<{ product_key: string }>`
    UPDATE app.pool_items SET tags = ${[...tags]}::text[]
    WHERE app_id = ${appId} AND pool_id = ${poolId}::uuid AND product_key = ${productKey}
    RETURNING product_key
  `.execute(db);
  expect(rows).toEqual([{ product_key: productKey }]);
}
