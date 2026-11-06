// B2-04zw rule tests (上线缺口第 28 项 FU-B204ZFA-PAIR-CHECK, 编排裁定 D10-719 ③; 规划/08 BR-FUND-04 ⑦、
// BR-TEXT-09 CREDITED 幂等键 settle_run_id:part): app.settle_runs pairs part with last_outcome.
//   - part = 0 exactly when last_outcome is NULL (a run nothing has been published for yet);
//     part ≥ 1 exactly when last_outcome is 'done' or 'partial' (the outcome of the last publish).
//   - CHECK settle_runs_part_outcome_check, added NOT VALID by one migration and validated alone by
//     the next one (fund table: no VALIDATE in the adding transaction; precedent 0119 / 0120).
//   - No column or primary-key change (第 27 项 RUN-KEY 暂缓), no code change: the only writer
//     (saveRunPart) already writes part ≥ 1 with an outcome.
// Database access, rows and the bill they hang on come from the frozen B2-04zfa kit
// (settle-runs-schema); rows go through raw SQL there.
import { readdirSync, readFileSync } from 'node:fs';

import { sql } from 'kysely';
import { expect } from 'vitest';

import {
  insert,
  run,
  sqlState,
  stored,
  type Connection,
  type Row,
} from '../settle-runs-schema/kit.ts';

export {
  TIMEOUT,
  close,
  insert,
  open,
  ready,
  run,
  sqlState,
  stored,
  type Connection,
  type Harness,
  type Row,
} from '../settle-runs-schema/kit.ts';

export const CHECK = 'settle_runs_part_outcome_check';

export type Outcome = 'done' | 'partial' | null;
export type Pair = readonly [part: number, outcome: Outcome];

// Pairs a publish can never leave behind (AC-B2-04zw#2).
export const ILLEGAL: readonly Pair[] = [
  [0, 'done'],
  [0, 'partial'],
  [1, null],
  [2, null],
];
// Pairs the table holds today: never published, or published with an outcome (AC-B2-04zw#3).
export const LEGAL: readonly Pair[] = [
  [0, null],
  [1, 'done'],
  [2, 'partial'],
];

export function legal([part, outcome]: Pair): boolean {
  return (part === 0) === (outcome === null);
}

export interface Found {
  schema: string;
  relation: string;
  kind: string;
  valid: boolean;
  columns: string[];
}
/** Every constraint named CHECK in the database, with the columns it reads. */
export async function pairCheck(db: Connection): Promise<Found[]> {
  return (
    await sql<Found>`
      SELECT n.nspname::text AS schema, t.relname::text AS relation, c.contype::text AS kind,
        c.convalidated AS valid,
        ARRAY(
          SELECT a.attname::text FROM unnest(c.conkey) AS k(num)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
          ORDER BY a.attname
        ) AS columns
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.conname = ${CHECK}`.execute(db)
  ).rows;
}
/** Cases that only write legal pairs call this first, so they are red until the CHECK exists. */
export async function requirePairCheck(db: Connection): Promise<void> {
  expect(
    (await pairCheck(db)).map((c) => `${c.schema}.${c.relation}`),
    `missing ${CHECK}`,
  ).toEqual(['app.settle_runs']);
}

/** (part, last_outcome) of the stored row, empty when the row is not there. */
export async function pairOf(db: Connection, settle_run_id: unknown): Promise<Pair[]> {
  return (await stored(db, settle_run_id)).map(
    (row) => [row['part'] as number, row['last_outcome'] as Outcome] as const,
  );
}

/** A new run of a fresh app written with this pair; state is 'ok' or the SQLSTATE. */
export async function insertPair(db: Connection, pair: Pair): Promise<{ row: Row; state: string }> {
  const [part, last_outcome] = pair;
  const row = await run(db, { part, last_outcome });
  return { row, state: await sqlState(insert(db, row)) };
}

/** Moves an existing run to this pair (couli_app's column UPDATE); 'ok' or the SQLSTATE. */
export async function updatePair(
  db: Connection,
  settle_run_id: unknown,
  pair: Pair,
): Promise<string> {
  const [part, last_outcome] = pair;
  return sqlState(
    sql`UPDATE app.settle_runs
      SET part = ${part}, last_outcome = ${last_outcome}, row_version = row_version + 1
      WHERE settle_run_id = ${settle_run_id}`.execute(db),
  );
}

export interface Migration {
  name: string;
  number: number;
  /** Statements with comments and identifier quotes stripped and whitespace collapsed. */
  statements: string[];
}
/** Every migration file, in order; located by content, never by a fixed number. */
export function migrations(): Migration[] {
  const directory = new URL('../../../../db/migrations/', import.meta.url);
  return readdirSync(directory)
    .filter((name) => /^\d{4}_[a-z0-9-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      name,
      number: Number.parseInt(name.slice(0, 4), 10),
      statements: readFileSync(new URL(name, directory), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/--[^\n]*/g, '')
        .replace(/"/g, '')
        .split(';')
        .map((statement) => statement.replace(/\s+/g, ' ').trim())
        .filter((statement) => statement !== ''),
    }));
}
/** The statements that do something besides setting this transaction's timeouts. */
export function body(migration: Migration): string[] {
  return migration.statements.filter((statement) => !/^SET LOCAL\b/i.test(statement));
}
