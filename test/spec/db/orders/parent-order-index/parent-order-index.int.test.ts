// Rule tests for B1-09w (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853, D10-889): the partial index
// orders_parent_order_idx (app_id, parent_order_id) WHERE parent_order_id IS NOT NULL on the
// partitioned app.orders, built by a plain `CREATE INDEX … ON app.orders` (no ONLY, as in 0007),
// so PostgreSQL builds and attaches a child index on every partition that already exists (the
// deployed database has month partitions pre-created by `pnpm db:partitions`) and later month
// partitions inherit it. Own database per file. No EXPLAIN assertions (planner-dependent). Every
// lookup goes through to_regclass, so on a database without the index the tests fail on
// assertions, not on SQL errors. Top-level it() only (规划/11 §4.3).
import { readFileSync, readdirSync } from 'node:fs';

import { createDb, destroyDb, monthPartitionName, monthStartDate, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { newOrder, newOrderKey, unique, useDb } from '../kit.ts';

const INDEX = 'orders_parent_order_idx';
const PARENT_DEF =
  'CREATE INDEX orders_parent_order_idx ON ONLY app.orders USING btree (app_id, parent_order_id) WHERE (parent_order_id IS NOT NULL)';
const PREDICATE = '(parent_order_id IS NOT NULL)';
const COLUMNS = ['app_id', 'parent_order_id'];
const NEW_MONTH = new Date('2027-06-01T00:00:00Z');

let database: TestDatabase;
let app: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await Promise.all([app, maint].filter(Boolean).map((db) => destroyDb(db)));
  if (database) await database.drop();
});

type Shape = {
  table: string;
  method: string;
  columns: string[];
  keyCount: number;
  totalCount: number;
  expressions: boolean;
  predicate: string | null;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  options: string;
};

/** Shape of an index (by oid) with deparsing under search_path = pg_catalog. */
async function shapeOf(oid: number): Promise<Shape | undefined> {
  return app.transaction().execute(async (tx) => {
    await sql`SET LOCAL search_path = pg_catalog`.execute(tx);
    const rows = await sql<{
      tbl: string;
      method: string;
      cols: string | null;
      key_count: number;
      total_count: number;
      expressions: boolean;
      predicate: string | null;
      is_unique: boolean;
      valid: boolean;
      ready: boolean;
      options: string;
    }>`
      SELECT t.relname AS tbl,
             am.amname AS method,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS cols,
             x.indnkeyatts::int AS key_count,
             x.indnatts::int AS total_count,
             (x.indexprs IS NOT NULL) AS expressions,
             pg_get_expr(x.indpred, x.indrelid) AS predicate,
             x.indisunique AS is_unique,
             x.indisvalid AS valid,
             x.indisready AS ready,
             x.indoption::text AS options
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_am am ON am.oid = i.relam
      WHERE x.indexrelid = ${oid}::oid
    `.execute(tx);
    const r = rows.rows[0];
    if (r === undefined) return undefined;
    return {
      table: r.tbl,
      method: r.method,
      columns: r.cols === null ? [] : r.cols.split(','),
      keyCount: Number(r.key_count),
      totalCount: Number(r.total_count),
      expressions: r.expressions,
      predicate: r.predicate,
      unique: r.is_unique,
      valid: r.valid,
      ready: r.ready,
      options: r.options,
    };
  });
}

/** Oid of app.orders_parent_order_idx, or null when it does not exist. */
async function parentIndexOid(): Promise<number | null> {
  const rows = await sql<{ oid: number | null }>`
    SELECT to_regclass(${`app.${INDEX}`})::oid::int8 AS oid
  `.execute(app);
  const oid = rows.rows[0]?.oid;
  return oid === null || oid === undefined ? null : Number(oid);
}

/** Partition indexes attached to the parent index (pg_inherits), with the table they index. */
async function attachedChildren(): Promise<{ oid: number; name: string; table: string }[]> {
  const rows = await sql<{ oid: string; name: string; tbl: string }>`
    SELECT c.oid::int8 AS oid, c.relname AS name, t.relname AS tbl
    FROM pg_inherits h
    JOIN pg_class c ON c.oid = h.inhrelid
    JOIN pg_index x ON x.indexrelid = c.oid
    JOIN pg_class t ON t.oid = x.indrelid
    WHERE h.inhparent = to_regclass(${`app.${INDEX}`})
    ORDER BY t.relname
  `.execute(app);
  return rows.rows.map((r) => ({ oid: Number(r.oid), name: r.name, table: r.tbl }));
}

/** Partitions of app.orders (table names). */
async function orderPartitions(): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT c.relname AS name
    FROM pg_inherits h
    JOIN pg_class c ON c.oid = h.inhrelid
    WHERE h.inhparent = 'app.orders'::regclass
    ORDER BY c.relname
  `.execute(app);
  return rows.rows.map((r) => r.name);
}

function expectSameShape(child: Shape | undefined, table: string): void {
  expect(child, `index on ${table}`).toMatchObject({
    table,
    method: 'btree',
    columns: COLUMNS,
    keyCount: 2,
    totalCount: 2,
    expressions: false,
    predicate: PREDICATE,
    unique: false,
    valid: true,
    ready: true,
    options: '0 0',
  });
}

/** Creates (idempotently) the orders month partition of `month` as couli_maint. */
async function ensureOrdersPartition(month: Date): Promise<string> {
  const created = await sql<{ name: string }>`
    SELECT app.ensure_month_partition('orders', ${monthStartDate(month)}::date) AS name
  `.execute(maint);
  return created.rows[0]?.name ?? '';
}

it('[AC-B1-09w#1] app.orders has orders_parent_order_idx on exactly (app_id, parent_order_id) WHERE parent_order_id IS NOT NULL', async () => {
  const oid = await parentIndexOid();
  expect(oid, `app.${INDEX} exists`).not.toBeNull();
  const shape = await shapeOf(oid ?? 0);
  expect(shape).toMatchObject({
    table: 'orders',
    method: 'btree',
    columns: COLUMNS,
    keyCount: 2,
    totalCount: 2,
    expressions: false,
    predicate: PREDICATE,
    options: '0 0',
  });
  const def = await app.transaction().execute(async (tx) => {
    await sql`SET LOCAL search_path = pg_catalog`.execute(tx);
    const rows = await sql<{ def: string | null; kind: string | null }>`
      SELECT pg_get_indexdef(i.oid) AS def, i.relkind::text AS kind
      FROM pg_class i WHERE i.oid = to_regclass(${`app.${INDEX}`})
    `.execute(tx);
    return rows.rows[0];
  });
  // relkind 'I': a partitioned index declared on the parent. pg_get_indexdef always deparses a
  // partitioned index as ON ONLY, whether or not the migration wrote ONLY (cf. 0007's indexes).
  expect(def).toEqual({ def: PARENT_DEF, kind: 'I' });
});

// This case checks the maintenance path and inheritance on a database with month partitions. The
// test template only runs ensure_month_partition after all migrations, so it cannot build a
// database whose month partitions existed *before* this migration (the deployed case, where
// ON ONLY + attaching orders_default alone would leave the parent index invalid); #5's static
// assertion on the migration source covers that.
it('[AC-B1-09w#2] with the current and next month partitions created, every orders partition carries an attached same-shape child index and the parent index is valid and ready (pre-existing partitions: see #5)', async () => {
  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const months = [await ensureOrdersPartition(thisMonth), await ensureOrdersPartition(nextMonth)];
  expect(months).toEqual([
    monthPartitionName('orders', thisMonth),
    monthPartitionName('orders', nextMonth),
  ]);
  const partitions = await orderPartitions();
  expect(partitions).toEqual(expect.arrayContaining(['orders_default', ...months]));
  expect(partitions.length).toBeGreaterThanOrEqual(3);

  const oid = await parentIndexOid();
  expect(oid, `app.${INDEX} exists`).not.toBeNull();
  const children = await attachedChildren();
  // Exactly one attached child per partition, and no partition without one.
  expect(children.map((c) => c.table)).toEqual(partitions);
  for (const partition of partitions) {
    const on = children.filter((c) => c.table === partition);
    expect(on, `attached child index on ${partition}`).toHaveLength(1);
    expectSameShape(await shapeOf(on[0]?.oid ?? 0), partition);
  }
  const parent = await shapeOf(oid ?? 0);
  expect(parent?.valid, 'parent indisvalid').toBe(true);
  expect(parent?.ready, 'parent indisready').toBe(true);
});

it('[AC-B1-09w#3] a month partition created after the migration gets a same-shape child index automatically', async () => {
  const partition = await ensureOrdersPartition(NEW_MONTH);
  expect(partition).toBe('orders_p202706');
  expect(await orderPartitions()).toContain(partition);
  const children = await attachedChildren();
  const onNew = children.filter((c) => c.table === partition);
  expect(onNew, `attached child index on ${partition}`).toHaveLength(1);
  expectSameShape(await shapeOf(onNew[0]?.oid ?? 0), partition);
  expect(children.map((c) => c.table)).toEqual(await orderPartitions());
  expect((await shapeOf((await parentIndexOid()) ?? 0))?.valid).toBe(true);
});

it('[AC-B1-09w#4] the index is not unique: one app may hold several orders with the same parent order id', async () => {
  const oid = await parentIndexOid();
  expect(oid, `app.${INDEX} exists`).not.toBeNull();
  expect((await shapeOf(oid ?? 0))?.unique).toBe(false);
  const children = await attachedChildren();
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) {
    expect((await shapeOf(child.oid))?.unique, child.name).toBe(false);
  }
  const parent = unique('parent');
  await newOrder({ parent_order_id: parent });
  await newOrder({ parent_order_id: parent });
  // A third sibling in another month (the partition from #3 when it exists, DEFAULT otherwise).
  await newOrder(
    { parent_order_id: parent },
    await newOrderKey({ attr_at: new Date('2027-06-15T08:00:00Z') }),
  );
  const rows = await sql<{ n: string }>`
    SELECT count(*)::int8 AS n FROM app.orders
    WHERE app_id = 'couli' AND parent_order_id = ${parent}
  `.execute(app);
  expect(Number(rows.rows[0]?.n)).toBe(3);
});

// Main guard for the deployed database (D10-889): month partitions already exist there before
// this migration runs, and `CREATE INDEX … ON ONLY app.orders` + attaching orders_default alone
// would leave them without a child index and the parent index invalid. A plain CREATE INDEX on
// app.orders builds and attaches a child on every existing partition in the same transaction.
it('[AC-B1-09w#5] the migration builds the index with a plain CREATE INDEX orders_parent_order_idx ON app.orders (no ONLY / ATTACH PARTITION / CONCURRENTLY / UNIQUE, no data or drop statements)', () => {
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const files = readdirSync(directory).filter(
    (file) => /^\d{4}_/.test(file) && file.endsWith('.sql') && file.includes('parent-order'),
  );
  expect(files, 'exactly one ^NNNN_*parent-order*.sql migration').toHaveLength(1);
  const source = readFileSync(new URL(files[0] ?? '', directory), 'utf8');
  expect(source.split(/\r?\n/)[0]).toBe('-- Up Migration');
  expect(source).not.toMatch(/^\s*--\s*Down Migration/im);
  // Comments may describe the recovery (e.g. a DROP INDEX); only statements count.
  const code = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
  expect(code).toMatch(/\bSET\s+LOCAL\s+lock_timeout\s*(?:=|TO)\s*'5s'/i);
  expect(code).toMatch(/\bSET\s+LOCAL\s+statement_timeout\b/i);
  const statements = code.replace(/'(?:''|[^'])*'/g, "''");
  // `ON` directly followed by `app.orders (`: nothing (in particular no ONLY) in between.
  expect(statements).toMatch(/\bCREATE\s+INDEX\s+orders_parent_order_idx\s+ON\s+app\.orders\s*\(/i);
  expect(statements).not.toMatch(/\bON\s+ONLY\b/i);
  expect(statements).not.toMatch(/\bATTACH\s+PARTITION\b/i);
  expect(statements).not.toMatch(/\bCONCURRENTLY\b/i);
  expect(statements).not.toMatch(/\bUNIQUE\b/i);
  expect(statements).not.toMatch(/\b(?:UPDATE|DELETE|DROP)\b/i);
});
