import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { TABLES, TOTALS, columns, harness, indexes, migrationSource, ready } from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-04b#1] 04 的差错单列齐全，金额 bigint，S4 新列及待处理信息可空', async () => {
  await ready(h.app);
  const stored = await columns(h.app, 'recon_diffs');
  const required: Record<string, string> = {
    id: 'uuid',
    app_id: 'text',
    type: 'text',
    source: 'text',
    period: 'text',
    ref_type: 'text',
    ref_id: 'text',
    expected_fen: 'int8',
    actual_fen: 'int8',
    diff_fen: 'int8',
    status: 'text',
  };
  for (const [name, type] of Object.entries(required)) {
    expect(stored, name).toContainEqual(expect.objectContaining({ name, type, nullable: false }));
  }
  for (const [name, type] of Object.entries({
    handler_id: 'uuid',
    closed_at: 'timestamptz',
    dedupe_key: 'text',
  })) {
    expect(stored, name).toContainEqual(expect.objectContaining({ name, type, nullable: true }));
  }
  // S4 未规定 resolution 的值域或编码；这里只锁定可空的独立列。
  expect(stored).toContainEqual(expect.objectContaining({ name: 'resolution', nullable: true }));
  expect(stored.find((c) => c.name === 'closed_at')?.expression).toBeNull();
});

it('[AC-B2-04b#2] 日快照含全部独立金额与可比标记，日期由调用方传入', async () => {
  await ready(h.app);
  const stored = await columns(h.app, 'asset_snapshots');
  for (const [name, type] of Object.entries({
    app_id: 'text',
    snapshot_date: 'date',
    waiting_comparable: 'bool',
    ...Object.fromEntries(TOTALS.map((name) => [name, 'int8'])),
  })) {
    expect(stored, name).toContainEqual(expect.objectContaining({ name, type, nullable: false }));
  }
  expect(stored.find((c) => c.name === 'snapshot_date')?.expression).toBeNull();
  expect(stored.map((c) => c.name)).not.toContain('union_receivable_fen');
  const child = await columns(h.app, 'asset_snapshot_receivables');
  for (const [name, type] of Object.entries({
    asset_snapshot_id: 'uuid',
    app_id: 'text',
    platform: 'text',
    union_receivable_fen: 'int8',
  })) {
    expect(child, name).toContainEqual(expect.objectContaining({ name, type, nullable: false }));
  }
});

it('[AC-B2-04b#3] 原业务键唯一，dedupe_key 是 app 内非空部分唯一，日快照按 app 与日期唯一', async () => {
  await ready(h.app);
  const reconIndexes = await indexes(h.app, 'recon_diffs');
  expect(reconIndexes).toContainEqual(
    expect.objectContaining({
      keys: ['app_id', 'type', 'period', 'ref_id'],
      unique: true,
      valid: true,
      predicate: null,
    }),
  );
  const dedupe = reconIndexes.filter((i) => i.unique && i.keys.join(',') === 'app_id,dedupe_key');
  expect(dedupe).toHaveLength(1);
  expect(dedupe[0]?.valid).toBe(true);
  expect(dedupe[0]?.predicate?.replace(/[()"\s]/g, '').toLowerCase()).toBe('dedupe_keyisnotnull');
  expect(await indexes(h.app, 'asset_snapshots')).toContainEqual(
    expect.objectContaining({
      keys: ['app_id', 'snapshot_date'],
      unique: true,
      valid: true,
      predicate: null,
    }),
  );
  expect(await indexes(h.app, 'asset_snapshot_receivables')).toContainEqual(
    expect.objectContaining({
      keys: ['asset_snapshot_id', 'platform'],
      unique: true,
      valid: true,
      predicate: null,
    }),
  );
});

it('[AC-B2-04b#4] 同一迁移创建并授权三表，资金表约束与独立索引全部显式具名', async () => {
  await ready(h.app);
  const source = migrationSource().replace(/"/g, '');
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // B2-02zc (D10-2224 B ①): indexes of these tables added by later migrations (merged migrations
  // never change) are looked up in those migrations too; tables, grants and constraints stay 0060's.
  const { readdirSync, readFileSync } = await import('node:fs');
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const later = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) > 60)
    .sort()
    .map((name) =>
      readFileSync(new URL(name, directory), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/--[^\n]*/g, '')
        .replace(/"/g, ''),
    )
    .filter((text) =>
      TABLES.some((table) =>
        new RegExp(
          `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\b[^;]*\\bON\\s+(?:ONLY\\s+)?app\\.${table}\\b`,
          'i',
        ).test(text),
      ),
    );
  const indexSource = [source, ...later].join('\n');
  for (const table of TABLES) {
    expect(source).toMatch(
      new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?app\\.${table}\\s*\\(`, 'i'),
    );
    expect(source).toMatch(
      new RegExp(
        `GRANT\\s+[^;]+\\bON\\s+(?:TABLE\\s+)?[^;]*\\bapp\\.${table}\\b[^;]*\\bTO\\s+couli_app\\b`,
        'i',
      ),
    );
    const constraints = await sql<{ name: string }>`SELECT conname AS name FROM pg_constraint
      WHERE conrelid = to_regclass(${`app.${table}`}) AND contype IN ('p', 'u', 'c', 'f')`.execute(
      h.app,
    );
    expect(constraints.rows.length).toBeGreaterThan(0);
    for (const { name } of constraints.rows) {
      expect(source, name).toMatch(new RegExp(`\\bCONSTRAINT\\s+${escape(name)}\\s`, 'i'));
    }
    for (const index of await indexes(h.app, table)) {
      if (!index.constraint_backed) {
        expect(indexSource, index.name).toMatch(
          new RegExp(
            `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${escape(index.name)}\\s`,
            'i',
          ),
        );
      }
    }
  }
});

it('[AC-B2-04b#5] 处理人外键绑定本 app 的管理员，所有新增外键均不级联', async () => {
  await ready(h.app);
  const foreign = await sql<{
    keys: string[];
    target: string;
    target_keys: string[];
    del: string;
    upd: string;
    valid: boolean;
  }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos) AS keys,
      c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos) AS target_keys,
      c.confdeltype::text AS del, c.confupdtype::text AS upd, c.convalidated AS valid
    FROM pg_constraint c WHERE c.contype = 'f'
      AND c.conrelid IN ('app.recon_diffs'::regclass, 'app.asset_snapshots'::regclass,
        'app.asset_snapshot_receivables'::regclass)
  `.execute(h.app);
  expect(foreign.rows).toContainEqual(
    expect.objectContaining({
      keys: ['app_id', 'handler_id'],
      target: 'app.admin_users',
      target_keys: ['app_id', 'id'],
      valid: true,
    }),
  );
  expect(foreign.rows).toContainEqual(
    expect.objectContaining({
      keys: expect.arrayContaining(['asset_snapshot_id']),
      target: 'app.asset_snapshots',
      target_keys: expect.arrayContaining(['id']),
      valid: true,
    }),
  );
  for (const fk of foreign.rows) {
    expect(['a', 'r']).toContain(fk.del);
    expect(['a', 'r']).toContain(fk.upd);
  }
});
