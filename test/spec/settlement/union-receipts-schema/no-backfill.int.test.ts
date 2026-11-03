// B2-04zh rule tests (编排裁定 D10-538, D10-589; db/AGENTS.md 迁移规则 3): the migration only adds
// app.union_receipts with its constraints, indexes and grants. No backfill from ledger_vouchers or
// ledger_entries, no change to any existing object, no trigger or function.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { TIMEOUT, close, migration, open, ready, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

// All a migration of this task may contain. Anything else (a write, a DO block, a trigger, a
// function, a statement on another table) is outside the task.
const ALLOWED = [
  /^SET\s+LOCAL\s+\w+\s*(?:=|TO\b)/i,
  /^SELECT\s+(?:pg_catalog\.)?set_config\s*\(/i,
  /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?app\.union_receipts\s*\(/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(?:ONLY\s+)?app\.union_receipts\b/i,
  /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?app\.union_receipts\b/i,
  /^GRANT\s[^;]*\bON\s+(?:TABLE\s+)?app\.union_receipts\s+TO\s/i,
  /^REVOKE\s[^;]*\bON\s+(?:TABLE\s+)?app\.union_receipts\s+FROM\s/i,
  /^COMMENT\s+ON\s+(?:TABLE|COLUMN)\s+app\.union_receipts\b/i,
];

it('[AC-B2-04zh#22] 只加表、不回填：迁移后新表为空，也没有写出 RECEIPT 凭证', async () => {
  await ready(h.app);
  const receipts = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.union_receipts
  `.execute(h.app);
  expect(receipts.rows).toEqual([{ n: '0' }]);
  const vouchers = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.ledger_vouchers WHERE uniq_key LIKE 'RECEIPT:%'
  `.execute(h.app);
  expect(vouchers.rows).toEqual([{ n: '0' }]);
});

it('[AC-B2-04zh#23] 迁移源文件名是 <序号>_union-receipts.sql，里面只有这张新表及其约束、索引、授权，不写数据、不碰已有对象', async () => {
  await ready(h.app);
  const { name, source } = migration();
  expect(name).toMatch(/^\d{4}_union-receipts\.sql$/);
  const statements = source
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    expect(
      ALLOWED.some((pattern) => pattern.test(statement)),
      statement,
    ).toBe(true);
  }
});

it('[AC-B2-04zh#24] 新表上没有触发器：不变性靠授权，迁移不引入业务逻辑', async () => {
  await ready(h.app);
  const triggers = await sql<{ name: string }>`
    SELECT tgname::text AS name FROM pg_trigger
    WHERE tgrelid = to_regclass('app.union_receipts') AND NOT tgisinternal
  `.execute(h.app);
  expect(triggers.rows).toEqual([]);
});
