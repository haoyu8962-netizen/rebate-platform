// B2-04zh rule tests (规划/08 BR-FUND-20 细则「联盟回款凭证」、BR-FUND-16; 04 §3.2 union_receipts;
// 编排裁定 D10-538, D10-589): columns, keys, value domains, foreign keys, the reversal group and the
// list index of app.union_receipts.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  CLOCK,
  LATER,
  RECEIPT_DATE,
  REVERSAL,
  SHAPE,
  TIMEOUT,
  close,
  columns,
  indexes,
  insert,
  migration,
  open,
  ready,
  receipt,
  reversal,
  seedVoucher,
  sqlState,
  stored,
  tenant,
  update,
  type Harness,
  type Row,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const NOT_NULL = Object.keys(SHAPE).filter((name) => !SHAPE[name]![1]);
// Every way of setting one or two of the three reversal columns.
const PARTIAL = [
  ['reversed_at'],
  ['reversed_by'],
  ['reversal_voucher_id'],
  ['reversed_at', 'reversed_by'],
  ['reversed_at', 'reversal_voucher_id'],
  ['reversed_by', 'reversal_voucher_id'],
];

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function pick(row: Row, names: readonly string[]): Row {
  return Object.fromEntries(names.map((name) => [name, row[name]]));
}
function nulls(names: readonly string[]): Row {
  return Object.fromEntries(names.map((name) => [name, null]));
}

it('[AC-B2-04zh#1] app.union_receipts 恰好 14 列，类型与可空如 04 §3.2：金额 bigint、receipt_date 是 date、note / created_by / 红冲三列可空，其余非空', async () => {
  await ready(h.app);
  const all = await columns(h.app);
  expect(all.map((c) => c.name).sort()).toEqual(Object.keys(SHAPE).sort());
  for (const { name, type, nullable } of all) {
    expect([type, nullable], name).toEqual(SHAPE[name]);
  }
});

it('[AC-B2-04zh#2] 无数据库默认值：receipt_id 等列都由应用给；只有 created_at 可以有默认，且只能是 SQL 时钟', async () => {
  await ready(h.app);
  const all = await columns(h.app);
  for (const column of all.filter((c) => c.name !== 'created_at')) {
    expect(column.default_expr, `${column.name} 无默认`).toBeNull();
  }
  const created = all.find((c) => c.name === 'created_at');
  expect(created?.default_expr ?? 'now()').toMatch(CLOCK);
});

it('[AC-B2-04zh#3] 主键恰为 receipt_id：同一 receipt_id 不能有第二行（跨 app 也不行）', async () => {
  await ready(h.app);
  const primary = await sql<{ keys: string[] }>`
    SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos
    ) AS keys
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.union_receipts') AND c.contype = 'p'
  `.execute(h.app);
  expect(primary.rows).toEqual([{ keys: ['receipt_id'] }]);

  const first = await receipt(h.app, await tenant(h.app));
  expect(await sqlState(insert(h.app, first))).toBe('ok');
  const again = await receipt(h.app, await tenant(h.app), { receipt_id: first['receipt_id'] });
  expect(again['app_id']).not.toBe(first['app_id']);
  expect(await sqlState(insert(h.app, again))).toBe('23505');
  expect(await stored(h.app, first['receipt_id'])).toEqual([
    expect.objectContaining({ app_id: first['app_id'] }),
  ]);
});

it('[AC-B2-04zh#4] 约束与索引在迁移里显式具名，且都已生效（资金表规则，db/AGENTS.md 第 11 条）', async () => {
  await ready(h.app);
  const { source } = migration();
  const constraints = await sql<{ name: string; validated: boolean }>`
    SELECT conname::text AS name, convalidated AS validated FROM pg_constraint
    WHERE conrelid = to_regclass('app.union_receipts') AND contype IN ('p', 'u', 'c', 'f', 'x')
  `.execute(h.app);
  expect(constraints.rows.length).toBeGreaterThan(0);
  for (const { name, validated } of constraints.rows) {
    expect(source, `约束 ${name} 显式具名`).toMatch(
      new RegExp(`\\bCONSTRAINT\\s+${escape(name)}\\s`, 'i'),
    );
    expect(validated, `约束 ${name} 已生效`).toBe(true);
  }
  const standalone = await sql<{ name: string }>`
    SELECT c.relname::text AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('app.union_receipts')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
  `.execute(h.app);
  for (const { name } of standalone.rows) {
    const created = `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?`;
    expect(source, `索引 ${name} 显式具名`).toMatch(
      new RegExp(`${created}${escape(name)}\\s`, 'i'),
    );
  }
});

it('[AC-B2-04zh#5] 不设业务键：同平台同日同金额同方式的两笔回款都能插入；唯一索引只落在 receipt_id、voucher_id、reversal_voucher_id 上', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  for (const [method, created_by] of [
    ['ADMIN_ENTRY', t.admin],
    ['R1_RECON', null],
  ] as const) {
    const same = {
      platform: 'jd',
      receipt_date: RECEIPT_DATE,
      amount_fen: 617n,
      method,
      cash_account: 'CASH_ALIPAY',
      note: '同一天同金额的另一笔',
      created_by,
      created_at: new Date(AT),
    };
    const first = await receipt(h.app, t, same);
    const second = await receipt(h.app, t, same);
    expect(await sqlState(insert(h.app, first)), method).toBe('ok');
    expect(await sqlState(insert(h.app, second)), method).toBe('ok');
    expect(await stored(h.app, first['receipt_id'])).toHaveLength(1);
    expect(await stored(h.app, second['receipt_id'])).toHaveLength(1);
  }
  const unique = (await indexes(h.app)).filter((index) => index.is_unique);
  expect(unique.length).toBeGreaterThan(0);
  for (const index of unique) {
    expect(
      index.keys.filter((key) => ['receipt_id', 'voucher_id', 'reversal_voucher_id'].includes(key)),
      `${index.name}: ${index.keys.join(', ')}`,
    ).toHaveLength(1);
  }
});

it('[AC-B2-04zh#6] 值域：app_id 不能是空串；platform、method、cash_account 收全部合法值，大小写不符、空串、带空格和未知值以 23514 拒绝', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  for (const [column, value] of [
    ['platform', 'taobao'],
    ['platform', 'jd'],
    ['platform', 'pdd'],
    ['method', 'ADMIN_ENTRY'],
    ['method', 'R1_RECON'],
    ['cash_account', 'CASH_ALIPAY'],
    ['cash_account', 'CASH_BANK'],
  ] as const) {
    const ok = await receipt(h.app, t, { [column]: value });
    expect(await sqlState(insert(h.app, ok)), `${column}=${value}`).toBe('ok');
    expect(await stored(h.app, ok['receipt_id'])).toEqual([
      expect.objectContaining({ [column]: value }),
    ]);
  }
  for (const [column, value] of [
    ['app_id', ''],
    ['platform', ''],
    ['platform', 'TAOBAO'],
    ['platform', ' taobao'],
    ['platform', 'tmall'],
    ['platform', 'unknown'],
    ['method', ''],
    ['method', 'admin_entry'],
    ['method', 'R1'],
    ['method', 'REVERSAL'],
    ['cash_account', ''],
    ['cash_account', 'cash_alipay'],
    ['cash_account', 'CASH_WECHAT'],
    ['cash_account', 'UNION_RECEIVABLE:taobao'],
  ] as const) {
    const bad = await receipt(h.app, t, { [column]: value });
    expect(await sqlState(insert(h.app, bad)), `${column}=${JSON.stringify(value)}`).toBe('23514');
    expect(await stored(h.app, bad['receipt_id'])).toEqual([]);
  }
});

// 取值以契约 PlatformCode 为准（任务书第 10 节更正第 9 节），与 asset_snapshot_receivables、
// settle_batches、recon_union 的 CHECK 相同。
it('[AC-B2-04zh#7] platform 是契约 PlatformCode 的九个值：九个都能插入，枚举外的值以 23514 拒绝', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  for (const platform of [
    'taobao',
    'jd',
    'pdd',
    'meituan',
    'vip',
    'douyin',
    'eleme',
    'kuaishou',
    'suning',
  ]) {
    const ok = await receipt(h.app, t, { platform });
    expect(await sqlState(insert(h.app, ok)), platform).toBe('ok');
    expect(await stored(h.app, ok['receipt_id'])).toEqual([expect.objectContaining({ platform })]);
  }
  for (const platform of [' taobao', 'unknown']) {
    const bad = await receipt(h.app, t, { platform });
    expect(await sqlState(insert(h.app, bad)), platform).toBe('23514');
    expect(await stored(h.app, bad['receipt_id'])).toEqual([]);
  }
});

it('[AC-B2-04zh#8] amount_fen 必须 > 0：1 分与 bigint 上限可以，0 与负数以 23514 拒绝', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  for (const amount_fen of [1n, 9_223_372_036_854_775_807n]) {
    const ok = await receipt(h.app, t, { amount_fen });
    expect(await sqlState(insert(h.app, ok)), String(amount_fen)).toBe('ok');
    expect(await stored(h.app, ok['receipt_id'])).toEqual([
      expect.objectContaining({ amount_fen }),
    ]);
  }
  for (const amount_fen of [0n, -1n, -1_150_000n, -9_223_372_036_854_775_808n]) {
    const bad = await receipt(h.app, t, { amount_fen });
    expect(await sqlState(insert(h.app, bad)), String(amount_fen)).toBe('23514');
    expect(await stored(h.app, bad['receipt_id'])).toEqual([]);
  }
});

it('[AC-B2-04zh#9] note 可空，长度按字符数 ≤ 500：500 个多字节字符可以，501 个字符以 23514 拒绝', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  for (const note of [null, 'a'.repeat(500), '款'.repeat(500), '💰'.repeat(500)]) {
    const ok = await receipt(h.app, t, { note });
    expect(await sqlState(insert(h.app, ok)), String(note?.length)).toBe('ok');
    expect(await stored(h.app, ok['receipt_id'])).toEqual([expect.objectContaining({ note })]);
  }
  for (const note of ['a'.repeat(501), '款'.repeat(501), '💰'.repeat(501)]) {
    const bad = await receipt(h.app, t, { note });
    expect(await sqlState(insert(h.app, bad)), note.slice(0, 2)).toBe('23514');
    expect(await stored(h.app, bad['receipt_id'])).toEqual([]);
  }
});

it('[AC-B2-04zh#10] created_by：ADMIN_ENTRY 必填（为空 23514）；R1_RECON 可为空，也可带操作人', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  const missing = await receipt(h.app, t, { method: 'ADMIN_ENTRY', created_by: null });
  expect(await sqlState(insert(h.app, missing))).toBe('23514');
  expect(await stored(h.app, missing['receipt_id'])).toEqual([]);
  for (const created_by of [null, t.admin]) {
    const ok = await receipt(h.app, t, { method: 'R1_RECON', created_by });
    expect(await sqlState(insert(h.app, ok)), String(created_by)).toBe('ok');
    expect(await stored(h.app, ok['receipt_id'])).toEqual([
      expect.objectContaining({ method: 'R1_RECON', created_by }),
    ]);
  }
});

it('[AC-B2-04zh#11] 非空列显式写 NULL 以 23502 拒绝', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  expect(NOT_NULL).toHaveLength(9);
  for (const column of NOT_NULL) {
    const bad = await receipt(h.app, t, { [column]: null });
    expect(await sqlState(insert(h.app, bad)), column).toBe('23502');
  }
});

it('[AC-B2-04zh#12] voucher_id 唯一，reversal_voucher_id 唯一（23505）；未红冲的多行可以同时为空', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  const first = await receipt(h.app, t);
  expect(await sqlState(insert(h.app, first))).toBe('ok');
  const sameVoucher = await receipt(h.app, t, {
    voucher_id: first['voucher_id'],
    platform: 'pdd',
    amount_fen: 1n,
  });
  expect(await sqlState(insert(h.app, sameVoucher))).toBe('23505');
  expect(await stored(h.app, sameVoucher['receipt_id'])).toEqual([]);

  const reversed = await reversal(h.app, t);
  const second = await receipt(h.app, t, reversed);
  expect(await sqlState(insert(h.app, second))).toBe('ok');
  // 同一张红冲凭证不能再用于别的回款：插入与红冲更新两条路都拒绝。
  const sameReversal = await receipt(h.app, t, reversed);
  expect(await sqlState(insert(h.app, sameReversal))).toBe('23505');
  expect(await stored(h.app, sameReversal['receipt_id'])).toEqual([]);
  expect(await sqlState(update(h.app, first['receipt_id'], reversed))).toBe('23505');
  expect(await stored(h.app, first['receipt_id'])).toEqual([
    expect.objectContaining(nulls(REVERSAL)),
  ]);

  const third = await receipt(h.app, t);
  expect(await sqlState(insert(h.app, third))).toBe('ok');
  expect(await stored(h.app, third['receipt_id'])).toEqual([
    expect.objectContaining({ reversal_voucher_id: null }),
  ]);
});

it('[AC-B2-04zh#13] 四个外键都带 app_id，指向 ledger_vouchers (app_id, id) 或 admin_users (app_id, id)，不级联', async () => {
  await ready(h.app);
  const foreign = await sql<{
    target: string;
    columns: string[];
    targets: string[];
    del: string;
    upd: string;
  }>`
    SELECT n.nspname || '.' || f.relname AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos) AS targets,
      c.confdeltype::text AS del, c.confupdtype::text AS upd
    FROM pg_constraint c
    JOIN pg_class f ON f.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = f.relnamespace
    WHERE c.conrelid = to_regclass('app.union_receipts') AND c.contype = 'f'
  `.execute(h.app);
  const described = foreign.rows.map((fk) => {
    const pairs = fk.columns.map((column, i) => `${column}->${fk.targets[i]}`);
    return `${fk.target}: ${pairs.sort().join(', ')}`;
  });
  expect(described.sort()).toEqual(
    [
      'app.admin_users: app_id->app_id, created_by->id',
      'app.admin_users: app_id->app_id, reversed_by->id',
      'app.ledger_vouchers: app_id->app_id, reversal_voucher_id->id',
      'app.ledger_vouchers: app_id->app_id, voucher_id->id',
    ].sort(),
  );
  for (const fk of foreign.rows) {
    expect(['a', 'r'], '外键不级联').toContain(fk.del);
    expect(['a', 'r'], '外键不级联').toContain(fk.upd);
  }
});

it('[AC-B2-04zh#14] 指向别的 app 的凭证或管理员、指向不存在的 id，都以 23503 拒绝（插入与红冲更新两条路）', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  const other = await tenant(h.app);
  const otherVoucher = await seedVoucher(h.app, other.app_id);
  const full = await reversal(h.app, t);
  const cases: readonly (readonly [string, Row])[] = [
    ['voucher_id/别的 app', { voucher_id: otherVoucher }],
    ['voucher_id/不存在', { voucher_id: randomUUID() }],
    ['created_by/别的 app', { created_by: other.admin }],
    ['created_by/不存在', { created_by: randomUUID() }],
    ['reversed_by/别的 app', { ...full, reversed_by: other.admin }],
    ['reversed_by/不存在', { ...full, reversed_by: randomUUID() }],
    ['reversal_voucher_id/别的 app', { ...full, reversal_voucher_id: otherVoucher }],
    ['reversal_voucher_id/不存在', { ...full, reversal_voucher_id: randomUUID() }],
  ];
  for (const [label, values] of cases) {
    const bad = await receipt(h.app, t, values);
    expect(await sqlState(insert(h.app, bad)), label).toBe('23503');
    expect(await stored(h.app, bad['receipt_id']), label).toEqual([]);
  }

  const row = await receipt(h.app, t);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const before = await stored(h.app, row['receipt_id']);
  for (const [label, values] of [
    ['reversed_by/别的 app', { ...full, reversed_by: other.admin }],
    ['reversal_voucher_id/别的 app', { ...full, reversal_voucher_id: otherVoucher }],
  ] as const) {
    expect(await sqlState(update(h.app, row['receipt_id'], values)), label).toBe('23503');
  }
  expect(await stored(h.app, row['receipt_id'])).toEqual(before);
});

it('[AC-B2-04zh#15] 红冲三列全空或全有：只设一两列以 23514 拒绝（插入与更新两条路），三列都设可以', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  const full = await reversal(h.app, t);
  const unreversed = await receipt(h.app, t);
  expect(await sqlState(insert(h.app, unreversed))).toBe('ok');
  const before = await stored(h.app, unreversed['receipt_id']);
  for (const names of PARTIAL) {
    const label = names.join('+');
    const bad = await receipt(h.app, t, pick(full, names));
    expect(await sqlState(insert(h.app, bad)), `insert ${label}`).toBe('23514');
    expect(await stored(h.app, bad['receipt_id'])).toEqual([]);
    expect(
      await sqlState(update(h.app, unreversed['receipt_id'], pick(full, names))),
      `update ${label}`,
    ).toBe('23514');
  }
  expect(await stored(h.app, unreversed['receipt_id'])).toEqual(before);

  const inserted = await receipt(h.app, t, await reversal(h.app, t));
  expect(await sqlState(insert(h.app, inserted)), '三列都设的插入').toBe('ok');

  expect(await sqlState(update(h.app, unreversed['receipt_id'], full)), '三列一起红冲').toBe('ok');
  const after = await stored(h.app, unreversed['receipt_id']);
  expect(after).toEqual([
    expect.objectContaining({
      reversed_at: new Date(LATER),
      reversed_by: t.admin,
      reversal_voucher_id: full['reversal_voucher_id'],
    }),
  ]);
  // 已红冲的行也不能只清掉其中一两列。
  for (const names of PARTIAL) {
    expect(
      await sqlState(update(h.app, unreversed['receipt_id'], nulls(names))),
      `clear ${names.join('+')}`,
    ).toBe('23514');
  }
  expect(await stored(h.app, unreversed['receipt_id'])).toEqual(after);
});

it('[AC-B2-04zh#16] 列表查询有索引：存在一个已生效、非部分索引，键列覆盖 app_id 与 receipt_date（不钉索引名与列序）', async () => {
  await ready(h.app);
  const covering = (await indexes(h.app)).filter(
    (index) =>
      index.is_valid &&
      index.predicate === null &&
      index.keys.includes('app_id') &&
      index.keys.includes('receipt_date'),
  );
  expect(covering.length).toBeGreaterThan(0);
});
