// B1-34b §9: table shape, CHECKs, tenant keys, indexes and least-privilege grants.
// Shared globalSetup provisions the database; every query uses a business role.
// Assert table existence before querying it so the missing migration fails by assertion.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AT, columns, foreignKeys, fresh, keys, literals, newAdmin } from '../kit.ts';

const TABLE = 'export_tasks';
const STATUSES = ['pending', 'running', 'done', 'failed', 'expired', 'cancelled'];
const MUTABLE = [
  'status',
  'progress',
  'failure_reason',
  'file_name',
  'object_key',
  'row_count',
  'generated_at',
  'expires_at',
  'row_version',
  'updated_at',
];
const SHAPE = [
  ['id', 'uuid', false],
  ['app_id', 'text', false],
  ['public_id', 'text', false],
  ['resource', 'text', false],
  ['filters', 'jsonb', false],
  ['filters_summary', 'text', false],
  ['masked', 'bool', false],
  ['created_by', 'uuid', false],
  ['status', 'text', false],
  ['progress', 'int4', true],
  ['failure_reason', 'text', true],
  ['file_name', 'text', true],
  ['object_key', 'text', true],
  ['row_count', 'int4', true],
  ['generated_at', 'timestamptz', true],
  ['expires_at', 'timestamptz', true],
  ['row_version', 'int4', false],
  ['created_at', 'timestamptz', false],
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
  await Promise.all([app, readonly].filter(Boolean).map((db) => destroyDb(db)));
  if (database) await database.drop();
});

async function ready() {
  return columns(app, TABLE);
}

async function fixture(appId = 'couli'): Promise<Record<string, unknown>> {
  const admin = await newAdmin(app, { app_id: appId });
  return {
    id: randomUUID(),
    app_id: appId,
    public_id: fresh(),
    resource: 'users',
    filters: JSON.stringify({ status: 'active', nested: { labels: ['演示'] } }),
    filters_summary: '启用的用户',
    masked: true,
    created_by: admin['id'],
    status: 'pending',
    created_at: AT,
    updated_at: AT,
  };
}

async function insert(values: Record<string, unknown>, db = app) {
  const names = Object.keys(values);
  const result = await sql<Record<string, unknown>>`
    INSERT INTO app.export_tasks (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => values[name]))}) RETURNING *
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function stored(id: unknown, db = app) {
  const result = await sql<Record<string, unknown>>`
    SELECT * FROM app.export_tasks WHERE id = ${id}
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function update(id: unknown, values: Record<string, unknown>, db = app) {
  return sql`
    UPDATE app.export_tasks
    SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}
  `.execute(db);
}

async function rejectsCheck(values: Record<string, unknown>, alsoUpdate = false) {
  const base = await fixture();
  await expect(insert({ ...base, ...values })).rejects.toMatchObject({ code: '23514' });
  if (alsoUpdate) {
    const row = await insert(base);
    await expect(update(row['id'], values)).rejects.toMatchObject({ code: '23514' });
    expect(await stored(row['id'])).toEqual(row);
  }
}

it('[AC-B1-34b#1] all export columns have the specified SQL types and nullability', async () => {
  const found = await ready();
  for (const [name, type, nullable] of SHAPE) {
    expect(
      found.find((c) => c.name === name),
      name,
    ).toMatchObject({ type, nullable });
  }
  for (const name of ['id', 'public_id']) {
    expect(
      found.find((c) => c.name === name),
      `${name} is application generated`,
    ).toMatchObject({
      defaulted: false,
    });
  }
  expect(await keys(app, TABLE)).toContainEqual({
    columns: ['id'],
    primary: true,
    partial: false,
    expression: false,
  });
});

it('[AC-B1-34b#2] INSERT round-trips filters and separate public id, defaults row_version to 1 and leaves optional fields null', async () => {
  await ready();
  const base = await fixture();
  const row = await insert(base);
  expect(row).toMatchObject({
    ...base,
    filters: JSON.parse(base['filters'] as string) as unknown,
    row_version: 1,
  });
  expect(row['public_id']).not.toBe(row['id']);
  for (const [name, , nullable] of SHAPE) {
    if (nullable) expect(row[name], name).toBeNull();
  }
  expect(await stored(row['id'])).toEqual(row);
});

it('[AC-B1-34b#3] required columns reject explicit NULL even when they have defaults', async () => {
  await ready();
  const base = await fixture();
  for (const [name, , nullable] of SHAPE) {
    if (nullable) continue;
    await expect(insert({ ...base, [name]: null })).rejects.toMatchObject({
      code: '23502',
      column: name,
    });
  }
});

it('[AC-B1-34b#4] resource is limited to users, audit_logs, tax_withdrawals, ledger and withdrawals by a database CHECK', async () => {
  await ready();
  expect([...new Set(await literals(app, TABLE, 'resource'))].sort()).toEqual([
    'audit_logs',
    'ledger',
    'tax_withdrawals',
    'users',
    'withdrawals',
  ]);
  for (const resource of ['users', 'audit_logs', 'tax_withdrawals', 'ledger', 'withdrawals']) {
    expect(await insert({ ...(await fixture()), resource })).toMatchObject({ resource });
  }
  for (const resource of ['', 'orders', 'USERS', 'audit_log']) {
    await rejectsCheck({ resource });
  }
});

it('[AC-B1-34b#5] status CHECK accepts exactly the six contract values on INSERT and UPDATE', async () => {
  await ready();
  expect([...new Set(await literals(app, TABLE, 'status'))].sort()).toEqual([...STATUSES].sort());
  const row = await insert(await fixture());
  for (const status of STATUSES) {
    expect(await insert({ ...(await fixture()), status })).toMatchObject({ status });
    expect((await update(row['id'], { status })).numAffectedRows).toBe(1n);
    expect(await stored(row['id'])).toMatchObject({ status });
  }
  for (const status of ['', 'complete', 'canceled', 'PENDING']) {
    await rejectsCheck({ status }, true);
  }
});

it('[AC-B1-34b#6] audit exports must be masked while user exports allow either masking choice', async () => {
  await ready();
  for (const masked of [true, false]) {
    expect(await insert({ ...(await fixture()), resource: 'users', masked })).toMatchObject({
      resource: 'users',
      masked,
    });
  }
  expect(
    await insert({ ...(await fixture()), resource: 'audit_logs', masked: true }),
  ).toMatchObject({
    resource: 'audit_logs',
    masked: true,
  });
  await rejectsCheck({ resource: 'audit_logs', masked: false });
});

it('[AC-B1-34b#7] progress accepts NULL and 0 through 100, rejecting either out-of-range boundary', async () => {
  await ready();
  const row = await insert(await fixture());
  for (const progress of [0, 1, 50, 99, 100, null]) {
    expect(await insert({ ...(await fixture()), progress })).toMatchObject({ progress });
    expect((await update(row['id'], { progress })).numAffectedRows).toBe(1n);
    expect(await stored(row['id'])).toMatchObject({ progress });
  }
  for (const progress of [-1, 101]) await rejectsCheck({ progress }, true);
});

it('[AC-B1-34b#8] row_count accepts NULL, zero and positive int32 values but rejects negatives', async () => {
  await ready();
  const row = await insert(await fixture());
  for (const row_count of [0, 1, 2147483647, null]) {
    expect(await insert({ ...(await fixture()), row_count })).toMatchObject({ row_count });
    expect((await update(row['id'], { row_count })).numAffectedRows).toBe(1n);
    expect(await stored(row['id'])).toMatchObject({ row_count });
  }
  for (const row_count of [-1, -2147483648]) await rejectsCheck({ row_count }, true);
});

it('[AC-B1-34b#9] public_id is unique within an app, reusable across apps, and the internal id stays globally unique', async () => {
  await ready();
  expect(await keys(app, TABLE)).toContainEqual({
    columns: ['app_id', 'public_id'],
    primary: false,
    partial: false,
    expression: false,
  });
  const first = await insert(await fixture());
  await expect(
    insert({ ...(await fixture()), public_id: first['public_id'] }),
  ).rejects.toMatchObject({ code: '23505' });
  expect(
    await insert({ ...(await fixture('other_export_app')), public_id: first['public_id'] }),
  ).toMatchObject({ app_id: 'other_export_app', public_id: first['public_id'] });
  await expect(insert({ ...(await fixture()), id: first['id'] })).rejects.toMatchObject({
    code: '23505',
  });
});

it('[AC-B1-34b#10] created_by references an existing admin in the same app without cascading', async () => {
  await ready();
  const refs = await foreignKeys(app, TABLE);
  const reference = refs.find(
    (fk) => fk.columns.join(',') === 'app_id,created_by' && fk.target === 'admin_users',
  );
  expect(reference).toMatchObject({
    targetSchema: 'app',
    targetColumns: ['app_id', 'id'],
    validated: true,
  });
  expect(['a', 'r']).toContain(reference!.onDelete);
  expect(['a', 'r']).toContain(reference!.onUpdate);
  const base = await fixture();
  expect(await insert(base)).toMatchObject({ created_by: base['created_by'] });
  await expect(
    insert({ ...base, id: randomUUID(), public_id: fresh(), created_by: randomUUID() }),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    insert({ ...base, id: randomUUID(), public_id: fresh(), app_id: 'wrong_export_app' }),
  ).rejects.toMatchObject({ code: '23503' });
});

it('[AC-B1-34b#11] valid indexes support listing, creator lookup, active cancellation and done expiry cleanup', async () => {
  await ready();
  const indexes = await sql<{ columns: string[]; predicate: string | null; method: string }>`
    SELECT ARRAY(
             SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
             WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
           ) AS columns,
           pg_get_expr(i.indpred, i.indrelid) AS predicate, am.amname AS method
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indrelid = 'app.export_tasks'::regclass AND i.indisvalid AND i.indisready
      AND i.indexprs IS NULL
  `.execute(app);
  for (const names of [
    ['app_id', 'created_at'],
    ['app_id', 'created_by', 'created_at'],
  ]) {
    expect(indexes.rows).toContainEqual({ columns: names, predicate: null, method: 'btree' });
  }
  const partials = [
    { columns: ['app_id', 'created_by', 'created_at'], statuses: ['pending', 'running'] },
    { columns: ['app_id', 'expires_at'], statuses: ['done'] },
  ];
  for (const expected of partials) {
    const candidates = indexes.rows.filter(
      (index) =>
        index.columns.join(',') === expected.columns.join(',') &&
        index.predicate !== null &&
        index.method === 'btree',
    );
    expect(candidates.length, expected.columns.join(',')).toBeGreaterThan(0);
    const matching: string[][] = [];
    for (const index of candidates) {
      // Evaluate the catalog predicate rather than depending on IN/ANY rendering or index names.
      const result = await sql<{ status: string }>`
        SELECT status FROM (VALUES ${sql.join(STATUSES.map((status) => sql`(${status}::text)`))})
          AS candidate(status) WHERE ${sql.raw(index.predicate!)} ORDER BY status
      `.execute(app);
      matching.push(result.rows.map((row) => row.status));
    }
    expect(matching).toContainEqual([...expected.statuses].sort());
  }
});

it('[AC-B1-34b#12] couli_app has SELECT/INSERT and exactly the worker column UPDATE grants, without DELETE or TRUNCATE', async () => {
  const found = await ready();
  for (const [privilege, held] of [
    ['SELECT', true],
    ['INSERT', true],
    ['UPDATE', false],
    ['DELETE', false],
    ['TRUNCATE', false],
  ] as const) {
    const result = await sql<{ held: boolean }>`
      SELECT has_table_privilege('couli_app', 'app.export_tasks', ${privilege}) AS held
    `.execute(app);
    expect(result.rows).toEqual([{ held }]);
  }
  for (const { name } of found) {
    const result = await sql<{ held: boolean }>`
      SELECT has_column_privilege('couli_app', 'app.export_tasks', ${name}, 'UPDATE') AS held
    `.execute(app);
    expect(result.rows, name).toEqual([{ held: MUTABLE.includes(name) }]);
  }
  await expect(sql`DELETE FROM app.export_tasks WHERE false`.execute(app)).rejects.toMatchObject({
    code: '42501',
  });
});

it('[AC-B1-34b#13] couli_app can write worker results, preserve supplied timestamps and clear nullable fields', async () => {
  await ready();
  const row = await insert(await fixture());
  const values = {
    status: 'done',
    progress: 100,
    failure_reason: '演示失败原因',
    file_name: '用户导出.csv',
    object_key: 'exports/synthetic/result.csv',
    row_count: 123,
    generated_at: new Date('2026-10-19T02:00:00Z'),
    expires_at: new Date('2026-10-20T02:00:00Z'),
    row_version: 2,
    updated_at: new Date('2026-10-19T02:01:00Z'),
  };
  expect((await update(row['id'], values)).numAffectedRows).toBe(1n);
  expect(await stored(row['id'])).toEqual({ ...row, ...values });
  const nulls = Object.fromEntries(
    SHAPE.filter(([, , nullable]) => nullable).map(([name]) => [name, null]),
  );
  expect((await update(row['id'], nulls)).numAffectedRows).toBe(1n);
  expect(await stored(row['id'])).toEqual({ ...row, ...values, ...nulls });
});

it('[AC-B1-34b#14] couli_app cannot UPDATE identity, creator, request parameters or creation time', async () => {
  await ready();
  const base = await fixture();
  const row = await insert(base);
  for (const [name] of SHAPE.filter(([name]) => !MUTABLE.includes(name))) {
    // No SELECT or CHECK dependency can conceal an accidental UPDATE grant.
    await expect(
      sql`UPDATE app.export_tasks SET ${sql.ref(name)} = ${base[name]} WHERE false`.execute(app),
    ).rejects.toMatchObject({ code: '42501' });
  }
  expect(await stored(row['id'])).toEqual(row);
});

it('[AC-B1-34b#15] couli_readonly can read every column but cannot insert, update or delete', async () => {
  const found = await ready();
  const base = await fixture();
  const row = await insert(base);
  expect(await stored(row['id'], readonly)).toEqual(row);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    const result = await sql<{ held: boolean }>`
      SELECT has_table_privilege('couli_readonly', 'app.export_tasks', ${privilege}) AS held
    `.execute(app);
    expect(result.rows).toEqual([{ held: privilege === 'SELECT' }]);
  }
  for (const { name } of found) {
    for (const privilege of ['INSERT', 'UPDATE']) {
      const result = await sql<{ held: boolean }>`
        SELECT has_column_privilege('couli_readonly', 'app.export_tasks', ${name}, ${privilege}) AS held
      `.execute(app);
      expect(result.rows, `${name} ${privilege}`).toEqual([{ held: false }]);
    }
    await expect(
      sql`UPDATE app.export_tasks SET ${sql.ref(name)} = NULL WHERE false`.execute(readonly),
    ).rejects.toMatchObject({ code: '42501' });
  }
  await expect(
    insert({ ...base, id: randomUUID(), public_id: fresh() }, readonly),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    sql`DELETE FROM app.export_tasks WHERE false`.execute(readonly),
  ).rejects.toMatchObject({ code: '42501' });
  expect(await stored(row['id'])).toEqual(row);
});

it('[AC-CT-24zzma#1] a ledger export task row can be inserted, round-trips its filters unchanged and stays masked', async () => {
  await ready();
  expect(await literals(app, TABLE, 'resource')).toContain('ledger');
  const filters = {
    user_id: randomUUID(),
    ledger_type: 'REBATE_CREDIT',
    accounting_date_from: '2026-10-01',
    accounting_date_to: '2026-10-31',
  };
  const base = {
    ...(await fixture()),
    resource: 'ledger',
    filters: JSON.stringify(filters),
    filters_summary: '指定用户的返利入账流水',
    masked: true,
  };
  const row = await insert(base);
  expect(row).toMatchObject({ ...base, filters, masked: true, row_version: 1 });
  expect(row['filters']).toEqual(filters);
  expect(await stored(row['id'])).toEqual(row);
});

it('[AC-CT-24zzpa#1] a withdrawals export task row can be inserted, round-trips its filters unchanged and stays masked', async () => {
  await ready();
  expect(await literals(app, TABLE, 'resource')).toContain('withdrawals');
  const filters = {
    status: 'PAYING',
    user_id: randomUUID(),
    created_from: '2026-10-01T00:00:00+08:00',
    created_to: '2026-10-31T23:59:59+08:00',
    amount_min_fen: 100,
  };
  const base = {
    ...(await fixture()),
    resource: 'withdrawals',
    filters: JSON.stringify(filters),
    filters_summary: '指定用户十月打款中的提现单',
    masked: true,
  };
  const row = await insert(base);
  expect(row).toMatchObject({ ...base, filters, masked: true, row_version: 1 });
  expect(row['filters']).toEqual(filters);
  expect(await stored(row['id'])).toEqual(row);
});
