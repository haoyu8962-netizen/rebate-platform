// B2-04zy rule tests on a real PostgreSQL (D10-726): storage of the two counters.
//   - app.settle_batches.credited_count integer NOT NULL DEFAULT 0, CHECK
//     settle_batches_credited_count_check (credited_count >= 0);
//   - app.settle_runs.published_credited_count integer NOT NULL DEFAULT 0, CHECK
//     settle_runs_published_credited_count_check (published_credited_count >= 0);
//   - couli_app (settlement, the only writer of both tables) may UPDATE both columns.
// Rows go through raw SQL: the generated DB types do not know the columns before the snapshot.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { TIMEOUT, at, counterColumns, databaseFixture, watermarkReady } from './kit.ts';

const p = databaseFixture(createTestDatabase);

const AT = '2032-07-24T09:00:00+08:00';
const BILL_ID = '2032-06';

type Relation = 'settle_batches' | 'settle_runs';
type Row = Record<string, unknown>;

const COUNTERS = [
  {
    relation: 'settle_batches',
    column: 'credited_count',
    check: 'settle_batches_credited_count_check',
    key: 'batch_id',
  },
  {
    relation: 'settle_runs',
    column: 'published_credited_count',
    check: 'settle_runs_published_credited_count_check',
    key: 'settle_run_id',
  },
] as const;

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23514', '42501'].includes(code)) throw error;
    return code;
  }
}

async function insert(db: Kysely<DB>, relation: Relation, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${relation}`)}
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

/** A fresh app with its bill (both tables point to settle_bills). */
async function seedApp(db: Kysely<DB>): Promise<string> {
  const appId = `watermark-schema-${randomUUID()}`;
  await sql`INSERT INTO app.settle_bills (app_id, bill_id, generation_started_at)
    VALUES (${appId}, ${BILL_ID}, ${AT})`.execute(db);
  return appId;
}

/** A row of `relation` as its writer would insert it; the counter is left to its default. */
function rowOf(relation: Relation, appId: string, values: Row = {}): Row {
  if (relation === 'settle_batches') {
    return {
      batch_id: randomUUID(),
      app_id: appId,
      bill_id: BILL_ID,
      platform: 'taobao',
      kind: 'main',
      status: 'DRAFT',
      settle_mode: 'IMMEDIATE',
      order_count: 0,
      ...values,
    };
  }
  return {
    settle_run_id: randomUUID(),
    app_id: appId,
    bill_id: BILL_ID,
    part_started_at: new Date(AT),
    updated_at: new Date(AT),
    ...values,
  };
}

/** The counter of the row whose key is `id` (empty when there is no such row). */
async function counterOf(
  db: Kysely<DB>,
  counter: (typeof COUNTERS)[number],
  id: unknown,
): Promise<number[]> {
  const result = await sql<{ n: number }>`
    SELECT ${sql.ref(counter.column)} AS n FROM ${sql.table(`app.${counter.relation}`)}
    WHERE ${sql.ref(counter.key)} = ${id}`.execute(db);
  return result.rows.map((r) => r.n);
}

it(
  '[AC-B2-04zy#1] 结构：settle_batches.credited_count 与 settle_runs.published_credited_count 都是 integer、NOT NULL、默认 0（不用 SQL 时钟）；不给这一列插入时读回 0，显式写 NULL 被拒绝（23502）',
  async () => {
    await watermarkReady(p.db);
    expect(await counterColumns(p.db)).toEqual([
      {
        relation: 'settle_batches',
        column: 'credited_count',
        type: 'int4',
        nullable: false,
        default_expr: '0',
      },
      {
        relation: 'settle_runs',
        column: 'published_credited_count',
        type: 'int4',
        nullable: false,
        default_expr: '0',
      },
    ]);

    const appId = await seedApp(p.db);
    for (const counter of COUNTERS) {
      const row = rowOf(counter.relation, appId);
      expect(await sqlState(insert(p.db, counter.relation, row)), counter.column).toBe('ok');
      expect(await counterOf(p.db, counter, row[counter.key])).toEqual([0]);

      const empty = rowOf(counter.relation, appId, { [counter.column]: null });
      expect(await sqlState(insert(p.db, counter.relation, empty)), counter.column).toBe('23502');
      expect(await counterOf(p.db, counter, empty[counter.key])).toEqual([]);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#1] 约束：settle_batches_credited_count_check 与 settle_runs_published_credited_count_check 存在（CHECK、已校验、在各自的表上）；插入或改成负数报 23514 且行不变，0 与正数可写',
  async () => {
    await watermarkReady(p.db);
    const found = await sql<{ name: string; relation: string; kind: string; valid: boolean }>`
      SELECT c.conname::text AS name, t.relname::text AS relation, c.contype::text AS kind,
        c.convalidated AS valid
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'app' AND c.conname IN (${sql.join(COUNTERS.map((c) => c.check))})
      ORDER BY c.conname`.execute(p.db);
    expect(found.rows).toEqual([
      {
        name: 'settle_batches_credited_count_check',
        relation: 'settle_batches',
        kind: 'c',
        valid: true,
      },
      {
        name: 'settle_runs_published_credited_count_check',
        relation: 'settle_runs',
        kind: 'c',
        valid: true,
      },
    ]);

    const appId = await seedApp(p.db);
    for (const counter of COUNTERS) {
      const negative = rowOf(counter.relation, appId, { [counter.column]: -1 });
      expect(await sqlState(insert(p.db, counter.relation, negative)), counter.check).toBe('23514');
      expect(await counterOf(p.db, counter, negative[counter.key])).toEqual([]);

      const zero = rowOf(counter.relation, appId, { [counter.column]: 0 });
      expect(await sqlState(insert(p.db, counter.relation, zero)), counter.column).toBe('ok');
      const positive = rowOf(counter.relation, appId, { [counter.column]: 2 });
      expect(await sqlState(insert(p.db, counter.relation, positive)), counter.column).toBe('ok');
      expect(await counterOf(p.db, counter, positive[counter.key])).toEqual([2]);

      const below = sql`UPDATE ${sql.table(`app.${counter.relation}`)}
        SET ${sql.ref(counter.column)} = ${sql.ref(counter.column)} - 1
        WHERE ${sql.ref(counter.key)} = ${zero[counter.key]}`;
      expect(await sqlState(below.execute(p.db)), counter.check).toBe('23514');
      expect(await counterOf(p.db, counter, zero[counter.key])).toEqual([0]);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#1] 授权：couli_app 对两列都有列级 UPDATE（另有 SELECT、INSERT），并能以 +1 实际改写两列',
  async () => {
    await watermarkReady(p.db);
    for (const counter of COUNTERS) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
        const granted = await sql<{ granted: boolean }>`
          SELECT has_column_privilege('couli_app', ${`app.${counter.relation}`},
            ${counter.column}, ${privilege}) AS granted`.execute(p.db);
        expect(granted.rows, `${counter.column}/${privilege}`).toEqual([{ granted: true }]);
      }
    }

    const appId = await seedApp(p.db);
    for (const counter of COUNTERS) {
      const row = rowOf(counter.relation, appId);
      await insert(p.db, counter.relation, row);
      const raised = await sql`UPDATE ${sql.table(`app.${counter.relation}`)}
        SET ${sql.ref(counter.column)} = ${sql.ref(counter.column)} + 1
        WHERE ${sql.ref(counter.key)} = ${row[counter.key]}`.execute(p.db);
      expect(raised.numAffectedRows, counter.column).toBe(1n);
      expect(at(await counterOf(p.db, counter, row[counter.key]), 0)).toBe(1);
    }
  },
  TIMEOUT,
);
