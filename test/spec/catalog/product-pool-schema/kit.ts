// B1-05p rule tests (规划/04 §3.2 product_pools / pool_items; 规划/08 BR-PROD-08 ③、BR-PROD-05; 编排裁定
// D10-452 ②): storage contract of app.product_pools and app.pool_items only, no pool logic.
//   - A pool belongs to one App: (app_id, pool_id) is its key, so one pool_id under two Apps is two
//     independent pools.
//   - A product appears once per pool: (app_id, pool_id, product_key) is the primary key of pool_items
//     (BR-PROD-08 ③). Adding it again rewrites sort, start_at and end_at only; created_at and the
//     creator stay.
//   - Items reference their pool through (app_id, pool_id) without cascades: a pool with items cannot
//     be deleted. Columns follow the contract schemas AdminProductPool and AdminPoolItem.
//   - catalog is the only writer and is no append-only writer: couli_app reads, inserts, updates and
//     deletes; couli_readonly reads; couli_payout and couli_maint get nothing.
// Rows go through raw SQL: the generated DB types do not know the tables before the snapshot.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const POOLS = 'app.product_pools';
export const ITEMS = 'app.pool_items';
export const TABLES = [POOLS, ITEMS] as const;
export type Table = (typeof TABLES)[number];
export const ROLES = ['couli_app', 'couli_payout', 'couli_readonly', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
export type Row = Record<string, unknown>;
export type Connection = Kysely<DB>;
interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: Database;
  app: Connection;
  roles: Record<Role, Connection>;
}

// [Postgres type, nullable, default]. Only created_at / updated_at carry the SQL clock default
// (db/AGENTS.md rule 6); pool_id is a UUIDv7 from the application; created_by is an admin account id
// (contract Id), uuid NOT NULL like the other console creator columns of db/schema.sql.
type Shape = Record<string, readonly [string, boolean, string | null]>;
export const POOL_SHAPE: Shape = {
  app_id: ['text', false, null],
  pool_id: ['uuid', false, null],
  name: ['text', false, null],
  status: ['text', false, null],
  revision: ['int8', false, '0'],
  created_by: ['uuid', false, null],
  created_at: ['timestamptz', false, 'now()'],
  updated_at: ['timestamptz', false, 'now()'],
};
export const ITEM_SHAPE: Shape = {
  app_id: ['text', false, null],
  pool_id: ['uuid', false, null],
  product_key: ['text', false, null],
  platform: ['text', false, null],
  raw_item_id: ['text', false, null],
  title: ['text', false, null],
  image: ['text', true, null],
  price_fen: ['int8', false, null],
  coupon_fen: ['int8', false, null],
  final_price_fen: ['int8', false, null],
  commission_rate_bp: ['int4', true, null],
  shop_name: ['text', true, null],
  quoted_at: ['timestamptz', false, null],
  status: ['text', false, null],
  sort: ['int4', false, '0'],
  start_at: ['timestamptz', true, null],
  end_at: ['timestamptz', true, null],
  invalid_reason: ['text', true, null],
  created_by: ['uuid', false, null],
  created_at: ['timestamptz', false, 'now()'],
  updated_at: ['timestamptz', false, 'now()'],
};
export const SHAPES: Record<Table, Shape> = { [POOLS]: POOL_SHAPE, [ITEMS]: ITEM_SHAPE };
export const FEN_COLUMNS = ['price_fen', 'coupon_fen', 'final_price_fen'];
export const POOL_STATUSES = ['active', 'disabled'];
export const ITEM_STATUSES = ['online', 'offline'];
export const QUOTED_AT = new Date('2032-06-30T16:00:00Z');
export const START_AT = new Date('2032-07-01T00:00:00Z');
export const END_AT = new Date('2032-07-08T00:00:00Z');
const CODES = ['23502', '23503', '23505', '23514', '42501'];

export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  const roles = Object.fromEntries(
    ROLES.map((role) => [role, createDb({ connectionString: database.urlFor(role), max: 2 })]),
  ) as Record<Role, Connection>;
  return { database, roles, app: roles.couli_app };
}
export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all(Object.values(h.roles).map((db) => destroyDb(db)));
  await h.database.drop();
}
export async function columns(db: Connection, table: Table) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; default_expr: string | null }>`
      SELECT a.attname::text AS name, t.typname::text AS type, NOT a.attnotnull AS nullable,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass(${table}) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`.execute(db)
  ).rows;
}
// Every case calls this first: without the migration the case fails on an assertion, not on SQL
// that references a missing table or column.
export async function ready(db: Connection): Promise<void> {
  for (const table of TABLES) {
    const found = await sql<{ name: string | null }>`
      SELECT to_regclass(${table})::text AS name`.execute(db);
    expect(found.rows, table).toEqual([{ name: table }]);
    expect((await columns(db, table)).map((c) => c.name)).toEqual(
      expect.arrayContaining(Object.keys(SHAPES[table])),
    );
  }
}
export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !CODES.includes(code)) throw error;
    return code;
  }
}

function where(key: Row) {
  return sql.join(
    Object.entries(key).map(([name, value]) => sql`${sql.ref(name)} = ${value}`),
    sql` AND `,
  );
}
export async function insert(db: Connection, table: Table, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(table)}
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}
export async function update(db: Connection, table: Table, key: Row, values: Row): Promise<void> {
  await sql`UPDATE ${sql.table(table)} SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE ${where(key)}`.execute(db);
}
export async function remove(db: Connection, table: Table, key: Row): Promise<void> {
  await sql`DELETE FROM ${sql.table(table)} WHERE ${where(key)}`.execute(db);
}
export async function stored(db: Connection, table: Table, key: Row): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM ${sql.table(table)} WHERE ${where(key)}`.execute(db)).rows;
}

export function poolKey(row: Row): Row {
  return { app_id: row['app_id'], pool_id: row['pool_id'] };
}
export function itemKey(row: Row): Row {
  return { ...poolKey(row), product_key: row['product_key'] };
}

export interface Tenant {
  app_id: string;
  admin_id: string;
}
// An admin account of `app_id`; couli_app registers admins.
export async function admin(db: Connection, app_id: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.admin_users (id, app_id, login_name, password_hash, is_super, status)
    VALUES (${id}, ${app_id}, ${`pool_${id}`}, 'synthetic-unused', false, 'active')`.execute(db);
  return id;
}
// A fresh App and the admin who creates its pools and items.
export async function tenant(db: Connection): Promise<Tenant> {
  const app_id = `b105p-${randomUUID()}`;
  return { app_id, admin_id: await admin(db, app_id) };
}
// Only the columns without a default or NULL value; a case adds the others through `values`.
export function pool(t: Tenant, values: Row = {}): Row {
  return {
    app_id: t.app_id,
    pool_id: randomUUID(),
    name: '合成测试池',
    status: 'active',
    created_by: t.admin_id,
    ...values,
  };
}
export function item(t: Tenant, owner: Row, values: Row = {}): Row {
  const stable = randomUUID().replaceAll('-', '');
  return {
    app_id: t.app_id,
    pool_id: owner['pool_id'],
    product_key: `tb:${stable}`,
    platform: 'taobao',
    raw_item_id: `raw-${stable}`,
    title: '合成测试商品',
    price_fen: 2990n,
    coupon_fen: 1000n,
    final_price_fen: 1990n,
    quoted_at: QUOTED_AT,
    status: 'online',
    created_by: t.admin_id,
    ...values,
  };
}
// A fresh App with one stored pool.
export async function seedPool(db: Connection): Promise<{ owner: Tenant; pooled: Row }> {
  const owner = await tenant(db);
  const pooled = pool(owner);
  await insert(db, POOLS, pooled);
  return { owner, pooled };
}
