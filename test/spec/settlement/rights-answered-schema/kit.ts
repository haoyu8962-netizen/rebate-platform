// B2-04lb rule tests (money r1 S0; 编排裁定 D10-483): storage contract of order_rights.answered_at.
// The union's updated commission (a new estimate on the order sync, or a new settlement record)
// that absorbed a rights deduction sets answered_at on the same transaction; the deduction total
// before credit only counts rows with answered_at empty. Only the column is added: timestamptz,
// NULL allowed, no default (an instant comes from the injected Clock), no backfill (existing rows
// stay NULL). Grants: settlement's writer couli_app may UPDATE answered_at; every other grant on
// the table stays as on main (couli_app SELECT / INSERT / UPDATE, couli_readonly SELECT, nothing
// for couli_payout and couli_maint).
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const ROLES = ['couli_app', 'couli_payout', 'couli_readonly', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;
interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: Database;
  app: Connection;
  roles: Record<Role, Connection>;
}

/** The instant written into answered_at by the cases (any fixed instant; no SQL clock). */
export const ANSWERED_AT = new Date('2032-07-26T02:00:00Z');

// [Postgres type, nullable, default] of every column of app.order_rights: main's columns as in
// db/schema.sql, plus answered_at.
export const SHAPE: Record<string, readonly [string, boolean, string | null]> = {
  id: ['uuid', false, null],
  app_id: ['text', false, null],
  order_id: ['uuid', false, null],
  source: ['text', false, null],
  type: ['text', false, null],
  status: ['text', false, null],
  amount_fen: ['int8', true, null],
  deduction_commission_fen: ['int8', true, null],
  occurred_at: ['timestamptz', false, null],
  platform_rights_no: ['text', true, null],
  row_version: ['int4', false, '0'],
  created_at: ['timestamptz', false, 'now()'],
  updated_at: ['timestamptz', false, 'now()'],
  answered_at: ['timestamptz', true, null],
  reason_sub: ['text', true, null],
  reason_sub_manual: ['bool', false, 'false'],
};

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

export async function columns(db: Connection) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; default_expr: string | null }>`
      SELECT a.attname::text AS name, t.typname::text AS type, NOT a.attnotnull AS nullable,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('app.order_rights') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`.execute(db)
  ).rows;
}

// Every case calls this first: without the migration the case fails on an assertion, not on SQL
// that references a missing column.
export async function ready(db: Connection): Promise<void> {
  expect((await columns(db)).map((c) => c.name)).toContain('answered_at');
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23505', '23514', '42501'].includes(code))
      throw error;
    return code;
  }
}

/** A new order key of a fresh app (the FK target of order_rights); returns app_id and order_id. */
export async function orderKey(db: Connection): Promise<{ appId: string; orderId: string }> {
  const appId = `b204lb-${randomUUID()}`;
  const orderId = randomUUID();
  const at = new Date('2032-06-20T02:00:00Z');
  await db
    .insertInto('order_keys')
    .values({
      app_id: appId,
      order_id: orderId,
      platform: 'taobao',
      sub_order_id: `sub-${randomUUID()}`,
      attr_at: at,
      created_at: at,
    })
    .execute();
  return { appId, orderId };
}

/** One order_rights row as main's writers insert it: answered_at not named. */
export function rights(appId: string, orderId: string, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: appId,
    order_id: orderId,
    source: 'IMPORT',
    type: 'RIGHTS',
    status: 'SUCCEEDED',
    amount_fen: null,
    deduction_commission_fen: 400n,
    occurred_at: new Date('2032-07-20T01:00:00Z'),
    platform_rights_no: `rights-${randomUUID()}`,
    ...values,
  };
}

export async function insert(db: Connection, row: Row): Promise<void> {
  await sql`INSERT INTO app.order_rights
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function update(db: Connection, id: unknown, values: Row): Promise<void> {
  await sql`UPDATE app.order_rights SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}

export async function stored(db: Connection, id: unknown): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM app.order_rights WHERE id = ${id}`.execute(db)).rows;
}
