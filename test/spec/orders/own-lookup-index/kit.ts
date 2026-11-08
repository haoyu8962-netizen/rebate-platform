// Shared helpers of the B1-09x rule tests (FU-ORDERS-OWN-LOOKUP-INDEX, D10-853): the lookups by
// order number of orders/infra (admin order search, readOwnTaobaoOrderNos, claim lookup, rights
// lookup, snapshot retry) read app.orders without a sequential scan, through order_keys (sub order
// number) and orders_parent_order_idx (parent order number), with the same results as before.
//
// Real PostgreSQL, one database per file (createTestDatabase), business roles only: couli_app
// writes and reads every row, couli_maint calls app.ensure_month_partition (no DDL is run by the
// tests themselves, no migration role, no ANALYZE, Seq Scan stays enabled). Rows are written with
// raw SQL, in the shape of test/spec/db/orders/kit.ts (order_keys first, then the orders row with
// the key's order_id / platform / sub_order_id / attr_at). Every value is synthetic.
//
// Scan measurement (as in test/spec/platform/maintenance/recheck-event-log.int.test.ts): inside
// ONE transaction the pg_stat_xact_user_tables counters of every app.orders partition are read
// before and after the call under test. Two counters are compared:
//   - seq_scan of each partition must not grow;
//   - the rows the call read from app.orders (seq_tup_read + idx_tup_fetch, which counts heap rows
//     fetched by plain and bitmap index scans) must stay within a small bound. Without column
//     statistics the planner may reach app.orders through an index that only leads with app_id
//     (orders_link_idx, orders_user_paid_idx): no sequential scan, yet every row of the app is
//     read. The background rows below make that ≥ BACKGROUND_PER_PARTITION × partitions rows, far
//     above READ_BOUND, so such a plan is told apart from a lookup by key without fixing the SQL
//     text or an index name.
// Every case of this directory measures its taobao / jd (and admin, readOwnTaobaoOrderNos,
// snapshot retry) calls this way and then checks their results, so each case is red on main
// (orders has no index on sub_order_id) and still pins the results of the rewrite. Only the pdd
// hyphen-stripped fallback is called unmeasured (`inTransaction`), inside cases that also carry a
// measured taobao / jd call.
//
// Nothing here imports the test-database base (`@couli/db/testing`): only *.int.test.ts may. Each
// test file passes its `createTestDatabase` to `installWorld`.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

/** The part of `@couli/db/testing`'s TestDatabase this kit uses. */
export interface TestDatabase {
  urlFor(role: 'couli_app' | 'couli_maint'): string;
  drop(): Promise<void>;
}

/** Creates one test database (`createTestDatabase` of `@couli/db/testing`). */
export type CreateTestDatabase = () => Promise<TestDatabase>;

export type Platform = 'taobao' | 'jd' | 'pdd';
export const PLATFORMS: readonly Platform[] = ['taobao', 'jd', 'pdd'];

/** Month partitions of app.orders created by the tests ('YYYY-MM'). */
export const MONTHS = ['2026-09', '2026-10'] as const;

/**
 * One attr_at per partition: September and October 2026 land in the month partitions above; March
 * 2025 has no month partition and lands in orders_default (checked by `layout`).
 */
export const ATTR_AT = {
  september: new Date('2026-09-12T04:00:00Z'),
  october: new Date('2026-10-12T04:00:00Z'),
  fallback: new Date('2025-03-12T04:00:00Z'),
} as const;
export const ATTR_ATS: readonly Date[] = [ATTR_AT.september, ATTR_AT.october, ATTR_AT.fallback];

/**
 * Background orders per (app, platform, partition). Large enough that each partition spans tens of
 * pages (2 apps × 3 platforms × 400 rows), so a lookup by key costs less than a sequential scan of
 * the partition whether or not autovacuum has analyzed it during the file's tests (before an
 * analyze the planner assumes 10 pages for reltuples < 0; after one, a few-page partition would
 * make a seq scan cheaper than a PK lookup). Written with one INSERT … SELECT per table.
 */
export const BACKGROUND_PER_PLATFORM = 400;
/** Background orders of one app in one partition (every platform). */
export const BACKGROUND_PER_PARTITION = BACKGROUND_PER_PLATFORM * PLATFORMS.length;

/**
 * Most rows one measured call may read from app.orders. Every measured scenario touches at most a
 * dozen orders rows (the snapshot scan joins one row per open pending row); reading all the app's
 * rows of even one partition (BACKGROUND_PER_PARTITION) exceeds it.
 */
export const READ_BOUND = 24;

export interface World {
  readonly database: TestDatabase;
  readonly app: Kysely<DB>;
  readonly maint: Kysely<DB>;
  /** The app the tests look up. */
  readonly appId: string;
  /** Another app holding look-alike rows. */
  readonly otherAppId: string;
  /** A user of each app (orders.user_id references users). */
  readonly userId: string;
  readonly otherUserId: string;
}

let sequence = 0;

/** A fresh number, digits only, unique within the run (19 digits, like a taobao order number). */
export function orderNo(): string {
  sequence += 1;
  return `${String(3900000000000000000n + BigInt(sequence) * 7919n)}`;
}

/** A pdd order_sn as the adapter stores it: YYMMDD-<15 digits>, hyphen included. */
export function pddOrderSn(): string {
  sequence += 1;
  return `261012-${String(500000000000000n + BigInt(sequence) * 7919n)}`;
}

/** A fresh uuid whose text sorts after every earlier one of this run (order_id desc is checked). */
export function orderedUuid(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

async function user(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level,
      register_method)
    VALUES (${id}::uuid, ${appId}, 'synthetic own lookup', '', ${randomUUID().slice(0, 8)},
      ${randomUUID().slice(0, 8)}, 'member', 'synthetic')
  `.execute(db);
  return id;
}

/** Background orders of `appId`: every platform × every partition, half with a parent number. */
async function background(db: Kysely<DB>, appId: string, tag: string): Promise<void> {
  const ats = ATTR_ATS.map((at) => at.toISOString());
  await sql`
    INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
    SELECT p.platform, ${`bg-${tag}-`} || p.platform || '-' || a.k::text || '-' || n::text,
      gen_random_uuid(), ${appId}, a.at
    FROM unnest(${[...PLATFORMS]}::text[]) AS p(platform)
    CROSS JOIN unnest(${ats}::timestamptz[]) WITH ORDINALITY AS a(at, k)
    CROSS JOIN generate_series(1, ${BACKGROUND_PER_PLATFORM}::int) AS n
  `.execute(db);
  await sql`
    INSERT INTO app.orders (order_id, app_id, platform, sub_order_id, parent_order_id, raw_item_id,
      platform_status, attr_at, paid_at, user_id)
    SELECT k.order_id, k.app_id, k.platform, k.sub_order_id,
      CASE WHEN right(k.sub_order_id, 1) IN ('0', '2', '4', '6', '8')
        THEN 'bgp-' || k.sub_order_id END,
      'bg-item', 'PAID', k.attr_at, k.attr_at, NULL
    FROM app.order_keys k
    WHERE k.app_id = ${appId} AND k.sub_order_id LIKE ${`bg-${tag}-%`}
  `.execute(db);
}

/**
 * A database with the month partitions of MONTHS, a user per app and the background orders of
 * both apps. Close it with `closeWorld`.
 */
async function openWorld(createTestDatabase: CreateTestDatabase): Promise<World> {
  const database = await createTestDatabase();
  const app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  for (const month of MONTHS) {
    await sql`SELECT app.ensure_month_partition('orders', ${`${month}-01`}::date)`.execute(maint);
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const appId = `own_lookup_${suffix}`;
  const otherAppId = `own_lookup_other_${suffix}`;
  const userId = await user(app, appId);
  const otherUserId = await user(app, otherAppId);
  await background(app, appId, `a${suffix}`);
  await background(app, otherAppId, `o${suffix}`);
  return { database, app, maint, appId, otherAppId, userId, otherUserId };
}

async function closeWorld(world: World | undefined): Promise<void> {
  if (world === undefined) return;
  try {
    await Promise.all([world.app, world.maint].map((db) => destroyDb(db).catch(() => undefined)));
  } finally {
    await world.database.drop();
  }
}

/**
 * Opens the file's world in `beforeAll` (with the given `createTestDatabase`) and closes it in
 * `afterAll`. Returns the getter of the opened world (throws before `beforeAll` ran).
 */
export function installWorld(createTestDatabase: CreateTestDatabase): () => World {
  let world: World | undefined;
  beforeAll(async () => {
    world = await openWorld(createTestDatabase);
  }, 180_000);
  afterAll(async () => {
    await closeWorld(world);
  }, 30_000);
  return () => {
    if (world === undefined) throw new Error('world not opened');
    return world;
  };
}

export interface NewOrder {
  readonly appId: string;
  readonly platform: Platform;
  readonly sub: string;
  readonly parent?: string | null;
  readonly attrAt?: Date;
  readonly orderId?: string;
  readonly paidAt?: Date | null;
  readonly userId?: string | null;
  readonly platformStatus?: string;
  readonly rebateStatus?: string;
  readonly buyType?: string | null;
  readonly locked?: boolean;
  readonly productKey?: string | null;
  readonly shopId?: string | null;
  readonly rawItemId?: string;
  readonly estCommissionFen?: bigint | null;
}

export interface StoredOrder {
  readonly order_id: string;
  readonly app_id: string;
  readonly platform: Platform;
  readonly sub_order_id: string;
  readonly parent_order_id: string | null;
  readonly attr_at: Date;
}

/** Inserts the order_keys row, then the orders row of one sub-order. */
export async function addOrder(db: Kysely<DB>, order: NewOrder): Promise<StoredOrder> {
  const orderId = order.orderId ?? orderedUuid();
  const attrAt = order.attrAt ?? ATTR_AT.october;
  const parent = order.parent ?? null;
  await sql`
    INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
    VALUES (${order.platform}, ${order.sub}, ${orderId}::uuid, ${order.appId},
      ${attrAt.toISOString()}::timestamptz)
  `.execute(db);
  const commission = order.estCommissionFen ?? null;
  const paidAt = order.paidAt === undefined || order.paidAt === null ? null : order.paidAt;
  await sql`
    INSERT INTO app.orders (order_id, app_id, platform, sub_order_id, parent_order_id, raw_item_id,
      platform_status, rebate_status, attr_at, paid_at, user_id, buy_type, locked, product_key,
      shop_id, est_commission_fen)
    VALUES (${orderId}::uuid, ${order.appId}, ${order.platform}, ${order.sub}, ${parent},
      ${order.rawItemId ?? `item-${order.sub}`}, ${order.platformStatus ?? 'PAID'},
      ${order.rebateStatus ?? 'UNATTRIBUTED'}, ${attrAt.toISOString()}::timestamptz,
      ${paidAt === null ? null : paidAt.toISOString()}::timestamptz,
      ${order.userId ?? null}::uuid, ${order.buyType ?? null}, ${order.locked ?? false},
      ${order.productKey ?? null}, ${order.shopId ?? null},
      ${commission === null ? null : commission.toString()}::bigint)
  `.execute(db);
  return {
    order_id: orderId,
    app_id: order.appId,
    platform: order.platform,
    sub_order_id: order.sub,
    parent_order_id: parent,
    attr_at: attrAt,
  };
}

/** The app.orders row of `orderId` as `select *` reads it (the reference of a full-row result). */
export async function orderRow(db: Kysely<DB>, orderId: string) {
  return db
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

/** Rows of each app in each app.orders partition: { partition: { app_id: rows } }. */
export async function layout(db: Kysely<DB>): Promise<Record<string, Record<string, number>>> {
  const rows = await sql<{ part: string; app_id: string; n: string | bigint }>`
    SELECT tableoid::regclass::text AS part, app_id, count(*)::int8 AS n
    FROM app.orders GROUP BY 1, 2
  `.execute(db);
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows.rows) {
    const part = row.part.replace(/^app\./, '');
    out[part] = { ...(out[part] ?? {}), [row.app_id]: Number(row.n) };
  }
  return out;
}

/** The partitions of app.orders, ordered by name. */
export async function orderPartitions(db: Kysely<DB>): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT c.relname::text AS name
    FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
    WHERE h.inhparent = 'app.orders'::regclass
    ORDER BY c.relname COLLATE "C"
  `.execute(db);
  return rows.rows.map((row) => row.name);
}

/**
 * The background the scan assertions rely on: orders_default and both month partitions exist, and
 * each holds BACKGROUND_PER_PARTITION orders of each app at least. Call before measuring (it reads
 * app.orders itself, so never inside the measured transaction).
 */
export async function expectBackground(world: World): Promise<void> {
  const partitions = await orderPartitions(world.app);
  const months = MONTHS.map((m) => `orders_p${m.slice(0, 4)}${m.slice(5, 7)}`);
  expect(partitions).toEqual(expect.arrayContaining(['orders_default', ...months]));
  const rows = await layout(world.app);
  for (const partition of ['orders_default', ...months]) {
    for (const appId of [world.appId, world.otherAppId]) {
      expect(rows[partition]?.[appId] ?? 0, `${appId} rows in ${partition}`).toBeGreaterThanOrEqual(
        BACKGROUND_PER_PARTITION,
      );
    }
  }
}

interface Counters {
  readonly seq: number;
  readonly idx: number;
  readonly read: number;
}

async function counters(trx: Transaction<DB>): Promise<Map<string, Counters>> {
  const rows = await sql<{
    relname: string;
    seq_scan: string | bigint;
    idx_scan: string | bigint;
    tup_read: string | bigint;
  }>`
    SELECT s.relname::text AS relname,
      coalesce(s.seq_scan, 0)::int8 AS seq_scan,
      coalesce(s.idx_scan, 0)::int8 AS idx_scan,
      (coalesce(s.seq_tup_read, 0) + coalesce(s.idx_tup_fetch, 0))::int8 AS tup_read
    FROM pg_stat_xact_user_tables s
    WHERE s.relid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'app.orders'::regclass)
  `.execute(trx);
  return new Map(
    rows.rows.map((row) => [
      row.relname,
      { seq: Number(row.seq_scan), idx: Number(row.idx_scan), read: Number(row.tup_read) },
    ]),
  );
}

export interface Measured<T> {
  readonly result: T;
  /** Partitions of app.orders whose seq_scan grew, with the growth (empty when none did). */
  readonly seqScans: Record<string, number>;
  /** Growth of idx_scan over every partition. */
  readonly indexScans: number;
  /** Rows read from app.orders over every partition (seq_tup_read + idx_tup_fetch growth). */
  readonly rowsRead: number;
  /** Partitions measured. */
  readonly partitions: readonly string[];
}

/**
 * Runs `call` in one transaction of couli_app, between two reads of the pg_stat_xact_user_tables
 * counters of the app.orders partitions, and commits (the calls under test only read).
 */
export async function measure<T>(
  world: World,
  call: (trx: Transaction<DB>) => Promise<T>,
): Promise<Measured<T>> {
  return world.app.transaction().execute(async (trx) => {
    const before = await counters(trx);
    const result = await call(trx);
    const after = await counters(trx);
    const seqScans: Record<string, number> = {};
    let indexScans = 0;
    let rowsRead = 0;
    for (const [name, end] of after) {
      const start = before.get(name) ?? { seq: 0, idx: 0, read: 0 };
      if (end.seq !== start.seq) seqScans[name] = end.seq - start.seq;
      indexScans += end.idx - start.idx;
      rowsRead += end.read - start.read;
    }
    return { result, seqScans, indexScans, rowsRead, partitions: [...after.keys()].sort() };
  });
}

/**
 * The call read app.orders by key: no partition was scanned sequentially and at most READ_BOUND
 * rows were read. `hit`: the call found orders rows, so app.orders was read through an index.
 */
export function expectKeyedRead(measured: Measured<unknown>, hit: boolean): void {
  expect(measured.partitions.length, 'app.orders partitions measured').toBeGreaterThanOrEqual(3);
  expect(measured.seqScans, 'sequential scans of app.orders partitions').toEqual({});
  expect(measured.rowsRead, 'rows read from app.orders').toBeLessThanOrEqual(READ_BOUND);
  if (hit) expect(measured.indexScans, 'index scans of app.orders').toBeGreaterThan(0);
}

/**
 * `measure` + `expectKeyedRead`, returning the call's result for the result assertions that follow.
 * `hit` tells from the result whether the call found orders rows.
 */
export async function keyedRead<T>(
  world: World,
  call: (trx: Transaction<DB>) => Promise<T>,
  hit: (result: T) => boolean,
): Promise<T> {
  const measured = await measure(world, call);
  expectKeyedRead(measured, hit(measured.result));
  return measured.result;
}

/**
 * Runs `call` in a transaction of couli_app without measuring it: only for the pdd hyphen-stripped
 * fallback, which keeps comparing replace(col, '-', '') and has no index (FU-PDD-ORDERNO-
 * NORMALIZED-INDEX), so its scans are not bounded by this task.
 */
export async function inTransaction<T>(
  world: World,
  call: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return world.app.transaction().execute(call);
}
