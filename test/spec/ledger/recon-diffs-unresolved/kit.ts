// B2-02zc rule-test kit (claude-independent, SPEC_REF d49d8aa5): 08 BR-FUND-19 细则「账务自检异常」
// 第 4 条「同一个未解决的异常不按会计日重复：差错单未结案期间，之后各会计日再查出同一差异，不新
// 生成差错单、不新增冻结记录；去重的做法由工程定」and 正文「同一个未解决的差异（差错单未结案）在
// 之后的会计日再被查出时，不再新生成差错单、不再新增冻结记录」. Engineering's way (编排 D10-2224 B ①,
// ops/tasks/B2-02zc.yaml): migration `<NNNN>_recon-diffs-unresolved-internal-key.sql` adds the
// partial unique index recon_diffs_unresolved_internal_key (app_id, type, ref_id) WHERE type =
// 'ledger_mismatch' AND status IN ('open', 'processing'); registerReconDiffOnce reads the unresolved
// row back on that conflict (inserted = false, never rewritten); the daily-check executor and the
// credit post-check already hold only on inserted. Concluded (adjusted / written_off / closed) →
// the same difference opens a new ticket again. External differences (union_mismatch, …) stay one
// per (app_id, type, period, ref_id). Scope (编排 D10-2280): recon_diffs and withdraw_holds only.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app. The executor's ports and fixtures
// come from the read-only kits of daily-check-execute / recon-diffs / ledger-owned. No real data.
// The migration-over-duplicates check needs a database without the index; test roles never run
// DDL on the migrated clone, so it uses a scratch database of the run's factory role (CREATEDB
// only, never superuser; named like the clones so the global teardown drops leftovers) holding
// the two tables exactly as db/schema.sql declares them, minus that one index.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb, pgUrl, type DB } from '@couli/db';
import type { TestDbContext } from '@couli/db/testing';
import { sql, type Kysely, type Selectable } from 'kysely';
import { expect, inject } from 'vitest';
import { seedHandler } from '../../db/settlement/ledger-owned/kit.ts';

/** The third and fourth checked days (D = 2032-06-15, D+1 = 2032-06-16 from the executor kit). */
export const THIRD_DAY = '2032-06-17';
export const FOURTH_DAY = '2032-06-18';
/** 01:00 +08:00 of the day after D+1 / D+2 / D+3: the scheduled runs of those days. */
export const RUN_NEXT = '2032-06-16T17:00:00.000Z';
export const RUN_THIRD = '2032-06-17T17:00:00.000Z';
export const RUN_FOURTH = '2032-06-18T17:00:00.000Z';
/** The moment a ticket is concluded in the fixtures (between the D+1 and D+2 runs). */
export const CONCLUDED_AT = '2032-06-17T03:00:00.000Z';

export const INDEX = 'recon_diffs_unresolved_internal_key';
export const UNRESOLVED = ['open', 'processing'] as const;
export const CONCLUDED = ['adjusted', 'written_off', 'closed'] as const;
export type Concluded = (typeof CONCLUDED)[number];

type DiffRow = Selectable<DB['recon_diffs']>;
type HoldRow = Selectable<DB['withdraw_holds']>;

/**
 * Moves a ticket the way the console would leave it (status, handler of the same app; closed_at
 * only for a concluded status) and returns the stored row. Only the columns couli_app may update.
 */
export async function moveTo(
  db: Kysely<DB>,
  diff: DiffRow,
  status: 'processing' | Concluded,
  at: string,
): Promise<DiffRow> {
  const handler = await seedHandler(db, diff.app_id);
  await db
    .updateTable('recon_diffs')
    .set({
      status,
      handler_id: handler,
      closed_at: status === 'processing' ? null : at,
      updated_at: at,
    })
    .where('id', '=', diff.id)
    .execute();
  const rows = await db.selectFrom('recon_diffs').selectAll().where('id', '=', diff.id).execute();
  expect(rows, `recon diff ${diff.id} moved to ${status}`).toHaveLength(1);
  expect(rows[0]!.status).toBe(status);
  return rows[0]!;
}

export interface Concluding {
  /** The concluded ticket as stored. */
  readonly diff: DiffRow;
  /** The holds of the ticket this conclusion released, as stored afterwards. */
  readonly released: HoldRow[];
  /** released_by as the console's conclusion writes it. */
  readonly releasedBy: string;
}

/**
 * Concludes a ticket as the console leaves it (moveTo) and releases its holds the way the closing
 * entries do on the same moment (released_at = `at`; released_by = the handler for close, as
 * closeAdminReconDiff, `admin:<handler>` for write-off, as writeOffAdminReconDiff; adjusted has no
 * releasing entry for ledger_mismatch and is given the close form). Only unreleased holds whose
 * source_ref is exactly `recon_diff:<id>` are touched.
 */
export async function conclude(
  db: Kysely<DB>,
  diff: DiffRow,
  status: Concluded,
  at: string,
): Promise<Concluding> {
  const moved = await moveTo(db, diff, status, at);
  expect(moved.handler_id, 'handler of the concluded ticket').not.toBeNull();
  const handler = moved.handler_id!;
  const releasedBy = status === 'written_off' ? `admin:${handler}` : handler;
  const released = await db
    .updateTable('withdraw_holds')
    .set({ released_at: at, released_by: releasedBy })
    .where('app_id', '=', diff.app_id)
    .where('source_ref', '=', `recon_diff:${diff.id}`)
    .where('released_at', 'is', null)
    .returningAll()
    .execute();
  return { diff: moved, released, releasedBy };
}

/**
 * Polls until backend `waiter` waits on `holder` (true) or `done()` turns true first (false): a
 * contender that never waits must not hang the test, it simply reports no wait.
 */
export async function waitsOn(
  db: Kysely<DB>,
  waiter: number,
  holder: number,
  done: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (done()) return false;
    const result = await sql<{ blocked: boolean }>`
      SELECT ${holder} = ANY(pg_blocking_pids(${waiter})) AS blocked`.execute(db);
    if (result.rows[0]?.blocked === true) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}

/**
 * The migration that adds the index, located by its file-name suffix (no number reserved), as the
 * file says it (the text the migrator runs). A missing file is an assertion failure.
 */
export function unresolvedMigrationFile(): string {
  const directory = new URL('../../../../db/migrations/', import.meta.url);
  const names = readdirSync(directory).filter((name) =>
    /^\d{4}_recon-diffs-unresolved-internal-key\.sql$/u.test(name),
  );
  expect(names, '按后缀定位迁移，不预留编号').toHaveLength(1);
  return readFileSync(new URL(names[0]!, directory), 'utf8');
}

/** The same migration with comments stripped and quotes removed (for reading its DDL). */
export function unresolvedMigrationSource(): string {
  return unresolvedMigrationFile()
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/--[^\n]*/gu, '')
    .replace(/"/gu, '');
}

/** Tables the migration-over-duplicates check rebuilds from db/schema.sql. */
const PRE_INDEX_TABLES = ['recon_diffs', 'withdraw_holds'] as const;

/**
 * The DDL of app.recon_diffs and app.withdraw_holds as db/schema.sql declares them (table with its
 * CHECK constraints, primary key and unique constraints, every index) except the index the
 * migration adds: the state of the database right before that migration. Foreign keys are left
 * out (their targets are not rebuilt). Missing pieces are assertion failures.
 */
export function preIndexDdl(): string[] {
  const schema = readFileSync(new URL('../../../../db/schema.sql', import.meta.url), 'utf8');
  const statements: string[] = [];
  for (const table of PRE_INDEX_TABLES) {
    const create = schema.match(
      new RegExp(`^CREATE TABLE app\\.${table} \\([\\s\\S]*?^\\);`, 'mu'),
    );
    expect(create, `db/schema.sql 声明 app.${table}`).not.toBeNull();
    statements.push(create![0]);
    const keys = [
      ...schema.matchAll(
        new RegExp(
          `^ALTER TABLE ONLY app\\.${table}\\s+ADD CONSTRAINT \\w+ (?:PRIMARY KEY|UNIQUE) [^;]*;`,
          'gmu',
        ),
      ),
    ];
    expect(keys.length, `app.${table} 主键`).toBeGreaterThan(0);
    statements.push(...keys.map((match) => match[0]));
    for (const match of schema.matchAll(
      new RegExp(`^CREATE (?:UNIQUE )?INDEX (\\w+) ON app\\.${table} [^;]*;`, 'gmu'),
    )) {
      if (match[1] !== INDEX) statements.push(match[0]);
    }
  }
  return statements;
}

export interface Scratch {
  /** The scratch database as its owner (the run's factory role). */
  readonly db: Kysely<DB>;
  drop(): Promise<void>;
}

/** An empty database (from template0) owned by the run's factory role; drop() removes it. */
export async function scratchDatabase(): Promise<Scratch> {
  const context: TestDbContext = inject('couliTestDb');
  const name = `couli_t_${context.runId}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const factory = createDb({ connectionString: context.factoryUrl, max: 1 });
  try {
    await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(factory);
  } finally {
    await destroyDb(factory);
  }
  const db = createDb({ connectionString: pgUrl(context.factoryUrl, { database: name }), max: 1 });
  return {
    db,
    async drop() {
      await destroyDb(db);
      const again = createDb({ connectionString: context.factoryUrl, max: 1 });
      try {
        await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(again);
      } finally {
        await destroyDb(again);
      }
    },
  };
}
