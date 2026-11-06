// B2-12g (claude-independent): the shape and the grants of app.risk_linked_marks fixed by brief §10:
// columns id (identity), app_id, user_id, source_user_id, source_ref, dimension, created_at, and
// nothing else (no plaintext, no HMAC); unique (app_id, source_ref, user_id, dimension); foreign keys
// (app_id, user_id) and (app_id, source_user_id) → app.users; CHECK user_id <> source_user_id;
// dimension id_no | device | payout_account. couli_app SELECT / INSERT only, couli_readonly SELECT
// only, couli_payout and couli_maint nothing. Checked by behaviour on the real roles where a role
// can act, by the catalogue where it cannot. Users are seeded rows (fixtures).
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../../payout/apply/kit.ts';
import { DIMENSIONS, NO_ACCESS, READONLY, TABLE, requireMarksTable } from './kit.ts';

const AT = new Date('2027-02-19T02:30:00.000Z');
const DENIED = '42501';
const UNIQUE = '23505';
const FOREIGN = '23503';
const CHECK = '23514';
const OK = 'ok';
const ALL_TABLE = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN';
const COLUMNS = 'SELECT,INSERT,UPDATE,REFERENCES';

let database: TestDatabase;
let app: Kysely<DB>;
let reader: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  reader = createDb({ connectionString: database.urlFor(READONLY), max: 1 });
}, 180_000);
afterAll(async () => {
  try {
    if (reader) await destroyDb(reader);
  } finally {
    try {
      if (app) await destroyDb(app);
    } finally {
      await database?.drop();
    }
  }
});

/** The SQLSTATE a statement ends with ('ok' when it succeeds). */
async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return OK;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
}

interface Values {
  readonly appId: string;
  readonly userId: string;
  readonly sourceUserId: string;
  readonly sourceRef: string;
  readonly dimension: string;
}

function insert(db: Kysely<DB>, v: Values) {
  return sql`INSERT INTO app.risk_linked_marks
    (app_id, user_id, source_user_id, source_ref, dimension, created_at)
    VALUES (${v.appId}, ${v.userId}, ${v.sourceUserId}, ${v.sourceRef}, ${v.dimension}, ${AT})`.execute(
    db,
  );
}

async function fixture() {
  const appId = `rlm_${randomBytes(8).toString('hex')}`;
  const otherApp = `rlm_${randomBytes(8).toString('hex')}`;
  const linked = await seedUser(app, appId);
  const source = await seedUser(app, appId);
  const stranger = await seedUser(app, otherApp);
  const base: Values = {
    appId,
    userId: linked,
    sourceUserId: source,
    sourceRef: randomUUID(),
    dimension: 'device',
  };
  return { appId, linked, source, stranger, base };
}

async function rowCount(appId: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.risk_linked_marks WHERE app_id = ${appId}`.execute(app);
  return Number(rows[0]?.n);
}

it('[AC-B2-12g#10] 列恰为 id（identity）、app_id、user_id、source_user_id、source_ref、dimension、created_at，全部非空；不存明文与 HMAC', async () => {
  await requireMarksTable(app);
  const { rows } = await sql<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    is_identity: string;
  }>`SELECT column_name, data_type, is_nullable, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'risk_linked_marks'
    ORDER BY column_name`.execute(app);
  const byName = Object.fromEntries(rows.map((row) => [row.column_name, row]));
  expect(Object.keys(byName).sort()).toEqual(
    ['app_id', 'created_at', 'dimension', 'id', 'source_ref', 'source_user_id', 'user_id'].sort(),
  );
  expect(['bigint', 'integer'], 'id 是整数 identity').toContain(byName['id']?.data_type);
  expect(byName['id']?.is_identity).toBe('YES');
  expect(
    Object.fromEntries(
      rows.filter((row) => row.column_name !== 'id').map((row) => [row.column_name, row.data_type]),
    ),
  ).toEqual({
    app_id: 'text',
    user_id: 'uuid',
    source_user_id: 'uuid',
    source_ref: 'text',
    dimension: 'text',
    created_at: 'timestamp with time zone',
  });
  expect(
    rows.filter((row) => row.is_nullable !== 'NO').map((row) => row.column_name),
    '全部非空',
  ).toEqual([]);
});

it('[AC-B2-12g#11] 约束：(app_id, source_ref, user_id, dimension) 唯一；同一用户另一维度、另一候选单各成一行；user_id、source_user_id 须是同一 app 的用户（外键）；user_id 不能等于 source_user_id；dimension 只收 id_no / device / payout_account', async () => {
  await requireMarksTable(app);
  const { appId, linked, source, stranger, base } = await fixture();

  expect(await sqlState(insert(app, base)), '首行').toBe(OK);
  expect(await sqlState(insert(app, base)), '同键重复').toBe(UNIQUE);
  for (const dimension of DIMENSIONS.filter((item) => item !== 'device')) {
    expect(await sqlState(insert(app, { ...base, dimension })), dimension).toBe(OK);
  }
  expect(await sqlState(insert(app, { ...base, sourceRef: randomUUID() })), '另一候选单').toBe(OK);
  expect(await rowCount(appId)).toBe(4);

  expect(
    await sqlState(insert(app, { ...base, sourceRef: randomUUID(), userId: randomUUID() })),
    'user_id 不存在',
  ).toBe(FOREIGN);
  expect(
    await sqlState(insert(app, { ...base, sourceRef: randomUUID(), sourceUserId: randomUUID() })),
    'source_user_id 不存在',
  ).toBe(FOREIGN);
  expect(
    await sqlState(insert(app, { ...base, sourceRef: randomUUID(), userId: stranger })),
    'user_id 是别的 app 的用户',
  ).toBe(FOREIGN);
  expect(
    await sqlState(insert(app, { ...base, sourceRef: randomUUID(), sourceUserId: stranger })),
    'source_user_id 是别的 app 的用户',
  ).toBe(FOREIGN);
  expect(
    await sqlState(insert(app, { ...base, sourceRef: randomUUID(), userId: source })),
    'user_id = source_user_id',
  ).toBe(CHECK);
  expect(
    await sqlState(
      insert(app, { ...base, sourceRef: randomUUID(), userId: linked, sourceUserId: linked }),
    ),
    '本人标本人',
  ).toBe(CHECK);
  for (const dimension of ['phone', 'DEVICE', 'alipay', '']) {
    expect(
      await sqlState(insert(app, { ...base, sourceRef: randomUUID(), dimension })),
      `dimension ${JSON.stringify(dimension)}`,
    ).toBe(CHECK);
  }
  expect(await rowCount(appId)).toBe(4);
});

it('[AC-B2-12g#12] 授权：couli_app 只能 SELECT / INSERT（UPDATE、DELETE 被拒，无 TRUNCATE、无列级 UPDATE）；couli_readonly 能读全部列、不能写；couli_payout、couli_maint 无任何表级或列级权限', async () => {
  await requireMarksTable(app);
  const { appId, base } = await fixture();
  expect(await sqlState(insert(app, base))).toBe(OK);

  expect(
    await sqlState(
      sql`UPDATE app.risk_linked_marks SET dimension = 'id_no' WHERE app_id = ${appId}`.execute(
        app,
      ),
    ),
    'couli_app UPDATE',
  ).toBe(DENIED);
  expect(
    await sqlState(sql`DELETE FROM app.risk_linked_marks WHERE app_id = ${appId}`.execute(app)),
    'couli_app DELETE',
  ).toBe(DENIED);
  const own = await sql<{
    can_select: boolean;
    can_insert: boolean;
    table_change: boolean;
    column_update: boolean;
  }>`SELECT
      has_table_privilege('couli_app', ${TABLE}, 'SELECT') AS can_select,
      has_table_privilege('couli_app', ${TABLE}, 'INSERT') AS can_insert,
      has_table_privilege('couli_app', ${TABLE}, 'UPDATE,DELETE,TRUNCATE') AS table_change,
      has_any_column_privilege('couli_app', ${TABLE}, 'UPDATE') AS column_update`.execute(app);
  expect(own.rows).toEqual([
    { can_select: true, can_insert: true, table_change: false, column_update: false },
  ]);
  expect(await rowCount(appId)).toBe(1);

  const read = await sql<Record<string, unknown>>`
    SELECT id, app_id, user_id, source_user_id, source_ref, dimension, created_at
    FROM app.risk_linked_marks WHERE app_id = ${appId}`.execute(reader);
  expect(read.rows, 'couli_readonly 读全部列').toHaveLength(1);
  expect(
    await sqlState(insert(reader, { ...base, sourceRef: randomUUID() })),
    'couli_readonly INSERT',
  ).toBe(DENIED);
  expect(
    await sqlState(
      sql`UPDATE app.risk_linked_marks SET dimension = 'id_no' WHERE app_id = ${appId}`.execute(
        reader,
      ),
    ),
    'couli_readonly UPDATE',
  ).toBe(DENIED);
  expect(
    await sqlState(sql`DELETE FROM app.risk_linked_marks WHERE app_id = ${appId}`.execute(reader)),
    'couli_readonly DELETE',
  ).toBe(DENIED);
  const readonly = await sql<{ table_write: boolean; column_write: boolean }>`SELECT
      has_table_privilege(${READONLY}, ${TABLE}, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS table_write,
      has_any_column_privilege(${READONLY}, ${TABLE}, 'INSERT,UPDATE,REFERENCES') AS column_write`.execute(
    app,
  );
  expect(readonly.rows).toEqual([{ table_write: false, column_write: false }]);

  for (const role of NO_ACCESS) {
    const privileges = await sql<{ table_access: boolean; column_access: boolean }>`SELECT
        has_table_privilege(${role}, ${TABLE}, ${ALL_TABLE}) AS table_access,
        has_any_column_privilege(${role}, ${TABLE}, ${COLUMNS}) AS column_access`.execute(app);
    expect(privileges.rows, role).toEqual([{ table_access: false, column_access: false }]);
  }
});
