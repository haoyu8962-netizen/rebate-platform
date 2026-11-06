// B2-04zfa rule tests (编排裁定 D10-492; 规划/08 BR-FUND-04 ⑦、BR-TEXT-09): columns, types,
// nullability, defaults, primary key and value domain of app.settle_runs.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CLOCK,
  NAMED,
  START_TYPES,
  TIMEOUT,
  close,
  columns,
  insert,
  migrationSource,
  open,
  ready,
  run,
  sqlState,
  startColumn,
  stored,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const REQUIRED = [
  'settle_run_id',
  'app_id',
  'bill_id',
  'part',
  'row_version',
  'updated_at',
  'published_credited_count',
];

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

it('[AC-B2-04zfa#1] app.settle_runs 存在，列为 settle_run_id、app_id、bill_id、part、last_outcome、row_version、updated_at 加恰好一列本次执行起点（created_at 可有可无）', async () => {
  await ready(h.app);
  const names = (await columns(h.app)).map((c) => c.name);
  for (const name of Object.keys(NAMED)) expect(names, name).toContain(name);
  const start = await startColumn(h.app);
  const expected = [...Object.keys(NAMED), start.name];
  if (names.includes('created_at')) expected.push('created_at');
  expect([...names].sort()).toEqual(expected.sort());
});

it('[AC-B2-04zfa#2] 类型、可空与默认值：settle_run_id uuid 无默认（应用生成、与 settle_batches.settle_run_id 同值）；part int 非空默认 0；last_outcome 可空无默认；row_version int 非空；updated_at timestamptz 非空；起点列为时刻或序号且不用 SQL 时钟', async () => {
  await ready(h.app);
  const all = await columns(h.app);
  const byName = new Map(all.map((c) => [c.name, c]));
  for (const [name, [type, nullable]] of Object.entries(NAMED)) {
    expect(byName.get(name), name).toEqual(expect.objectContaining({ name, type, nullable }));
  }
  for (const name of ['settle_run_id', 'app_id', 'bill_id', 'last_outcome']) {
    expect(byName.get(name)?.default_expr ?? null, `${name} 无默认`).toBeNull();
  }
  expect(byName.get('part')?.default_expr, 'part 默认 0').toBe('0');
  expect(
    byName.get('published_credited_count')?.default_expr,
    'published_credited_count 默认 0',
  ).toBe('0');
  // settle_batches.settle_run_id 是同值来源，类型必须一致。
  const batches = await sql<{ type: string }>`
    SELECT t.typname::text AS type
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = 'app.settle_batches'::regclass AND a.attname = 'settle_run_id'
  `.execute(h.app);
  expect(batches.rows).toEqual([{ type: byName.get('settle_run_id')?.type }]);
  const start = await startColumn(h.app);
  expect(START_TYPES as readonly string[], `起点列 ${start.name} 的类型`).toContain(start.type);
  expect(start.default_expr ?? '', '起点列不用 SQL 时钟默认值').not.toMatch(CLOCK);
  for (const column of all) {
    if (column.name !== 'created_at' && column.name !== 'updated_at') {
      expect(column.default_expr ?? '', `${column.name} 不用 SQL 时钟`).not.toMatch(CLOCK);
    }
  }
  const created = byName.get('created_at');
  if (created) {
    expect(created).toEqual(expect.objectContaining({ type: 'timestamptz', nullable: false }));
    expect(created.default_expr ?? '').toMatch(CLOCK);
  }
});

it('[AC-B2-04zfa#2] 只给必填列插入时 part 为 0、last_outcome 为空；last_outcome 只收 done / partial / NULL；必填列为空被拒绝', async () => {
  await ready(h.app);
  const row = await run(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  expect(await stored(h.app, row['settle_run_id'])).toEqual([
    expect.objectContaining({ part: 0, last_outcome: null, published_credited_count: 0 }),
  ]);
  // 未发布过的 run 是 (0, NULL)；发布过的 part ≥ 1 带结果。两者之间的配对不在这里规定。
  for (const [part, outcome] of [
    [1, 'done'],
    [2, 'partial'],
    [0, null],
  ] as const) {
    const ok = await run(h.app, { part, last_outcome: outcome });
    expect(await sqlState(insert(h.app, ok)), String(outcome)).toBe('ok');
    expect(await stored(h.app, ok['settle_run_id'])).toEqual([
      expect.objectContaining({ part, last_outcome: outcome }),
    ]);
  }
  for (const outcome of ['DONE', 'PARTIAL', 'Done', '', 'failed', 'cancelled', ' done']) {
    const bad = await run(h.app, { part: 1, last_outcome: outcome });
    expect(await sqlState(insert(h.app, bad)), JSON.stringify(outcome)).toBe('23514');
    expect(await stored(h.app, bad['settle_run_id'])).toEqual([]);
  }
  for (const column of REQUIRED) {
    const bad = await run(h.app, { [column]: null });
    expect(await sqlState(insert(h.app, bad)), column).toBe('23502');
  }
});

it('[AC-B2-04zfa#3] 主键恰为 settle_run_id：同一 settle_run_id 不能有第二行（跨 app 也不行），约束在迁移里显式具名，外键（如有）不级联', async () => {
  await ready(h.app);
  const primary = await sql<{ keys: string[] }>`
    SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos
    ) AS keys
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.settle_runs') AND c.contype = 'p'
  `.execute(h.app);
  expect(primary.rows).toEqual([{ keys: ['settle_run_id'] }]);

  // run() 每次给新的 app_id：同一 settle_run_id 换 app 也冲突。
  const first = await run(h.app);
  expect(await sqlState(insert(h.app, first))).toBe('ok');
  const again = await run(h.app, { settle_run_id: first['settle_run_id'] });
  expect(again['app_id']).not.toBe(first['app_id']);
  expect(await sqlState(insert(h.app, again))).toBe('23505');
  expect(await stored(h.app, first['settle_run_id'])).toEqual([
    expect.objectContaining({ app_id: first['app_id'] }),
  ]);

  const source = migrationSource();
  const constraints = await sql<{ name: string }>`
    SELECT conname::text AS name FROM pg_constraint
    WHERE conrelid = to_regclass('app.settle_runs') AND contype IN ('p', 'u', 'c', 'f', 'x')
  `.execute(h.app);
  expect(constraints.rows.length).toBeGreaterThan(0);
  for (const { name } of constraints.rows) {
    expect(source, `约束 ${name} 显式具名`).toMatch(
      new RegExp(`\\bCONSTRAINT\\s+${escape(name)}\\s`, 'i'),
    );
  }
  const indexes = await sql<{ name: string }>`
    SELECT c.relname::text AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('app.settle_runs')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
  `.execute(h.app);
  for (const { name } of indexes.rows) {
    const created = `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?`;
    expect(source, `索引 ${name} 显式具名`).toMatch(
      new RegExp(`${created}${escape(name)}\\s`, 'i'),
    );
  }
  const foreign = await sql<{ del: string; upd: string }>`
    SELECT confdeltype::text AS del, confupdtype::text AS upd FROM pg_constraint
    WHERE conrelid = to_regclass('app.settle_runs') AND contype = 'f'
  `.execute(h.app);
  for (const fk of foreign.rows) {
    expect(['a', 'r'], '外键不级联').toContain(fk.del);
    expect(['a', 'r'], '外键不级联').toContain(fk.upd);
  }
});
