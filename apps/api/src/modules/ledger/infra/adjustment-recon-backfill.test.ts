// B2-17 implementer unit test (no database; reads the migration's text only): the backfill of the
// link table in migration *_adjustment-recon-diffs.sql (task §16.1, D10-3237 (一), D10-3239). The
// file has exactly one INSERT … SELECT into app.adjustment_recon_diffs, placed after the table and
// its partial unique index, with the conditions of §16.1. The rule tests
// (test/spec/ledger/recon-plan-b/backfill*.int.test.ts) run that statement on PostgreSQL.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const MIGRATIONS = new URL('../../../../../../db/migrations/', import.meta.url);

function migration(): string {
  const names = readdirSync(MIGRATIONS).filter((name) =>
    /^\d{4}_adjustment-recon-diffs\.sql$/u.test(name),
  );
  expect(names).toHaveLength(1);
  return readFileSync(new URL(names[0]!, MIGRATIONS), 'utf8');
}

/** The statements of the file: comments dropped, split at semicolons (no quoted `;` in it). */
function statements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter((statement) => statement !== '');
}

function theBackfill(): { all: string[]; insert: string } {
  const all = statements(migration());
  const inserts = all.filter((s) => /insert\s+into\s+app\.adjustment_recon_diffs\b/iu.test(s));
  expect(inserts, '恰一条往关联表插入的语句').toHaveLength(1);
  return { all, insert: inserts[0]! };
}

it('[AC-B2-17#38] 迁移里恰一条 INSERT INTO app.adjustment_recon_diffs … SELECT …，排在建表与部分唯一索引之后', () => {
  const { all, insert } = theBackfill();
  expect(insert).toMatch(/^INSERT INTO app\.adjustment_recon_diffs \(.*\) SELECT /u);
  const table = all.findIndex((s) => /^CREATE TABLE app\.adjustment_recon_diffs\b/u.test(s));
  const index = all.findIndex((s) =>
    /^CREATE UNIQUE INDEX adjustment_recon_diffs_active_key\b/u.test(s),
  );
  const at = all.indexOf(insert);
  expect(table).toBeGreaterThanOrEqual(0);
  expect(index).toBeGreaterThan(table);
  expect(at).toBeGreaterThan(index);
  // Not wrapped: no DO block or function in the file.
  expect(all.some((s) => /^DO\b|CREATE (OR REPLACE )?FUNCTION/iu.test(s))).toBe(false);
});

it('[AC-B2-17#39] 回填条件：APPROVED、不是红冲单、没被红冲、ref_type recon_diff、同一应用、ledger_mismatch；六列取值', () => {
  const { insert } = theBackfill();
  expect(insert).toContain(
    '(app_id, adjust_id, recon_diff_id, user_id, reversed_by_adjust_id, created_at)',
  );
  expect(insert).toContain('a.app_id, a.adjust_id, d.id, a.user_id, NULL::uuid, a.reviewed_at');
  expect(insert).toContain("a.status = 'APPROVED'");
  expect(insert).toContain('a.reverses_adjust_id IS NULL');
  expect(insert).toMatch(
    /NOT EXISTS \( SELECT 1 FROM app\.admin_adjustments v WHERE v\.app_id = a\.app_id AND v\.reverses_adjust_id = a\.adjust_id \)/u,
  );
  expect(insert).toContain("r.ref ->> 'ref_type' = 'recon_diff'");
  expect(insert).toContain("jsonb_typeof(r.ref) = 'object'");
  expect(insert).toContain('d.app_id = a.app_id');
  expect(insert).toContain("d.type = 'ledger_mismatch'");
  // Case-insensitive and cast-free: a ref_id that is not a UUID matches nothing, never errors.
  expect(insert).toContain("d.id::text = lower(r.ref ->> 'ref_id')");
  expect(insert).not.toMatch(/->> 'ref_id'\)?::uuid/u);
  // Nothing of the diff's status is a condition, and the statement writes nothing else.
  expect(insert).not.toMatch(/d\.status/u);
  expect(insert).not.toMatch(/\bUPDATE\b|\bON CONFLICT\b/iu);
});

it('[AC-B2-17#41] 迁移不改差错单与调账单：文件里没有对 recon_diffs / admin_adjustments 的 UPDATE、DELETE、INSERT', () => {
  const { all } = theBackfill();
  for (const s of all) {
    expect(s).not.toMatch(
      /^(UPDATE|DELETE FROM|INSERT INTO) app\.(recon_diffs|admin_adjustments)\b/iu,
    );
  }
});
