import { readdirSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { TABLES, columns, foreignKeys, harness, ready, repoFile, type Table } from './kit.ts';

const h = harness(createTestDatabase);

// 必需列以契约 AdminAdjustment / AdminBadDebtWriteoff 与 04 §3.2（D10-534）为准；只核对这些列的类型与可空性，
// 不钉死列集合（契约 additionalProperties:false 管的是响应形状，不是库表）。
const SHAPE: Record<Table, Record<string, { types: string[]; nullable: boolean }>> = {
  admin_adjustments: {
    adjust_id: { types: ['uuid'], nullable: false },
    app_id: { types: ['text'], nullable: false },
    user_id: { types: ['uuid'], nullable: false },
    direction: { types: ['text'], nullable: false },
    amount_fen: { types: ['int8'], nullable: true },
    reason_code: { types: ['text'], nullable: false },
    refs: { types: ['jsonb'], nullable: false },
    contra_subject: { types: ['text'], nullable: false },
    contra_platform: { types: ['text'], nullable: true },
    note: { types: ['text'], nullable: true },
    status: { types: ['text'], nullable: false },
    reverses_adjust_id: { types: ['uuid'], nullable: true },
    created_by: { types: ['uuid'], nullable: true },
    created_at: { types: ['timestamptz'], nullable: false },
    reviewed_by: { types: ['uuid'], nullable: true },
    reviewed_at: { types: ['timestamptz'], nullable: true },
    reject_note: { types: ['text'], nullable: true },
    voucher_id: { types: ['uuid'], nullable: true },
    row_version: { types: ['int4', 'int8'], nullable: false },
  },
  bad_debt_writeoffs: {
    id: { types: ['uuid'], nullable: false },
    app_id: { types: ['text'], nullable: false },
    account_id: { types: ['uuid'], nullable: false },
    negative_since: { types: ['date'], nullable: false },
    candidate_fen: { types: ['int8'], nullable: false },
    status: { types: ['text'], nullable: false },
    initiator_id: { types: ['uuid'], nullable: true },
    approver_id: { types: ['uuid'], nullable: true },
    approved_at: { types: ['timestamptz'], nullable: true },
    voucher_id: { types: ['uuid'], nullable: true },
    created_at: { types: ['timestamptz'], nullable: false },
    row_version: { types: ['int4', 'int8'], nullable: false },
  },
};
// 契约明写「读时派生、不入库」的字段（contracts/openapi.yaml AdminBadDebtWriteoff：
// `negative_days` … derived and not stored），不得落成列。
const DERIVED: Record<Table, string[]> = {
  admin_adjustments: [],
  bad_debt_writeoffs: ['negative_days'],
};

const FOREIGN: Record<Table, { target: string; pairs: string[] }[]> = {
  admin_adjustments: [
    { target: 'app.users', pairs: ['app_id→app_id', 'user_id→id'] },
    { target: 'app.admin_users', pairs: ['app_id→app_id', 'created_by→id'] },
    { target: 'app.admin_users', pairs: ['app_id→app_id', 'reviewed_by→id'] },
    { target: 'app.ledger_vouchers', pairs: ['app_id→app_id', 'voucher_id→id'] },
    { target: 'app.admin_adjustments', pairs: ['app_id→app_id', 'reverses_adjust_id→adjust_id'] },
  ],
  bad_debt_writeoffs: [
    { target: 'app.ledger_accounts', pairs: ['app_id→app_id', 'account_id→id'] },
    { target: 'app.admin_users', pairs: ['app_id→app_id', 'initiator_id→id'] },
    { target: 'app.admin_users', pairs: ['app_id→app_id', 'approver_id→id'] },
    { target: 'app.ledger_vouchers', pairs: ['app_id→app_id', 'voucher_id→id'] },
  ],
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

it.each(TABLES)(
  '[AC-B2-12a#1] %s 的必需列类型与可空性与契约一致，派生字段不入库，金额 bigint 分，默认值只有 created_at 的时钟',
  async (table) => {
    await ready(h.app);
    const actual = await columns(h.app, table);
    const expected = SHAPE[table];
    const names = actual.map((c) => c.name);
    for (const name of Object.keys(expected)) expect(names, `${table}.${name}`).toContain(name);
    for (const name of DERIVED[table]) {
      expect(names, `${table}.${name} 读时派生，不得落库`).not.toContain(name);
    }
    for (const column of actual) {
      const spec = expected[column.name];
      if (column.name.endsWith('_fen')) expect(column.type, `${table}.${column.name}`).toBe('int8');
      if (!spec) continue;
      expect(spec.types, `${table}.${column.name} 类型`).toContain(column.type);
      expect(column.nullable, `${table}.${column.name} 可空`).toBe(spec.nullable);
    }
    for (const column of actual) {
      const expression = (column.expression ?? '').toLowerCase();
      expect(expression, `${table}.${column.name} 不得用 uuidv7() 默认值`).not.toContain('uuidv7');
      if (!['created_at', 'updated_at'].includes(column.name)) {
        expect(expression, `${table}.${column.name} 不得用 SQL 时钟`).not.toMatch(
          /now\(|clock_timestamp|current_timestamp|current_date|localtimestamp|statement_timestamp|transaction_timestamp/,
        );
      }
    }
    const createdAt = actual.find((c) => c.name === 'created_at');
    expect(createdAt?.expression ?? '').toMatch(/now\(\)|current_timestamp/i);
  },
);

it.each(TABLES)('[AC-B2-12a#2] %s 的外键都带 app_id、指向契约父表，且不级联', async (table) => {
  await ready(h.app);
  const actual = await foreignKeys(h.app, table);
  const shaped = actual.map((fk) => ({
    target: fk.target,
    pairs: fk.keys.map((key, i) => `${key}→${fk.refs[i] ?? ''}`).sort(),
  }));
  expect(shaped).toHaveLength(FOREIGN[table].length);
  expect(shaped).toEqual(
    expect.arrayContaining(
      FOREIGN[table].map((fk) => ({ target: fk.target, pairs: [...fk.pairs].sort() })),
    ),
  );
  for (const fk of actual) {
    // a = NO ACTION，r = RESTRICT；c / n / d（级联、置空、置默认）一律不允许（db/AGENTS.md 第 7 条）。
    expect(['a', 'r'], `${fk.name} ON DELETE`).toContain(fk.on_delete);
    expect(['a', 'r'], `${fk.name} ON UPDATE`).toContain(fk.on_update);
  }
});

it.each(TABLES)('[AC-B2-12a#3] %s 的 db/schema.sql 快照与迁移后的库一致', async (table) => {
  await ready(h.app);
  const schema = readFileSync(repoFile('db/schema.sql'), 'utf8');
  const block = new RegExp(`^CREATE TABLE app\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`, 'm').exec(
    schema,
  )?.[1];
  expect(block, `db/schema.sql 缺 app.${table}`).toEqual(expect.any(String));
  const snapshot = [...(block ?? '').matchAll(/^ {4}([a-z_][a-z0-9_]*) /gm)].map((m) => m[1]!);
  const live = (await columns(h.app, table)).map((c) => c.name);
  expect([...snapshot].sort()).toEqual([...live].sort());
  expect(schema).toContain(`GRANT SELECT,INSERT ON TABLE app.${table} TO couli_app;`);
  expect(schema).toContain(`GRANT SELECT ON TABLE app.${table} TO couli_readonly;`);
  for (const fk of FOREIGN[table]) {
    const column = fk.pairs[1]!.split('→')[0]!;
    expect(schema, `${table}.${column} 外键在快照里`).toMatch(
      new RegExp(
        `ALTER TABLE ONLY app\\.${table}\\n\\s+ADD CONSTRAINT \\w+ FOREIGN KEY \\((app_id, ${column}|${column}, app_id)\\) REFERENCES ${fk.target.replace('.', '\\.')}\\(`,
      ),
    );
  }
});

it('[AC-B2-12a#4] 两表由同一个新迁移创建，迁移只写 SQL、不改已冻结的迁移', async () => {
  await ready(h.app);
  const directory = repoFile('db/migrations/');
  const files = readdirSync(directory).filter((name) => /^\d{4}_[a-z0-9-]+\.sql$/.test(name));
  const creators = (table: Table) =>
    files.filter((name) =>
      new RegExp(`CREATE TABLE (IF NOT EXISTS )?app\\.${table}\\b`, 'i').test(
        stripComments(readFileSync(new URL(name, directory), 'utf8')),
      ),
    );
  const adjustments = creators('admin_adjustments');
  const writeoffs = creators('bad_debt_writeoffs');
  expect(adjustments).toHaveLength(1);
  expect(writeoffs).toEqual(adjustments);
  const name = adjustments[0] ?? '';
  // 0122 为 B2-04zh（已合并）；本单取其后的空号。
  expect(Number(name.slice(0, 4))).toBeGreaterThan(122);
  expect(readFileSync(new URL(name, directory), 'utf8').startsWith('-- Up Migration')).toBe(true);
});
