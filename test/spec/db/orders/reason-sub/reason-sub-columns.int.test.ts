// Rule tests of B1-09u: manual sub-reason columns (编排 D10-819 ①、D10-821 ③; 08 12_TEXT BR-TEXT-05
// 「子原因 reason_sub」: 15 codes, 人工选择覆盖自动映射, 人工选过的不被自动覆盖).
// - app.rights_imports.reason_sub text NULL: the import's manual choice, one of the 15 codes or
//   'none' (明确不写); NULL = not chosen (automatic mapping).
// - app.order_rights.reason_sub text NULL + reason_sub_manual boolean NOT NULL DEFAULT false;
//   reason_sub_manual = false requires reason_sub NULL.
// - app.orders.reason_sub_manual boolean NOT NULL DEFAULT false, added on the partitioned parent
//   (orders.reason_sub itself gets no CHECK in this task).
// Grants: couli_app updates the new columns, couli_readonly only reads them.
// Real PostgreSQL as the business roles; own database per file. Top-level it() only (规划/11 §4.3).
import { readFileSync, readdirSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHECK_VIOLATION,
  NOT_NULL_VIOLATION,
  PERMISSION_DENIED,
  REASON_SUB_CODES,
  REASON_SUB_NONE,
  REJECTED_REASON_SUBS,
  attribute,
  column,
  connect,
  hasColumnPrivilege,
  insert,
  newOrder,
  newOrderId,
  newOrderKey,
  orderRight,
  requireColumn,
  rightsImport,
  sqlState,
  storedImport,
  storedOrder,
  storedRight,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  connect(app);
});

afterAll(async () => {
  await Promise.all([app, readonly, maint].map((db) => destroyDb(db)));
  await database.drop();
});

/** The four columns this task adds: [table, column]. */
const NEW_COLUMNS = [
  ['rights_imports', 'reason_sub'],
  ['order_rights', 'reason_sub'],
  ['order_rights', 'reason_sub_manual'],
  ['orders', 'reason_sub_manual'],
] as const;

async function requireAll(): Promise<void> {
  for (const [table, name] of NEW_COLUMNS) await requireColumn(app, table, name);
}

/** Inserts a rights_imports row with the values; resolves to [SQLSTATE, id]. */
async function addImport(values: Record<string, unknown>): Promise<[string, unknown]> {
  const row = await rightsImport(values);
  return [await sqlState(insert(app, 'rights_imports', row)), row['id']];
}

/** Inserts an order_rights row (on a fresh order) with the values; resolves to [SQLSTATE, id]. */
async function addRight(values: Record<string, unknown>): Promise<[string, unknown]> {
  const row = await orderRight(await newOrderId(), values);
  return [await sqlState(insert(app, 'order_rights', row)), row['id']];
}

// ---------------------------------------------------------------------------------------------
// Column shapes (编排 §9 第 1 条)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-09u#1] rights_imports.reason_sub and order_rights.reason_sub are nullable text without default', async () => {
  for (const table of ['rights_imports', 'order_rights']) {
    expect(await attribute(app, table, 'reason_sub'), `${table}.reason_sub`).toMatchObject({
      type: 'text',
      notNull: false,
      defaultExpr: null,
    });
    expect(await column(table, 'reason_sub'), `${table}.reason_sub (information_schema)`).toEqual({
      name: 'reason_sub',
      type: 'text',
      nullable: true,
      hasDefault: false,
    });
  }
});

it('[AC-B1-09u#2] order_rights.reason_sub_manual and orders.reason_sub_manual are boolean NOT NULL DEFAULT false', async () => {
  for (const table of ['order_rights', 'orders']) {
    expect(
      await attribute(app, table, 'reason_sub_manual'),
      `${table}.reason_sub_manual`,
    ).toMatchObject({ type: 'boolean', notNull: true, defaultExpr: 'false' });
    expect(
      await column(table, 'reason_sub_manual'),
      `${table}.reason_sub_manual (information_schema)`,
    ).toEqual({ name: 'reason_sub_manual', type: 'bool', nullable: false, hasDefault: true });
  }
  // orders.reason_sub already exists and stays; rights_imports carries no manual flag (its NULL
  // reason_sub means "not chosen").
  expect(await attribute(app, 'orders', 'reason_sub')).toMatchObject({ type: 'text' });
  expect(await attribute(app, 'rights_imports', 'reason_sub_manual')).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------
// rights_imports.reason_sub values (编排 §9 第 2 条)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-09u#3] rights_imports.reason_sub stores each of the 15 codes, none, and NULL as written', async () => {
  await requireColumn(app, 'rights_imports', 'reason_sub');
  for (const value of [...REASON_SUB_CODES, REASON_SUB_NONE, null]) {
    const [state, id] = await addImport({ reason_sub: value });
    expect(state, JSON.stringify(value)).toBe('no error');
    expect(await storedImport(app, id), JSON.stringify(value)).toEqual([{ reason_sub: value }]);
  }
  // An insert that leaves the column out (the existing import writer) stores NULL: not chosen.
  const [state, id] = await addImport({});
  expect(state).toBe('no error');
  expect(await storedImport(app, id)).toEqual([{ reason_sub: null }]);
});

it('[AC-B1-09u#4] rights_imports.reason_sub rejects any other string by CHECK (OTHER, lower-case, empty, NONE, padded)', async () => {
  await requireColumn(app, 'rights_imports', 'reason_sub');
  for (const value of REJECTED_REASON_SUBS) {
    const [state] = await addImport({ reason_sub: value });
    expect(state, JSON.stringify(value)).toBe(CHECK_VIOLATION);
  }
  // The same list holds on UPDATE.
  const [state, id] = await addImport({ reason_sub: 'FAKE_TRADE' });
  expect(state).toBe('no error');
  for (const value of REJECTED_REASON_SUBS) {
    expect(
      await sqlState(
        sql`UPDATE app.rights_imports SET reason_sub = ${value} WHERE id = ${id}`.execute(app),
      ),
      JSON.stringify(value),
    ).toBe(CHECK_VIOLATION);
  }
  expect(await storedImport(app, id)).toEqual([{ reason_sub: 'FAKE_TRADE' }]);
});

// ---------------------------------------------------------------------------------------------
// order_rights.reason_sub / reason_sub_manual (编排 §9 第 3 条)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-09u#5] order_rights without a manual choice (reason_sub_manual = false) cannot carry a reason_sub', async () => {
  await requireColumn(app, 'order_rights', 'reason_sub_manual');
  for (const value of ['FAKE_TRADE', 'AFTER_SALE', REASON_SUB_NONE]) {
    const [state] = await addRight({ reason_sub_manual: false, reason_sub: value });
    expect(state, JSON.stringify(value)).toBe(CHECK_VIOLATION);
  }
  // The column default (false) is held to the same rule.
  const [omitted] = await addRight({ reason_sub: 'FAKE_TRADE' });
  expect(omitted).toBe(CHECK_VIOLATION);
  // false + NULL is the automatic case.
  const [state, id] = await addRight({ reason_sub_manual: false, reason_sub: null });
  expect(state).toBe('no error');
  expect(await storedRight(app, id)).toEqual([{ reason_sub: null, reason_sub_manual: false }]);
  // An UPDATE that sets a sub-reason without the manual flag is rejected as well.
  expect(
    await sqlState(
      sql`UPDATE app.order_rights SET reason_sub = 'FAKE_TRADE' WHERE id = ${id}`.execute(app),
    ),
  ).toBe(CHECK_VIOLATION);
  expect(await storedRight(app, id)).toEqual([{ reason_sub: null, reason_sub_manual: false }]);
});

it('[AC-B1-09u#6] order_rights written without the new columns reads reason_sub NULL, reason_sub_manual false', async () => {
  await requireColumn(app, 'order_rights', 'reason_sub_manual');
  const [state, id] = await addRight({});
  expect(state).toBe('no error');
  expect(await storedRight(app, id)).toEqual([{ reason_sub: null, reason_sub_manual: false }]);
});

it('[AC-B1-09u#7] order_rights with reason_sub_manual = true stores each of the 15 codes and none', async () => {
  await requireColumn(app, 'order_rights', 'reason_sub_manual');
  for (const value of [...REASON_SUB_CODES, REASON_SUB_NONE]) {
    const [state, id] = await addRight({ reason_sub_manual: true, reason_sub: value });
    expect(state, value).toBe('no error');
    expect(await storedRight(app, id), value).toEqual([
      { reason_sub: value, reason_sub_manual: true },
    ]);
  }
});

it('[AC-B1-09u#8] order_rights accepts reason_sub_manual = true with reason_sub NULL (pinned: the CHECK only forbids a sub-reason without the manual flag; 「无」may be none or NULL)', async () => {
  await requireColumn(app, 'order_rights', 'reason_sub_manual');
  const [state, id] = await addRight({ reason_sub_manual: true, reason_sub: null });
  expect(state).toBe('no error');
  expect(await storedRight(app, id)).toEqual([{ reason_sub: null, reason_sub_manual: true }]);
  // A manual choice of a code can later be changed to none, and back to the automatic state.
  expect(
    await sqlState(
      sql`UPDATE app.order_rights SET reason_sub = 'none' WHERE id = ${id}`.execute(app),
    ),
  ).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.order_rights SET reason_sub = NULL, reason_sub_manual = false
          WHERE id = ${id}`.execute(app),
    ),
  ).toBe('no error');
  expect(await storedRight(app, id)).toEqual([{ reason_sub: null, reason_sub_manual: false }]);
});

it('[AC-B1-09u#9] order_rights.reason_sub rejects any other string by CHECK even with the manual flag', async () => {
  await requireColumn(app, 'order_rights', 'reason_sub_manual');
  for (const value of REJECTED_REASON_SUBS) {
    const [state] = await addRight({ reason_sub_manual: true, reason_sub: value });
    expect(state, JSON.stringify(value)).toBe(CHECK_VIOLATION);
  }
  const [state, id] = await addRight({ reason_sub_manual: true, reason_sub: 'IN_SALE' });
  expect(state).toBe('no error');
  for (const value of REJECTED_REASON_SUBS) {
    expect(
      await sqlState(
        sql`UPDATE app.order_rights SET reason_sub = ${value} WHERE id = ${id}`.execute(app),
      ),
      JSON.stringify(value),
    ).toBe(CHECK_VIOLATION);
  }
  expect(await storedRight(app, id)).toEqual([{ reason_sub: 'IN_SALE', reason_sub_manual: true }]);
});

it('[AC-B1-09u#10] order_rights.reason_sub_manual is NOT NULL', async () => {
  await requireColumn(app, 'order_rights', 'reason_sub_manual');
  const [state] = await addRight({ reason_sub_manual: null, reason_sub: null });
  expect(state).toBe(NOT_NULL_VIOLATION);
});

// ---------------------------------------------------------------------------------------------
// orders.reason_sub_manual (编排 §9 第 4 条)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-09u#11] rows stored before the migration read reason_sub_manual = false (fast default, no backfill) on order_rights and orders_default', async () => {
  await requireAll();
  // ADD COLUMN … NOT NULL DEFAULT false stores false as the missing value of every relation that
  // existed before the migration, so their earlier rows read false without a rewrite or backfill.
  for (const table of ['order_rights', 'orders_default']) {
    expect(await attribute(app, table, 'reason_sub_manual'), table).toEqual({
      type: 'boolean',
      notNull: true,
      defaultExpr: 'false',
      hasMissing: true,
    });
  }
  // The migration adds no missing value to the nullable reason_sub columns (they read NULL).
  for (const table of ['rights_imports', 'order_rights']) {
    expect((await attribute(app, table, 'reason_sub'))?.hasMissing, table).toBe(false);
  }

  // The missing value itself (pg_attribute.attmissingval) is not readable by the business roles,
  // so it is pinned through the migration source: reason_sub_manual is added with DEFAULT false
  // directly, never first with DEFAULT true and then switched, and earlier rows are not updated.
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const files = readdirSync(directory).filter(
    (file) => /^\d{4}_/.test(file) && file.endsWith('.sql') && file.includes('reason-sub'),
  );
  expect(files, 'exactly one reason-sub migration').toHaveLength(1);
  const source = readFileSync(new URL(files[0]!, directory), 'utf8');
  const sqlOnly = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/'(?:''|[^'])*'/g, "''");
  const statements = sqlOnly
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' '))
    .filter((statement) => statement !== '');
  const addFalse =
    /\bADD COLUMN (?:IF NOT EXISTS )?reason_sub_manual bool(?:ean)? (?:NOT NULL DEFAULT false|DEFAULT false NOT NULL)(?= ?(?:,|$))/i;
  for (const table of ['order_rights', 'orders']) {
    const alters = statements.filter((statement) =>
      new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?app\\.${table}\\b`, 'i').test(statement),
    );
    expect(
      alters.some((statement) => addFalse.test(statement)),
      `${files[0]}: ALTER TABLE app.${table} ADD COLUMN reason_sub_manual boolean NOT NULL DEFAULT false`,
    ).toBe(true);
  }
  expect(sqlOnly, `${files[0]}: no ALTER COLUMN`).not.toMatch(/\bALTER\s+COLUMN\b/i);
  expect(sqlOnly, `${files[0]}: no SET DEFAULT`).not.toMatch(/\bSET\s+DEFAULT\b/i);
  expect(sqlOnly, `${files[0]}: no DROP`).not.toMatch(/\bDROP\b/i);
  // rights_imports is granted UPDATE per column, so a column-level GRANT UPDATE (reason_sub) is
  // the one permitted use of the word; no other statement may update (backfill) rows.
  const writes = statements.filter((statement) => !/^(?:GRANT|REVOKE)\b/i.test(statement));
  expect(writes.join(';\n'), `${files[0]}: no UPDATE`).not.toMatch(/\bUPDATE\b/i);
});

it('[AC-B1-09u#12] an order inserted without reason_sub_manual reads false; true is stored; NULL is rejected', async () => {
  await requireColumn(app, 'orders', 'reason_sub_manual');
  const plain = await newOrder();
  expect(await storedOrder(app, plain.orderId)).toEqual([
    { part: 'app.orders_default', manual: false },
  ]);
  const manual = await newOrder({ reason_sub_manual: true });
  expect((await storedOrder(app, manual.orderId)).map((r) => r.manual)).toEqual([true]);
  expect(await sqlState(newOrder({ reason_sub_manual: null }))).toBe(NOT_NULL_VIOLATION);
});

it('[AC-B1-09u#13] the DEFAULT partition and a month partition created after the migration both carry reason_sub_manual', async () => {
  await requireColumn(app, 'orders', 'reason_sub_manual');
  expect(await attribute(app, 'orders_default', 'reason_sub_manual')).toMatchObject({
    type: 'boolean',
    notNull: true,
  });
  const created = await sql<{ name: string }>`
    SELECT app.ensure_month_partition('orders', '2027-03-01'::date) AS name
  `.execute(maint);
  expect(created.rows).toEqual([{ name: 'orders_p202703' }]);
  expect(await attribute(app, 'orders_p202703', 'reason_sub_manual')).toMatchObject({
    type: 'boolean',
    notNull: true,
  });
  const key = await newOrderKey({ attr_at: new Date('2027-03-15T08:00:00Z') });
  await newOrder({}, key);
  expect(await storedOrder(app, key.orderId)).toEqual([
    { part: 'app.orders_p202703', manual: false },
  ]);
  expect(
    await sqlState(
      sql`UPDATE app.orders SET reason_sub_manual = true WHERE order_id = ${key.orderId}`.execute(
        app,
      ),
    ),
  ).toBe('no error');
  expect(await storedOrder(app, key.orderId)).toEqual([
    { part: 'app.orders_p202703', manual: true },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Grants (编排 §9 第 5 条)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-09u#14] couli_app can insert and update every new column', async () => {
  await requireAll();
  for (const [table, name] of NEW_COLUMNS) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      expect(
        await hasColumnPrivilege(app, 'couli_app', table, name, privilege),
        `couli_app ${privilege} ${table}.${name}`,
      ).toBe(true);
    }
  }
  const [importState, importId] = await addImport({});
  expect(importState).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.rights_imports SET reason_sub = 'PUNISH_ORDER' WHERE id = ${importId}`.execute(
        app,
      ),
    ),
  ).toBe('no error');
  expect(await storedImport(app, importId)).toEqual([{ reason_sub: 'PUNISH_ORDER' }]);

  const [rightState, rightId] = await addRight({});
  expect(rightState).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.order_rights SET reason_sub_manual = true, reason_sub = 'AFTER_SETTLE'
          WHERE id = ${rightId}`.execute(app),
    ),
  ).toBe('no error');
  expect(await storedRight(app, rightId)).toEqual([
    { reason_sub: 'AFTER_SETTLE', reason_sub_manual: true },
  ]);

  const order = await newOrder();
  expect(
    await sqlState(
      sql`UPDATE app.orders SET reason_sub_manual = true WHERE order_id = ${order.orderId}`.execute(
        app,
      ),
    ),
  ).toBe('no error');
  expect((await storedOrder(app, order.orderId)).map((r) => r.manual)).toEqual([true]);
});

it('[AC-B1-09u#15] couli_readonly reads the new columns and cannot insert or update them', async () => {
  await requireAll();
  for (const [table, name] of NEW_COLUMNS) {
    expect(
      await hasColumnPrivilege(app, 'couli_readonly', table, name, 'SELECT'),
      `couli_readonly SELECT ${table}.${name}`,
    ).toBe(true);
    for (const privilege of ['INSERT', 'UPDATE']) {
      expect(
        await hasColumnPrivilege(app, 'couli_readonly', table, name, privilege),
        `couli_readonly ${privilege} ${table}.${name}`,
      ).toBe(false);
    }
    expect(
      await sqlState(
        sql`SELECT ${sql.ref(name)} FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(readonly),
      ),
      `SELECT ${table}.${name}`,
    ).toBe('no error');
  }
  expect(
    await sqlState(
      sql`UPDATE app.rights_imports SET reason_sub = 'none' WHERE false`.execute(readonly),
    ),
  ).toBe(PERMISSION_DENIED);
  expect(
    await sqlState(
      sql`UPDATE app.order_rights SET reason_sub_manual = true, reason_sub = 'none'
          WHERE false`.execute(readonly),
    ),
  ).toBe(PERMISSION_DENIED);
  expect(
    await sqlState(
      sql`UPDATE app.orders SET reason_sub_manual = true WHERE false`.execute(readonly),
    ),
  ).toBe(PERMISSION_DENIED);
});
