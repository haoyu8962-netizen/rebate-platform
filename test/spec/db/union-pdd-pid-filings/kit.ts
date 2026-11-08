// B1-06zh fixtures (FU-PDD-BINDING-PID first order, D10-1097 (B)): app.union_pdd_pid_filings
// records the Pinduoduo filing fact per (app_id, user_id, pid) — "authority.query answered
// filed at filed_at, using union_account_id". union_bindings is untouched by this order.
// Catalog-driven insert helpers come from the frozen B1-06a kit (imported, not modified).
// Every test asserts the table exists first, so a missing migration is an AssertionError,
// never a PostgreSQL undefined_table error.
import { randomInt, randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { columns, insertRow, newUser, useDb } from '../linking/kit.ts';

export { columns, insertRow, newUser, sqlState } from '../linking/kit.ts';

export const TABLE = 'union_pdd_pid_filings';
export const QUALIFIED = `app.${TABLE}`;
export const TIMEOUT = 30_000;
/** authority.query answered "filed" at this instant (supplied by the caller's Clock). */
export const FILED = new Date('2026-10-01T08:00:00Z');
export const LATER = new Date('2026-10-02T08:00:00Z');

let app: Kysely<DB>;

export function connect(db: Kysely<DB>): void {
  app = db;
  useDb(db);
}

export async function requireTable(table: string = TABLE): Promise<void> {
  const result = await sql<{ kind: string }>`
    SELECT c.relkind::text AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table}
  `.execute(app);
  expect(result.rows, `app.${table} must exist as an ordinary table`).toEqual([{ kind: 'r' }]);
}

export async function shape(
  name: string,
  type: string,
  nullable: boolean,
  hasDefault?: boolean,
): Promise<void> {
  const column = (await columns(TABLE)).find((c) => c.name === name);
  expect(column, `${TABLE}.${name}`).toBeDefined();
  expect(column?.type, `${TABLE}.${name} type`).toBe(type);
  expect(column?.nullable, `${TABLE}.${name} nullable`).toBe(nullable);
  if (hasDefault !== undefined) {
    expect(column?.hasDefault, `${TABLE}.${name} has default`).toBe(hasDefault);
  }
}

export type ForeignKey = {
  target: string;
  source: string[];
  referenced: string[];
  on_delete: string;
  on_update: string;
  validated: boolean;
};

export async function foreignKeys(table: string = TABLE): Promise<ForeignKey[]> {
  const result = await sql<ForeignKey>`
    SELECT ft.relname AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.ord) AS source,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.ord) AS referenced,
      c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update,
      c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class ft ON ft.oid = c.confrelid
    JOIN pg_namespace fn ON fn.oid = ft.relnamespace
    WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'
      AND fn.nspname = 'app'
  `.execute(app);
  return result.rows;
}

export type UniqueKey = { keys: string[]; partial: boolean; primary: boolean };

/** Valid unique indexes of the table: sorted key columns, partial flag, primary flag. */
export async function uniqueKeys(table: string = TABLE): Promise<UniqueKey[]> {
  const result = await sql<{ keys: string[]; partial: boolean; primary: boolean }>`
    SELECT ARRAY(SELECT a.attname::text
      FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      (i.indpred IS NOT NULL) AS "partial", i.indisprimary AS "primary"
    FROM pg_index i WHERE i.indrelid = to_regclass(${`app.${table}`})
      AND i.indisunique AND i.indisvalid AND i.indisready
  `.execute(app);
  return result.rows.map((row) => ({ ...row, keys: [...row.keys].sort() }));
}

/** A Pinduoduo-style pid ("<media>_<position>"), unique per call for test isolation. */
export function newPid(): string {
  const media = String(randomInt(1_000_000, 10_000_000));
  const position = String(randomInt(100_000_000, 1_000_000_000));
  return `${media}_${position}`;
}

/** A union_accounts row (Pinduoduo unless stated) and its id. */
export async function newAccount(appId = 'couli', platform = 'pdd'): Promise<string> {
  await requireTable('union_accounts');
  const row = await insertRow('union_accounts', { id: randomUUID(), app_id: appId, platform });
  return String(row['id']);
}

/**
 * Inserts one filing. Explicit keys in `values` win, including explicit NULLs (so NOT NULL
 * probes reach PostgreSQL); unknown extra NOT NULL columns are filled from the catalog.
 */
export async function newFiling(
  values: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  await requireTable();
  const appId = 'app_id' in values ? values['app_id'] : 'couli';
  const fixtureApp = typeof appId === 'string' ? appId : 'couli';
  const row: Record<string, unknown> = {
    id: randomUUID(),
    app_id: appId,
    pid: newPid(),
    filed_at: FILED,
    ...values,
  };
  if (!('user_id' in values)) row['user_id'] = await newUser({ app_id: fixtureApp });
  if (!('union_account_id' in values)) row['union_account_id'] = await newAccount(fixtureApp);
  return insertRow(TABLE, row);
}

export async function stored(id: unknown): Promise<Record<string, unknown>[]> {
  const result = await sql<Record<string, unknown>>`
    SELECT * FROM app.union_pdd_pid_filings WHERE id = ${id}
  `.execute(app);
  return result.rows;
}
