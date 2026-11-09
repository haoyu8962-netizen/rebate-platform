// B2-04zzr / BR-FUND-19 ⑧ with the restore cut (编排 D10-1126 ②, D10-1134 (3)): execute the
// registered replacement SQL, never emulate it. db/invariants is append-only: the replacement
// 10_invalid-still-credited-since-restore.sql and its superseded.json entry for
// 08_invalid-still-credited.sql belong to the implementation phase (B2-02l precedent), so nothing is
// written here and a missing file fails as an assertion before anything reads it (never ENOENT).
// Read the way ../../db/ledger/invariants-reverse/kit.ts reads its replacements (read only).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { Result } from '../../db/ledger/invariants/kit.ts';

const DIRECTORY = new URL('../../../../db/invariants/ledger/', import.meta.url);
export const LEGACY = '08_invalid-still-credited.sql';
export const REPLACEMENT = '10_invalid-still-credited-since-restore.sql';

interface Replacement {
  file: string;
  replaced_by: string;
  reason: string;
}
interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

/** superseded.json registers 08 as replaced by 10; both files exist; 08 is still the only 08_ file. */
export function registration(): Replacement {
  const path = new URL('superseded.json', DIRECTORY);
  expect(existsSync(path), 'superseded.json').toBe(true);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  expect(Array.isArray(parsed), 'superseded.json is an array').toBe(true);
  const rows = parsed as Replacement[];
  const found = rows.filter((row) => row.file === LEGACY);
  expect(found, `superseded.json registers ${LEGACY}`).toHaveLength(1);
  const entry = found[0]!;
  expect(entry.replaced_by).toBe(REPLACEMENT);
  expect(typeof entry.reason).toBe('string');
  expect(entry.reason.trim().length).toBeGreaterThan(0);
  expect(existsSync(new URL(REPLACEMENT, DIRECTORY)), `${REPLACEMENT} exists`).toBe(true);
  const names = readdirSync(DIRECTORY);
  expect(names.filter((name) => name.startsWith('08_'))).toEqual([LEGACY]);
  expect(names.filter((name) => name.startsWith('10_'))).toEqual([REPLACEMENT]);
  return entry;
}

/** The replacement's raw text (header comment included). */
export function replacementText(): string {
  registration();
  return readFileSync(new URL(REPLACEMENT, DIRECTORY), 'utf8');
}

/** The replacement as one read-only SELECT without comments. */
function query(): string {
  const raw = replacementText();
  const text = raw.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? token : ' ',
  );
  const tokens = text.replace(/'(?:''|[^'])*'/g, ' ');
  expect(tokens.trim()).toMatch(/^(?:SELECT|WITH)\b/i);
  expect(tokens.trim().replace(/;\s*$/, '')).not.toContain(';');
  expect(tokens).not.toMatch(
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO|COPY|INTO)\b/i,
  );
  expect(tokens).not.toMatch(
    /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(|\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b/i,
  );
  return text.trim().replace(/;\s*$/, '');
}

/**
 * Runs `run` on a fresh database; check(count) executes the replacement as couli_readonly in a
 * read-only repeatable-read transaction and checks the output shape: invariant '08' (still ⑧),
 * checked_rows = `count` on every row (CREDITED sub-orders, never multiplied by joins).
 */
export async function scenario(
  create: () => Promise<Database>,
  run: (fixture: {
    db: Kysely<DB>;
    check(count: bigint, date?: string): Promise<Result[]>;
  }) => Promise<void>,
): Promise<void> {
  const select = query();
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  try {
    await run({
      db,
      async check(count, date = '2032-06-15') {
        return reader
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            await sql`SET TRANSACTION READ ONLY`.execute(trx);
            await sql`SELECT set_config('couli.check_date', ${date}, true)`.execute(trx);
            const { rows } = await sql.raw<Result>(select).execute(trx);
            expect(rows.length, 'differences or exactly one none row').toBeGreaterThan(0);
            for (const row of rows) {
              expect(Object.keys(row).sort()).toEqual([
                'account_id',
                'app_id',
                'checked_rows',
                'detail',
                'invariant',
                'scope',
              ]);
              expect(row.invariant).toBe('08');
              expect(row.checked_rows).toBe(count);
              expect(['none', 'account', 'global']).toContain(row.scope);
            }
            const types = await sql
              .raw<Record<string, string>>(
                `SELECT pg_typeof(checked_rows)::text AS count_type,
          pg_typeof(account_id)::text AS account_type, pg_typeof(detail)::text AS detail_type
          FROM (${select}\n) result LIMIT 1`,
              )
              .execute(trx);
            expect(types.rows).toEqual([
              { count_type: 'bigint', account_type: 'uuid', detail_type: 'jsonb' },
            ]);
            return rows;
          });
      },
    });
  } finally {
    await Promise.all([destroyDb(db), destroyDb(reader)]);
    await database.drop();
  }
}

/** Whether any difference row names the sub-order (its order_id or order_key in detail). */
export function reports(rows: readonly Result[], o: { id: string; key: string }): boolean {
  const leaves = (value: unknown): unknown[] =>
    value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value];
  return rows.some(
    (row) => row.scope !== 'none' && leaves(row.detail).some((v) => v === o.id || v === o.key),
  );
}
