// B1-06zh grants (db/AGENTS.md rule 4: grants live in the creating migration; append-only tables
// get no UPDATE / DELETE). A filing is a fact ("authority.query answered filed at filed_at"):
// couli_app may SELECT and INSERT (insert-if-absent needs no UPDATE), couli_readonly may only
// SELECT, couli_payout and couli_maint get nothing.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  LATER,
  QUALIFIED,
  TABLE,
  TIMEOUT,
  columns,
  connect,
  newAccount,
  newFiling,
  newPid,
  newUser,
  requireTable,
  sqlState,
  stored,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  connect(app);
}, TIMEOUT);

afterAll(async () => {
  if (readonly) await destroyDb(readonly);
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, TIMEOUT);

const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'];
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

async function allowed(role: string, privilege: string): Promise<boolean | undefined> {
  const columnPrivilege = COLUMN_PRIVILEGES.includes(privilege)
    ? sql<boolean>`has_any_column_privilege(${role}, ${QUALIFIED}, ${privilege})`
    : sql<boolean>`false`;
  const result = await sql<{ allowed: boolean }>`
    SELECT has_table_privilege(${role}, ${QUALIFIED}, ${privilege}) OR ${columnPrivilege}
      AS allowed
  `.execute(app);
  return result.rows[0]?.allowed;
}

it(
  '[AC-B1-06zh#12] couli_app gets SELECT and INSERT only, couli_readonly SELECT only, other roles nothing',
  async () => {
    await requireTable();
    for (const role of ROLES) {
      for (const privilege of PRIVILEGES) {
        const expected =
          role === 'couli_app'
            ? ['SELECT', 'INSERT'].includes(privilege)
            : role === 'couli_readonly' && privilege === 'SELECT';
        expect(await allowed(role, privilege), `${role} ${TABLE} ${privilege}`).toBe(expected);
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#13] couli_app cannot rewrite any column of a filing (insufficient_privilege)',
  async () => {
    await requireTable();
    const row = await newFiling();
    const original = await stored(row['id']);
    expect(original).toHaveLength(1);
    const names = (await columns(TABLE)).map((c) => c.name);
    expect(names).toContain('filed_at');
    for (const name of names) {
      const update = sql`
        UPDATE app.union_pdd_pid_filings SET ${sql.ref(name)} = ${sql.ref(name)}
        WHERE id = ${row['id']}
      `;
      expect(await sqlState(update.execute(app)), name).toBe('42501');
    }
    const refresh = sql`
      UPDATE app.union_pdd_pid_filings SET filed_at = ${LATER} WHERE id = ${row['id']}
    `;
    expect(await sqlState(refresh.execute(app)), 'refresh filed_at').toBe('42501');
    const upsert = sql`
      INSERT INTO app.union_pdd_pid_filings
        (id, app_id, user_id, pid, union_account_id, filed_at)
      VALUES (${randomUUID()}, 'couli', ${row['user_id']}, ${row['pid']},
        ${row['union_account_id']}, ${LATER})
      ON CONFLICT (app_id, user_id, pid) DO UPDATE SET filed_at = EXCLUDED.filed_at
    `;
    expect(await sqlState(upsert.execute(app)), 'upsert must not refresh filed_at').toBe('42501');
    expect(await stored(row['id'])).toEqual(original);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#14] couli_app cannot DELETE or TRUNCATE filings (insufficient_privilege)',
  async () => {
    await requireTable();
    const row = await newFiling();
    const original = await stored(row['id']);
    expect(original).toHaveLength(1);
    const remove = sql`DELETE FROM app.union_pdd_pid_filings WHERE id = ${row['id']}`;
    expect(await sqlState(remove.execute(app)), 'DELETE').toBe('42501');
    const truncate = sql`TRUNCATE app.union_pdd_pid_filings`;
    expect(await sqlState(truncate.execute(app)), 'TRUNCATE').toBe('42501');
    expect(await stored(row['id'])).toEqual(original);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zh#15] couli_readonly reads filings but cannot insert, update or delete them',
  async () => {
    await requireTable();
    const row = await newFiling();
    const seen = await sql<{ id: string; pid: string }>`
      SELECT id, pid FROM app.union_pdd_pid_filings WHERE id = ${row['id']}
    `.execute(readonly);
    expect(seen.rows).toEqual([{ id: row['id'], pid: row['pid'] }]);
    const userId = await newUser();
    const accountId = await newAccount();
    const insert = sql`
      INSERT INTO app.union_pdd_pid_filings
        (id, app_id, user_id, pid, union_account_id, filed_at)
      VALUES (${randomUUID()}, 'couli', ${userId}, ${newPid()}, ${accountId}, ${LATER})
    `;
    expect(await sqlState(insert.execute(readonly)), 'INSERT').toBe('42501');
    const update = sql`
      UPDATE app.union_pdd_pid_filings SET filed_at = ${LATER} WHERE id = ${row['id']}
    `;
    expect(await sqlState(update.execute(readonly)), 'UPDATE').toBe('42501');
    const remove = sql`DELETE FROM app.union_pdd_pid_filings WHERE id = ${row['id']}`;
    expect(await sqlState(remove.execute(readonly)), 'DELETE').toBe('42501');
    expect(await stored(row['id'])).toHaveLength(1);
  },
  TIMEOUT,
);
