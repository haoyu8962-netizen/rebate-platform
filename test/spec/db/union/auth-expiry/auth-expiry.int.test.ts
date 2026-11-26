// B1-22a: BR-ID-24, 04 §3.2 and task §9 (SPEC_REF eabcf00).
// Storage only: OAuth, ten-minute lifetime calculation, probes, SMS and audit belong to services.
// The admin connection is opened only by the global setup; workers use only business roles and catalog assertions.
import { createHash, randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, foreignKeys, keys } from '../../admin/kit.ts';
import { insertRow, sqlState } from '../kit.ts';

const TABLE = 'admin_union_auth_sessions';
const CREATED = new Date('2026-10-22T01:00:00.000Z');
const EXPIRES = new Date('2026-10-22T01:10:00.000Z');
const FINISHED = new Date('2026-10-22T01:02:00.000Z');
const SESSION_COLUMNS = [
  ['id', 'uuid', false],
  ['app_id', 'text', false],
  ['union_account_id', 'uuid', false],
  ['state_hash', 'bytea', false],
  ['created_by', 'uuid', false],
  ['expires_at', 'timestamptz', false],
  ['used_at', 'timestamptz', true],
  ['status', 'text', false],
  ['error', 'text', true],
  ['created_at', 'timestamptz', false],
  ['finished_at', 'timestamptz', true],
  ['updated_at', 'timestamptz', false],
] as const;

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
});

afterAll(async () => {
  if (readonly) await destroyDb(readonly);
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

// Fixed timestamp UUIDv7 fixtures: no wall clock and no application implementation imported.
function id(): string {
  return `019a09c3-4680-7${randomUUID().slice(15)}`;
}

async function sessionColumns() {
  // Assert before touching the absent table: pre-migration red must be an assertion failure.
  const found = await columns(app, TABLE);
  for (const [name, type, nullable] of SESSION_COLUMNS)
    expect(
      found.find((c) => c.name === name),
      name,
    ).toMatchObject({ type, nullable });
  return found;
}

async function fixture(): Promise<Record<string, unknown>> {
  await sessionColumns();
  const account = await insertRow(app, 'union_accounts', { id: id(), app_id: 'couli' });
  const adminId = id();
  await sql`
    INSERT INTO app.admin_users
      (id, app_id, login_name, password_hash, is_super, status, created_at, updated_at)
    VALUES (${adminId}, 'couli', ${`auth-expiry-${adminId}`}, 'synthetic-hash', false,
      'active', ${CREATED}, ${CREATED})
  `.execute(app);
  return {
    id: id(),
    app_id: 'couli',
    union_account_id: account['id'],
    state_hash: createHash('sha256').update(randomUUID()).digest(),
    created_by: adminId,
    expires_at: EXPIRES,
    used_at: null,
    status: 'pending',
    error: null,
    created_at: CREATED,
    finished_at: null,
    updated_at: CREATED,
  };
}

async function insertSession(row: Record<string, unknown>) {
  const names = Object.keys(row);
  return sql<Record<string, unknown>>`
    INSERT INTO app.admin_union_auth_sessions (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))}) RETURNING *
  `.execute(app);
}

async function updateSession(sessionId: unknown, values: Record<string, unknown>) {
  return sql<Record<string, unknown>>`
    UPDATE app.admin_union_auth_sessions
    SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${sessionId} RETURNING *
  `.execute(app);
}

it('[AC-B1-22a#1] estimated expiry is NOT NULL boolean, defaults false and is writable by couli_app', async () => {
  const cols = await columns(app, 'union_accounts');
  expect(cols.find((c) => c.name === 'auth_expires_estimated')).toMatchObject({
    type: 'bool',
    nullable: false,
    defaulted: true,
  });
  const row = await insertRow(app, 'union_accounts', {}, ['auth_expires_estimated']);
  expect(row['auth_expires_estimated']).toBe(false);
  expect(row['alert_stage']).toBe('none');
  for (const value of [true, false]) {
    const changed = await sql<{ auth_expires_estimated: boolean }>`
      UPDATE app.union_accounts SET auth_expires_estimated = ${value}
      WHERE id = ${row['id']} RETURNING auth_expires_estimated
    `.execute(app);
    expect(changed.rows).toEqual([{ auth_expires_estimated: value }]);
  }
  expect(await sqlState(insertRow(app, 'union_accounts', { auth_expires_estimated: null }))).toBe(
    '23502',
  );
  expect(
    await sqlState(
      sql`
    UPDATE app.union_accounts SET auth_expires_estimated = NULL WHERE id = ${row['id']}
  `.execute(app),
    ),
  ).toBe('23502');
});

it('[AC-B1-22a#2] reminder stages accept configurable days 1–999 and reject malformed values on insert/update', async () => {
  for (const value of ['none', 'expired', 'd1', 'd7', 'd14', 'd30', 'd999', 'd2', 'd10', 'd100'])
    expect(await sqlState(insertRow(app, 'union_accounts', { alert_stage: value })), value).toBe(
      'no error',
    );
  const row = await insertRow(app, 'union_accounts', {}, ['alert_stage']);
  expect(row['alert_stage']).toBe('none');
  for (const value of ['d30', 'd999', 'd1', 'expired', 'none']) {
    const changed = await sql<{ alert_stage: string }>`
      UPDATE app.union_accounts SET alert_stage = ${value}
      WHERE id = ${row['id']} RETURNING alert_stage
    `.execute(app);
    expect(changed.rows).toEqual([{ alert_stage: value }]);
  }
  for (const value of [
    'd0',
    'd',
    'd1000',
    'd014',
    'D14',
    'expiring',
    '',
    'd-1',
    'd 7',
    'd7\n',
    'xd7',
  ]) {
    expect(await sqlState(insertRow(app, 'union_accounts', { alert_stage: value })), value).toBe(
      '23514',
    );
    expect(
      await sqlState(
        sql`
      UPDATE app.union_accounts SET alert_stage = ${value} WHERE id = ${row['id']}
    `.execute(app),
      ),
      value,
    ).toBe('23514');
  }
  // Regression: changing reminder encoding must not widen auth_status.
  for (const auth_status of ['active', 'expiring', 'expired'])
    expect(await sqlState(insertRow(app, 'union_accounts', { auth_status }))).toBe('no error');
  for (const auth_status of ['none', 'pending', 'd30', 'ACTIVE', ''])
    expect(await sqlState(insertRow(app, 'union_accounts', { auth_status }))).toBe('23514');
  // Freeze the existing credential column contract, independently of regenerated snapshots.
  const credentialColumns = [
    ['id', 'uuid', false, false],
    ['app_id', 'text', false, false],
    ['union_account_id', 'uuid', false, false],
    ['access_token_cipher', 'bytea', false, false],
    ['refresh_token_cipher', 'bytea', true, false],
    ['expires_at', 'timestamptz', true, false],
    ['is_current', 'bool', false, false],
    ['created_at', 'timestamptz', false, true],
    ['updated_at', 'timestamptz', false, true],
    ['re_expires_in_s', 'int4', true, false],
    ['r1_expires_in_s', 'int4', true, false],
    ['r2_expires_in_s', 'int4', true, false],
    ['w1_expires_in_s', 'int4', true, false],
    ['w2_expires_in_s', 'int4', true, false],
  ] as const;
  expect(await columns(app, 'union_credentials')).toEqual(
    credentialColumns.map(([name, type, nullable, defaulted]) => ({
      name,
      type,
      nullable,
      defaulted,
    })),
  );
  const credential = await insertRow(app, 'union_credentials', { expires_at: EXPIRES });
  expect(
    (
      await sql<Record<string, unknown>>`
    SELECT * FROM app.union_credentials WHERE id = ${credential['id']}
  `.execute(app)
    ).rows,
  ).toEqual([credential]);
});

it('[AC-B1-22a#3] sessions have the required columns, UUID primary key, no plaintext state or SQL-generated identity/time', async () => {
  const cols = await sessionColumns();
  expect(
    cols.filter(
      (c) =>
        c.name === 'state' ||
        (c.type === 'text' && c.name.includes('state') && !c.name.includes('hash')),
    ),
  ).toEqual([]);
  for (const c of cols.filter((c) => c.name === 'id' || c.type === 'timestamptz'))
    expect(c.defaulted, `${c.name} is supplied by the application`).toBe(false);
  expect((await keys(app, TABLE)).filter((k) => k.primary)).toEqual([
    { columns: ['id'], primary: true, partial: false, expression: false },
  ]);
  const row = await fixture();
  delete row['status'];
  const inserted = await insertSession(row);
  expect(inserted.rows).toEqual([{ ...row, status: 'pending' }]);
  expect(
    await sqlState(
      insertSession({
        ...row,
        state_hash: createHash('sha256').update('different-state').digest(),
      }),
    ),
  ).toBe('23505');
  for (const [name, , nullable] of SESSION_COLUMNS) {
    if (!nullable)
      expect(await sqlState(insertSession({ ...row, id: id(), [name]: null })), name).toBe('23502');
  }
});

it('[AC-B1-22a#4] state_hash stores exactly 32 bytes and remains globally unique across accounts/apps', async () => {
  const row = await fixture();
  expect((await insertSession(row)).rows[0]?.['state_hash']).toEqual(row['state_hash']);
  expect(await sqlState(insertSession({ ...row, id: id() }))).toBe('23505');
  const otherAccount = await insertRow(app, 'union_accounts', { app_id: 'other-app' });
  expect(
    await sqlState(
      insertSession({
        ...row,
        id: id(),
        app_id: 'other-app',
        union_account_id: otherAccount['id'],
      }),
    ),
  ).toBe('23505');
  for (const length of [0, 1, 31, 33, 64]) {
    expect(
      await sqlState(insertSession({ ...row, id: id(), state_hash: Buffer.alloc(length, 5) })),
      String(length),
    ).toBe('23514');
    expect(await sqlState(updateSession(row['id'], { state_hash: Buffer.alloc(length, 5) }))).toBe(
      '23514',
    );
  }
  const second = {
    ...row,
    id: id(),
    state_hash: createHash('sha256').update('second-state').digest(),
  };
  expect((await insertSession(second)).rows).toEqual([second]);
  expect(await sqlState(updateSession(second['id'], { state_hash: row['state_hash'] }))).toBe(
    '23505',
  );
});

it('[AC-B1-22a#5] sessions reference the account within app_id and the initiating admin, without cascading', async () => {
  await sessionColumns();
  const fks = await foreignKeys(app, TABLE);
  expect(fks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        columns: ['app_id', 'union_account_id'],
        targetSchema: 'app',
        target: 'union_accounts',
        targetColumns: ['app_id', 'id'],
        validated: true,
      }),
      expect.objectContaining({
        columns: ['app_id', 'created_by'],
        targetSchema: 'app',
        target: 'admin_users',
        targetColumns: ['app_id', 'id'],
        validated: true,
      }),
    ]),
  );
  for (const fk of fks) {
    expect(['a', 'r'], `${fk.target} ON DELETE`).toContain(fk.onDelete);
    expect(['a', 'r'], `${fk.target} ON UPDATE`).toContain(fk.onUpdate);
  }
  const row = await fixture();
  expect((await insertSession(row)).rows).toEqual([row]);
  const other = await insertRow(app, 'union_accounts', { app_id: 'other-app' });
  const otherAdminId = id();
  await sql`
    INSERT INTO app.admin_users
      (id, app_id, login_name, password_hash, is_super, status, created_at, updated_at)
    VALUES (${otherAdminId}, 'other-app', ${`auth-expiry-${otherAdminId}`}, 'synthetic-hash', false,
      'active', ${CREATED}, ${CREATED})
  `.execute(app);
  for (const values of [
    { union_account_id: id() },
    { created_by: id() },
    { app_id: 'other-app' },
    { union_account_id: other['id'] },
    { created_by: otherAdminId },
  ]) {
    expect(
      await sqlState(
        insertSession({
          ...row,
          id: id(),
          state_hash: createHash('sha256').update(randomUUID()).digest(),
          ...values,
        }),
      ),
    ).toBe('23503');
    expect(await sqlState(updateSession(row['id'], values))).toBe('23503');
  }
});

it('[AC-B1-22a#6] only pending/succeeded/failed/expired are accepted and every lifecycle null combination is checked', async () => {
  const base = await fixture();
  // Full truth table catches OR/NULL mistakes, including missing fields in callback failures.
  // Pending may already be claimed by a callback; only finished_at and error must stay null.
  // Expired does not constrain error: it may retain an expiry reason.
  for (const status of ['pending', 'succeeded', 'failed', 'expired']) {
    for (const used of [false, true]) {
      for (const finished of [false, true]) {
        for (const error of [false, true]) {
          const valid =
            status === 'pending'
              ? !finished && !error
              : status === 'succeeded'
                ? used && finished && !error
                : status === 'failed'
                  ? used && finished && error
                  : !used && finished;
          const row = {
            ...base,
            id: id(),
            state_hash: createHash('sha256').update(randomUUID()).digest(),
            status,
            used_at: used ? FINISHED : null,
            finished_at: finished ? FINISHED : null,
            error: error ? 'synthetic-callback-failure' : null,
          };
          expect(
            await sqlState(insertSession(row)),
            `${status}: used=${used}, finished=${finished}, error=${error}`,
          ).toBe(valid ? 'no error' : '23514');
        }
      }
    }
  }
  for (const status of ['', 'PENDING', 'cancelled', 'active'])
    expect(await sqlState(insertSession({ ...base, status })), status).toBe('23514');
  expect((await insertSession(base)).rows).toEqual([base]);
  expect((await updateSession(base['id'], { used_at: FINISHED })).rows).toEqual([
    { ...base, used_at: FINISHED },
  ]);
  for (const values of [{ finished_at: FINISHED }, { error: 'synthetic-callback-failure' }])
    expect(await sqlState(updateSession(base['id'], values))).toBe('23514');
});

it('[AC-B1-22a#7] lifecycle consistency applies to updates, and valid callback/expiry results can be persisted', async () => {
  const base = await fixture();
  for (const status of ['succeeded', 'failed', 'expired']) {
    const pending = {
      ...base,
      id: id(),
      state_hash: createHash('sha256').update(randomUUID()).digest(),
    };
    await insertSession(pending);
    expect(await sqlState(updateSession(pending['id'], { status })), status).toBe('23514');
    const result = {
      status,
      used_at: status === 'expired' ? null : FINISHED,
      finished_at: status === 'expired' ? EXPIRES : FINISHED,
      error: status === 'failed' ? 'synthetic-callback-failure' : null,
      updated_at: EXPIRES,
    };
    expect((await updateSession(pending['id'], result)).rows).toEqual([{ ...pending, ...result }]);
    expect(await sqlState(updateSession(pending['id'], { finished_at: null }))).toBe('23514');
    expect(await sqlState(updateSession(pending['id'], { status: 'pending' }))).toBe('23514');
    expect(await sqlState(updateSession(pending['id'], { status: 'unknown' }))).toBe('23514');
  }
});

it('[AC-B1-22a#8] expiry must be strictly after creation on inserts and updates', async () => {
  const row = await fixture();
  expect((await insertSession(row)).rows).toEqual([row]);
  for (const expires_at of [CREATED, new Date('2026-10-22T00:59:59.999Z')]) {
    expect(
      await sqlState(
        insertSession({
          ...row,
          id: id(),
          state_hash: createHash('sha256').update(randomUUID()).digest(),
          expires_at,
        }),
      ),
    ).toBe('23514');
    expect(await sqlState(updateSession(row['id'], { expires_at }))).toBe('23514');
  }
  expect(await sqlState(updateSession(row['id'], { created_at: EXPIRES }))).toBe('23514');
});

it('[AC-B1-22a#9] an index supports scanning pending sessions by expiry without fixing its name', async () => {
  await sessionColumns();
  const indexes = await sql<{ columns: string[]; predicate: string | null }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indrelid = to_regclass('app.admin_union_auth_sessions')
      AND i.indisvalid AND i.indisready AND i.indexprs IS NULL AND am.amname = 'btree'
  `.execute(app);
  expect(
    indexes.rows.some((index) => {
      const predicate = index.predicate?.replaceAll('::text', '').replace(/[()\s]/g, '');
      const pendingOnly = predicate === "status='pending'" || predicate === "'pending'=status";
      const statusExpiry = index.columns[0] === 'status' && index.columns[1] === 'expires_at';
      return (
        (statusExpiry && (predicate === undefined || pendingOnly)) ||
        (pendingOnly && index.columns[0] === 'expires_at')
      );
    }),
    'status/expires_at index or pending-only expiry index',
  ).toBe(true);
});

it('[AC-B1-22a#10] session grants allow only app reads/writes and readonly non-secret reads', async () => {
  const row = await fixture();
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'TRIGGER',
      'REFERENCES',
    ]) {
      // Include column grants so narrow grants cannot hide forbidden privileges.
      const columnGrant = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)
        ? sql<boolean>`has_any_column_privilege(${role}, ${`app.${TABLE}`}, ${privilege})`
        : sql<boolean>`false`;
      const result = await sql<{ allowed: boolean }>`
        SELECT has_table_privilege(${role}, ${`app.${TABLE}`}, ${privilege})
          OR ${columnGrant} AS allowed
      `.execute(app);
      const expected =
        (role === 'couli_app' && ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)) ||
        (role === 'couli_readonly' && privilege === 'SELECT');
      expect(result.rows[0]?.allowed, `${role} ${TABLE} ${privilege}`).toBe(expected);
    }
  }
  expect((await insertSession(row)).rows).toEqual([row]);
  expect(
    (
      await sql<Record<string, unknown>>`
    SELECT * FROM app.admin_union_auth_sessions WHERE id = ${row['id']}
  `.execute(app)
    ).rows,
  ).toEqual([row]);
  expect((await updateSession(row['id'], { updated_at: FINISHED })).rows).toEqual([
    { ...row, updated_at: FINISHED },
  ]);
  expect(
    await sqlState(
      sql`
    DELETE FROM app.admin_union_auth_sessions WHERE id = ${row['id']}
  `.execute(app),
    ),
  ).toBe('42501');
  expect(await sqlState(sql`TRUNCATE app.admin_union_auth_sessions`.execute(app))).toBe('42501');
  expect(
    (
      await sql<{ id: string }>`
    SELECT id FROM app.admin_union_auth_sessions WHERE id = ${row['id']}
  `.execute(app)
    ).rows,
  ).toEqual([{ id: row['id'] }]);
});

it('[AC-B1-22a#11] couli_readonly reads every non-secret column but cannot select state_hash', async () => {
  const cols = await sessionColumns();
  const row = await fixture();
  await insertSession(row);
  const publicColumns = cols.filter((c) => c.name !== 'state_hash').map((c) => c.name);
  const stored = await sql<Record<string, unknown>>`
    SELECT ${sql.join(publicColumns.map((name) => sql.ref(name)))}
    FROM app.admin_union_auth_sessions WHERE id = ${row['id']}
  `.execute(readonly);
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0]).toMatchObject(
    Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'state_hash')),
  );
  expect(
    await sqlState(
      sql`
    SELECT state_hash FROM app.admin_union_auth_sessions WHERE id = ${row['id']}
  `.execute(readonly),
    ),
  ).toBe('42501');
  expect(await sqlState(sql`SELECT * FROM app.admin_union_auth_sessions`.execute(readonly))).toBe(
    '42501',
  );
  const grants = await sql<{ table_select: boolean; hash_select: boolean }>`
    SELECT has_table_privilege('couli_readonly', 'app.admin_union_auth_sessions', 'SELECT') AS table_select,
      has_column_privilege('couli_readonly', 'app.admin_union_auth_sessions', 'state_hash', 'SELECT') AS hash_select
  `.execute(app);
  expect(grants.rows).toEqual([{ table_select: false, hash_select: false }]);
});
