// B2-18a：app.settle_bills 新增 unsettled_count（应结未结数）与 amount_mismatch_count（金额不一致重生成后
// 仍不一致数，B2-18 写，本单只建列）——整数、可空、非负、具名 CHECK；不动已有列、约束；couli_app 对新列的
// 权限与 error_count 相同；recon_diffs 的 type CHECK 仍含 settle_missing（取值保留、不再生成）。
// 每条先断言新列存在，缺迁移时红在断言上，而不是红在引用不存在的列的 SQL 错误上。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CHECKS,
  NEW_COLUMNS,
  billCounts,
  legacyBill,
  newColumnsPresent,
  settleBillColumns,
  type NewColumn,
} from './kit.ts';

const TIMEOUT = 60_000;
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
}, TIMEOUT);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, TIMEOUT);

async function requireNewColumns(): Promise<void> {
  expect(await newColumnsPresent(db)).toEqual({
    unsettled_count: true,
    amount_mismatch_count: true,
  });
}

/** 只给一个新列取值的一张新账单行（其余列取迁移前的形状）。 */
async function insertWith(column: NewColumn, value: number | null): Promise<string> {
  const appId = `b2-18a-${randomUUID()}`;
  await sql`
    INSERT INTO app.settle_bills (app_id, bill_id, generation_started_at, ${sql.ref(column)})
    VALUES (${appId}, '2032-06', ${new Date('2032-07-24T00:05:00+08:00')}, ${value})
  `.execute(db);
  return appId;
}

async function sqlError(run: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run;
    return {};
  } catch (error) {
    const e = error as { code?: unknown; constraint?: unknown };
    return {
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.constraint === 'string' ? { constraint: e.constraint } : {}),
    };
  }
}

it(
  '[AC-B2-18a#12] settle_bills 有 unsettled_count、amount_mismatch_count 两列：整数（与 error_count 同类型）、可空、无默认值；已有列不变',
  async () => {
    await requireNewColumns();
    const shapes = await settleBillColumns(db, ['error_count', 'held_count', ...NEW_COLUMNS]);
    expect(shapes).toEqual([
      { name: 'amount_mismatch_count', dataType: 'integer', nullable: true, defaultValue: null },
      { name: 'error_count', dataType: 'integer', nullable: true, defaultValue: null },
      { name: 'held_count', dataType: 'integer', nullable: true, defaultValue: null },
      { name: 'unsettled_count', dataType: 'integer', nullable: true, defaultValue: null },
    ]);
  },
  TIMEOUT,
);

it.each(NEW_COLUMNS)(
  '[AC-B2-18a#13] %s 为负被具名 CHECK 拒（INSERT 与 UPDATE 都拒，23514），0、正数与 NULL 可写',
  async (column) => {
    await requireNewColumns();
    const constraint = CHECKS[column];
    expect(await sqlError(insertWith(column, -1))).toEqual({ code: '23514', constraint });
    const zero = await insertWith(column, 0);
    const positive = await insertWith(column, 2147483647);
    const empty = await insertWith(column, null);
    const read = async (appId: string) => (await billCounts(db, appId))?.[column];
    expect(await read(zero)).toBe(0);
    expect(await read(positive)).toBe(2147483647);
    expect(await read(empty)).toBeNull();
    const update = sql`
      UPDATE app.settle_bills SET ${sql.ref(column)} = ${-1}
      WHERE app_id = ${zero} AND bill_id = '2032-06'
    `.execute(db);
    expect(await sqlError(update)).toEqual({ code: '23514', constraint });
    expect(await read(zero)).toBe(0);
    const raise = sql`
      UPDATE app.settle_bills SET ${sql.ref(column)} = ${5}
      WHERE app_id = ${empty} AND bill_id = '2032-06'
    `.execute(db);
    expect(await sqlError(raise)).toEqual({});
    expect(await read(empty)).toBe(5);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#14] 两个 CHECK 具名且已校验，已有约束 settle_bills_counts_check 定义不变；recon_diffs 的 type CHECK 仍含 settle_missing',
  async () => {
    await requireNewColumns();
    const { rows } = await sql<{ name: string; kind: string; valid: boolean; definition: string }>`
      SELECT conname AS name, contype::text AS kind, convalidated AS valid,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'app.settle_bills'::regclass
        AND conname IN (${sql.join([...Object.values(CHECKS), 'settle_bills_counts_check'])})
      ORDER BY conname
    `.execute(db);
    expect(rows.map((r) => [r.name, r.kind, r.valid])).toEqual([
      ['settle_bills_amount_mismatch_count_check', 'c', true],
      ['settle_bills_counts_check', 'c', true],
      ['settle_bills_unsettled_count_check', 'c', true],
    ]);
    expect(rows.find((r) => r.name === 'settle_bills_counts_check')?.definition).toBe(
      'CHECK (((error_count >= 0) AND (held_count >= 0)))',
    );
    for (const column of NEW_COLUMNS) {
      expect(rows.find((r) => r.name === CHECKS[column])?.definition).toContain(column);
    }
    const recon = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'app.recon_diffs'::regclass AND conname = 'recon_diffs_type_check'
    `.execute(db);
    expect(recon.rows).toHaveLength(1);
    expect(recon.rows[0]?.definition).toContain("'settle_missing'::text");
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#15] couli_app 对两个新列的 SELECT / INSERT / UPDATE / REFERENCES 权限与 error_count 完全相同',
  async () => {
    await requireNewColumns();
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;
    const of = async (column: string) => {
      const out: Record<string, boolean> = {};
      for (const privilege of privileges) {
        const { rows } = await sql<{ granted: boolean }>`
          SELECT has_column_privilege('couli_app', 'app.settle_bills', ${column}, ${privilege})
            AS granted
        `.execute(db);
        out[privilege] = rows[0]?.granted ?? false;
      }
      return out;
    };
    const reference = await of('error_count');
    expect(reference).toEqual({ SELECT: true, INSERT: true, UPDATE: true, REFERENCES: false });
    for (const column of NEW_COLUMNS) expect(await of(column), column).toEqual(reference);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#16] 只写已有列的账单行（迁移前的形状）两新列为 NULL，读取方按 NULL 读出不报错',
  async () => {
    await requireNewColumns();
    const appId = `b2-18a-${randomUUID()}`;
    await legacyBill(db, appId, { errorCount: 4, heldCount: 1 });
    expect(await billCounts(db, appId)).toEqual({
      error_count: 4,
      held_count: 1,
      unsettled_count: null,
      amount_mismatch_count: null,
    });
  },
  TIMEOUT,
);
