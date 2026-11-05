import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { columns, ITEMS } from '../product-pool-schema/kit.ts';

// Assert the migration's shape before referring to the new column: the pre-migration red must
// be an assertion failure, not PostgreSQL's undefined_column error. No schema changes here.
export async function requireShopName(db: Kysely<DB>): Promise<void> {
  expect((await columns(db, ITEMS)).filter((column) => column.name === 'shop_name')).toEqual([
    { name: 'shop_name', type: 'text', nullable: true, default_expr: null },
  ]);
}

// SQL keeps these tests typecheckable before db:snapshot generates the new column's TS type.
export async function storedShopName(
  db: Kysely<DB>,
  appId: string,
  poolId: string,
  productKey: string,
): Promise<string | null> {
  const { rows } = await sql<{ shop_name: string | null }>`
    SELECT shop_name FROM app.pool_items
    WHERE app_id = ${appId} AND pool_id = ${poolId}::uuid AND product_key = ${productKey}
  `.execute(db);
  expect(rows).toHaveLength(1);
  return rows[0]!.shop_name;
}

/** Seed only: writers under test never use this helper. */
export async function seedShopName(
  db: Kysely<DB>,
  appId: string,
  poolId: string,
  productKey: string,
  shopName: string | null,
): Promise<void> {
  await sql`UPDATE app.pool_items SET shop_name = ${shopName}
    WHERE app_id = ${appId} AND pool_id = ${poolId}::uuid AND product_key = ${productKey}
  `.execute(db);
}
