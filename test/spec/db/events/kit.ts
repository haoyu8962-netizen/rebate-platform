// CT-13e: SQL fixtures avoid depending on generated types before migration 0140.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Row = Record<string, unknown>;
export type Table = 'events' | 'event_dedup';
export interface TestDatabaseLike {
  urlFor(role: 'couli_app' | 'couli_maint'): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: TestDatabaseLike;
  app: Kysely<DB>;
  maint: Kysely<DB>;
}

export async function open(createTestDatabase: () => Promise<TestDatabaseLike>): Promise<Harness> {
  const database = await createTestDatabase();
  return {
    database,
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    maint: createDb({ connectionString: database.urlFor('couli_maint'), max: 2 }),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([destroyDb(h.app), destroyDb(h.maint)]);
  await h.database.drop();
}

// Missing migrations must produce assertion failures, not uncaught undefined_table errors.
export async function ready(h: Harness): Promise<void> {
  const result = await sql`SELECT to_regclass('app.events')::text AS events,
    to_regclass('app.event_dedup')::text AS dedup`.execute(h.app);
  expect(result.rows).toEqual([{ events: 'app.events', dedup: 'app.event_dedup' }]);
}

export async function state(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String(error.code);
    }
    throw error;
  }
}

export async function insert(db: Kysely<DB>, table: string, row: Row): Promise<Row> {
  const result = await sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))}) RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export function event(overrides: Row = {}): Row {
  return {
    app_id: 'couli',
    event_type: 'page_view',
    event_id: randomUUID(),
    name: 'page_view',
    props: JSON.stringify({ page: 'home', version: 1 }),
    user_id: null,
    device_id: null,
    client_at: '2026-11-01T00:00:00Z',
    server_at: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

export function dedup(overrides: Row = {}): Row {
  return {
    app_id: 'couli',
    event_type: 'page_view',
    event_id: randomUUID(),
    created_at: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

export async function person(h: Harness): Promise<string> {
  const id = randomUUID();
  await insert(h.app, 'users', {
    id,
    app_id: 'couli',
    nickname: 'fixture',
    avatar: 'fixture',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    register_method: 'phone',
  });
  return id;
}

export async function read(h: Harness, table: Table, id: unknown): Promise<Row[]> {
  return (
    await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)} WHERE event_id = ${id}`.execute(h.app)
  ).rows;
}

export function update(h: Harness, table: Table, id: unknown, values: Row) {
  return sql`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE event_id = ${id}`.execute(h.app);
}

export async function ensure(h: Harness, table: string, day: string): Promise<void> {
  const statement =
    table === 'events'
      ? sql`SELECT app.ensure_events_day_partition(${day}::date)`
      : sql`SELECT app.ensure_day_partition(${table}, ${day}::date)`;
  const result = statement.execute(h.maint);
  expect(await state(result), `${table}/${day}`).toBe('ok');
}

export async function partitions(h: Harness, table: string) {
  return (
    await sql<{ name: string; bound: string }>`SELECT c.relname::text AS name,
      pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = to_regclass(${`app.${table}`}) ORDER BY c.relname`.execute(h.app)
  ).rows;
}
