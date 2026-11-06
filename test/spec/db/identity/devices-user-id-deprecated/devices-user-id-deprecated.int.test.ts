// B1-02zzb (FU-DEVICES-USER-ID-COLUMN, 编排 D10-730): app.devices.user_id is never written in
// production (registration inserts NULL, nothing updates it); device ownership comes from
// app.sessions (D10-571 / D10-585). One new migration marks the column deprecated with
// COMMENT ON COLUMN and revokes couli_readonly's column-level SELECT(user_id) granted in 0013.
// The column, its foreign key devices_user_fkey, every other grant and couli_app's table-level
// grant stay as they are. The one-off database comes from the integration global setup (all
// migrations applied); queries run only as business roles. Every test first checks that the
// migration landed (the deprecation comment), so before it lands each test fails an assertion.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, hex64, insertRow, newUser, sqlState, useDb } from '../kit.ts';

const DENIED = '42501';
const FK_VIOLATION = '23503';
const DEPRECATED = /弃用|deprecated/i;
const SEEN = new Date('2026-11-06T02:00:00.000Z');
// couli_readonly's column-level SELECT on app.devices before this task (0013): every column
// except install_secret_cipher. After it, user_id is no longer readable either.
const DEVICE_COLUMNS = [
  ['id', 'uuid', false, false],
  ['app_id', 'text', false, false],
  ['user_id', 'uuid', true, false],
  ['device_hash', 'text', false, false],
  ['id_source', 'text', false, false],
  ['platform', 'text', false, false],
  ['app_version', 'text', false, false],
  ['last_login_sid', 'text', true, false],
  ['revoked_at', 'timestamptz', true, false],
  ['last_seen_at', 'timestamptz', false, false],
  ['row_version', 'int4', false, true],
  ['created_at', 'timestamptz', false, true],
  ['updated_at', 'timestamptz', false, true],
  ['install_secret_cipher', 'bytea', false, false],
] as const;
const READONLY_UNREADABLE = ['user_id', 'install_secret_cipher'];
const READONLY_READABLE = DEVICE_COLUMNS.map(([name]) => name).filter(
  (name) => !READONLY_UNREADABLE.includes(name),
);

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await Promise.all([app, readonly].filter(Boolean).map((db) => destroyDb(db)));
  if (database) await database.drop();
});

async function userIdComment(): Promise<string | null> {
  const result = await sql<{ comment: string | null }>`
    SELECT col_description(a.attrelid, a.attnum) AS comment
    FROM pg_attribute a
    WHERE a.attrelid = 'app.devices'::regclass AND a.attname = 'user_id' AND NOT a.attisdropped
  `.execute(app);
  expect(result.rows, 'app.devices.user_id exists').toHaveLength(1);
  return result.rows[0]!.comment;
}

/** Preflight: the migration of this task has landed (user_id carries a deprecation comment). */
async function migrated(): Promise<void> {
  const comment = await userIdComment();
  // Before the migration the comment is NULL; assert the type first so that fails an assertion.
  expect(typeof comment, '迁移前置：COMMENT ON COLUMN app.devices.user_id is set').toBe('string');
  expect(comment, 'app.devices.user_id is commented as deprecated').toMatch(DEPRECATED);
}

async function newDevice(userId: string | null = null): Promise<{ id: string; hash: string }> {
  const id = randomUUID();
  const hash = hex64();
  await insertRow('devices', {
    id,
    app_id: 'couli',
    user_id: userId,
    device_hash: hash,
    id_source: 'idfv',
    platform: 'ios',
    app_version: '1.0.0',
    last_seen_at: SEEN,
    install_secret_cipher: Buffer.from('fixture-encrypted-install-secret'),
  });
  return { id, hash };
}

it('[AC-B1-02zzb#1] devices.user_id carries a non-empty column comment that marks it deprecated', async () => {
  const comment = await userIdComment();
  expect(typeof comment, 'COMMENT ON COLUMN app.devices.user_id is set').toBe('string');
  expect(comment!.trim().length).toBeGreaterThan(0);
  expect(comment).toMatch(DEPRECATED);
});

it('[AC-B1-02zzb#2] the column stays: devices keeps every column, user_id is still a nullable uuid without default', async () => {
  await migrated();
  expect(await columns('devices')).toEqual(
    DEVICE_COLUMNS.map(([name, type, nullable, hasDefault]) => ({
      name,
      type,
      nullable,
      hasDefault,
    })),
  );
});

it('[AC-B1-02zzb#3] devices_user_fkey and the other devices constraints are unchanged and still enforced', async () => {
  await migrated();
  // Fix the deparser search_path so the FK target is schema-qualified on every connection.
  const result = await app.transaction().execute(async (tx) => {
    await sql`SET LOCAL search_path = pg_catalog`.execute(tx);
    return sql<{ name: string; definition: string; validated: boolean }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition, convalidated AS validated
      FROM pg_constraint WHERE conrelid = 'app.devices'::regclass
        AND contype IN ('p', 'u', 'f', 'c')
      ORDER BY conname`.execute(tx);
  });
  expect(result.rows.map((row) => row.name)).toEqual([
    'devices_device_hash_check',
    'devices_id_source_check',
    'devices_install_secret_present_check',
    'devices_pkey',
    'devices_user_fkey',
  ]);
  expect(result.rows.find((row) => row.name === 'devices_user_fkey')).toEqual({
    name: 'devices_user_fkey',
    definition: 'FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id)',
    validated: true,
  });
  expect(result.rows.find((row) => row.name === 'devices_pkey')?.definition).toBe(
    'PRIMARY KEY (id)',
  );
  expect(await sqlState(newDevice(randomUUID())), 'unknown user is still rejected').toBe(
    FK_VIOLATION,
  );
  expect(await sqlState(newDevice(await newUser())), 'existing user is still accepted').toBe(
    'no error',
  );
});

it('[AC-B1-02zzb#4] couli_readonly loses SELECT on user_id only; every other originally granted column stays readable', async () => {
  await migrated();
  const result = await sql<{ name: string; can_select: boolean; can_write: boolean }>`
    SELECT a.attname AS name,
      has_column_privilege('couli_readonly', a.attrelid, a.attnum, 'SELECT') AS can_select,
      has_column_privilege('couli_readonly', a.attrelid, a.attnum, 'INSERT')
        OR has_column_privilege('couli_readonly', a.attrelid, a.attnum, 'UPDATE')
        OR has_column_privilege('couli_readonly', a.attrelid, a.attnum, 'REFERENCES')
        AS can_write
    FROM pg_attribute a WHERE a.attrelid = 'app.devices'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
  `.execute(app);
  expect(result.rows).toEqual(
    DEVICE_COLUMNS.map(([name]) => ({
      name,
      can_select: !READONLY_UNREADABLE.includes(name),
      can_write: false,
    })),
  );
  const direct = await sql<{ allowed: boolean }>`
    SELECT has_column_privilege('couli_readonly', 'app.devices', 'user_id', 'SELECT') AS allowed
  `.execute(app);
  expect(direct.rows).toEqual([{ allowed: false }]);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']) {
    const table = await sql<{ allowed: boolean }>`
      SELECT has_table_privilege('couli_readonly', 'app.devices', ${privilege}) AS allowed
    `.execute(app);
    expect(table.rows, `couli_readonly table ${privilege}`).toEqual([{ allowed: false }]);
  }
});

it('[AC-B1-02zzb#5] as couli_readonly, reading or filtering on user_id is denied while the other columns read normally', async () => {
  await migrated();
  const device = await newDevice();
  for (const statement of [
    sql`SELECT user_id FROM app.devices WHERE id = ${device.id}`,
    sql`SELECT id FROM app.devices WHERE user_id IS NULL AND id = ${device.id}`,
    sql`SELECT count(user_id) AS n FROM app.devices`,
  ]) {
    expect(await sqlState(statement.execute(readonly))).toBe(DENIED);
  }
  const pair = await sql<{ id: string; device_hash: string }>`
    SELECT id, device_hash FROM app.devices WHERE id = ${device.id}
  `.execute(readonly);
  expect(pair.rows).toEqual([{ id: device.id, device_hash: device.hash }]);
  const all = await sql<Record<string, unknown>>`
    SELECT ${sql.join(READONLY_READABLE.map((name) => sql.ref(name)))}
    FROM app.devices WHERE id = ${device.id}
  `.execute(readonly);
  expect(all.rows).toHaveLength(1);
  expect(Object.keys(all.rows[0]!).sort()).toEqual([...READONLY_READABLE].sort());
  expect(all.rows[0]).toMatchObject({
    id: device.id,
    app_id: 'couli',
    device_hash: device.hash,
    id_source: 'idfv',
    platform: 'ios',
    app_version: '1.0.0',
    last_login_sid: null,
    revoked_at: null,
    last_seen_at: SEEN,
    row_version: 0,
  });
});

it('[AC-B1-02zzb#6] couli_app keeps table-level SELECT / INSERT / UPDATE / DELETE on devices, including user_id', async () => {
  await migrated();
  for (const privilege of [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER',
    'MAINTAIN',
  ]) {
    const table = await sql<{ allowed: boolean }>`
      SELECT has_table_privilege('couli_app', 'app.devices', ${privilege}) AS allowed
    `.execute(app);
    expect(table.rows, `couli_app table ${privilege}`).toEqual([
      { allowed: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege) },
    ]);
  }
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
    const column = await sql<{ allowed: boolean }>`
      SELECT has_column_privilege('couli_app', 'app.devices', 'user_id', ${privilege}) AS allowed
    `.execute(app);
    expect(column.rows, `couli_app user_id ${privilege}`).toEqual([{ allowed: true }]);
  }
});

it('[AC-B1-02zzb#7] couli_app still inserts with user_id = NULL, reads it back, updates and deletes the row', async () => {
  await migrated();
  const device = await newDevice(null);
  const read = await sql<{ user_id: string | null; device_hash: string }>`
    SELECT user_id, device_hash FROM app.devices WHERE id = ${device.id}
  `.execute(app);
  expect(read.rows).toEqual([{ user_id: null, device_hash: device.hash }]);
  const later = new Date('2026-11-06T03:00:00.000Z');
  const updated = await sql<{ user_id: string | null; last_seen_at: Date; row_version: number }>`
    UPDATE app.devices
    SET last_seen_at = ${later}, row_version = row_version + 1, user_id = NULL
    WHERE id = ${device.id}
    RETURNING user_id, last_seen_at, row_version
  `.execute(app);
  expect(updated.rows).toEqual([{ user_id: null, last_seen_at: later, row_version: 1 }]);
  const deleted = await sql<{ id: string }>`
    DELETE FROM app.devices WHERE id = ${device.id} RETURNING id
  `.execute(app);
  expect(deleted.rows).toEqual([{ id: device.id }]);
});

it('[AC-B1-02zzb#8] couli_payout and couli_maint still have no privilege on devices', async () => {
  await migrated();
  for (const role of ['couli_payout', 'couli_maint']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const columnPrivilege = ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)
        ? sql<boolean>`has_any_column_privilege(${role}, 'app.devices', ${privilege})`
        : sql<boolean>`false`;
      const result = await sql<{ allowed: boolean }>`
        SELECT has_table_privilege(${role}, 'app.devices', ${privilege})
          OR ${columnPrivilege} AS allowed
      `.execute(app);
      expect(result.rows, `${role} devices ${privilege}`).toEqual([{ allowed: false }]);
    }
  }
});
