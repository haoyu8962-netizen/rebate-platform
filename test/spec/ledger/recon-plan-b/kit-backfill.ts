// B2-17 rule-test helpers of the backfill (claude-independent, SPEC_REF 1025764b; 编排 D10-3237 (一),
// D10-3239): migration *_adjustment-recon-diffs.sql carries, after creating the link table and its
// partial unique index, exactly one `INSERT INTO app.adjustment_recon_diffs … SELECT …;` that gives
// the forms executed before the migration their link rows. The test database ran the migration while
// it was empty (nothing backfilled), so a test seeds forms the way earlier filings left them
// (../admin-adjustments/kit.ts seedForm) and runs that very statement, its text taken from the file,
// once as couli_app (SELECT on admin_adjustments / recon_diffs, INSERT on the link table).
// A file with no such statement fails as an assertion before anything is executed.
import { readdirSync, readFileSync } from 'node:fs';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { ACTIVE_KEY, LINKS, outcome, type PgOutcome } from './kit.ts';

const MIGRATIONS = new URL('../../../../db/migrations/', import.meta.url);

/** The text of the one migration named *_adjustment-recon-diffs.sql. */
export function migrationText(): string {
  const names = readdirSync(MIGRATIONS).filter((name) =>
    /^\d{4}_adjustment-recon-diffs\.sql$/u.test(name),
  );
  expect(names, '按后缀定位迁移 *_adjustment-recon-diffs.sql').toHaveLength(1);
  return readFileSync(new URL(names[0]!, MIGRATIONS), 'utf8');
}

/** The index just after the quoted text that starts at `start` (`quote` doubled inside). */
function afterQuoted(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/**
 * The statements of a SQL text, comments dropped, split at top-level semicolons (string literals,
 * quoted identifiers and dollar-quoted bodies kept whole), each trimmed; empty ones left out.
 */
export function sqlStatements(text: string): string[] {
  const statements: string[] = [];
  const dollar = /\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/uy;
  let current = '';
  let i = 0;
  const flush = () => {
    const statement = current.trim();
    if (statement !== '') statements.push(statement);
    current = '';
  };
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      current += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      current += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = afterQuoted(text, i, ch);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      dollar.lastIndex = i;
      const tag = dollar.exec(text);
      if (tag !== null) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? text.length : close + tag[0].length;
        current += text.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return statements;
}

const INSERT_LINKS = /\binsert\s+into\s+(?:"?app"?\s*\.\s*)?"?adjustment_recon_diffs\b/iu;

/** Every statement of the migration that inserts into the link table. */
export function backfillStatements(): string[] {
  return sqlStatements(migrationText()).filter((statement) => INSERT_LINKS.test(statement));
}

/**
 * The one backfill statement of the migration: `INSERT INTO app.adjustment_recon_diffs … SELECT …`,
 * asserted to be the only statement inserting into the link table.
 */
export function theBackfill(): string {
  const found = backfillStatements();
  expect(
    found,
    `迁移 *_adjustment-recon-diffs.sql 里恰有一条回填语句 INSERT INTO app.${LINKS} … SELECT …`,
  ).toHaveLength(1);
  const statement = found[0]!;
  const head = /^insert\s+into\s+app\.adjustment_recon_diffs\b/iu.test(statement);
  expect(head, `以 INSERT INTO app.${LINKS} 开头：${statement}`).toBe(true);
  expect(statement, 'INSERT … SELECT').toMatch(/\bselect\b/iu);
  return statement;
}

/** Runs the backfill statement once as couli_app; 'ok' or the error's SQLSTATE and constraint. */
export function runBackfill(db: Kysely<DB>, statement: string): Promise<PgOutcome> {
  return outcome(sql.raw(statement).execute(db));
}

export const OK: PgOutcome = { code: 'ok', constraint: null };
export const ACTIVE_CONFLICT: PgOutcome = { code: '23505', constraint: ACTIVE_KEY };

/** The number of link rows of every app. */
export async function allLinkCount(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.adjustment_recon_diffs`.execute(db);
  return Number(result.rows[0]?.n ?? '0');
}
