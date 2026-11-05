// B1-05u rule tests (规划/08 BR-PRICE-11; 任务书第 9 节): app.pool_items gains commission_rate_bp, the
// commission rate the pool's card quote reads, so a union failure can fall back to the pool.
//   - Integer basis points, nullable, no default: rows written before the column have no value until
//     the next refresh, and writers that do not know the column keep working. Nothing is backfilled.
//   - When set it is at least 0. There is no upper bound, and NULL passes.
//   - Only this column is added: the other columns and the primary key stay as B1-05p left them.
// The migration number and the constraint name are the implementer's, so neither appears here: the
// tests read the final table and its behaviour, one migration or two (NOT VALID + VALIDATE). The
// expected columns are spelled out rather than taken from the B1-05p kit, so a later change to that
// kit cannot widen what "unchanged" means here. Rows go through raw SQL as in the kit.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ITEMS,
  TIMEOUT,
  close,
  columns,
  insert,
  item,
  itemKey,
  open,
  seedPool,
  sqlState,
  stored,
  update,
  type Harness,
} from '../product-pool-schema/kit.ts';

const COLUMN = 'commission_rate_bp';
const NEGATIVE = [-1, -350, -2_147_483_648];
const WRITABLE = [0, 1, 350, 10_000, 10_001, 2_147_483_647];
const PRIMARY_KEY = ['app_id', 'pool_id', 'product_key'];
// [Postgres type, nullable, default], as columns() in the kit reads them.
const SHAPE: Record<string, readonly [string, boolean, string | null]> = {
  app_id: ['text', false, null],
  pool_id: ['uuid', false, null],
  product_key: ['text', false, null],
  platform: ['text', false, null],
  raw_item_id: ['text', false, null],
  title: ['text', false, null],
  image: ['text', true, null],
  price_fen: ['int8', false, null],
  coupon_fen: ['int8', false, null],
  final_price_fen: ['int8', false, null],
  quoted_at: ['timestamptz', false, null],
  status: ['text', false, null],
  sort: ['int4', false, '0'],
  start_at: ['timestamptz', true, null],
  end_at: ['timestamptz', true, null],
  invalid_reason: ['text', true, null],
  created_by: ['uuid', false, null],
  created_at: ['timestamptz', false, 'now()'],
  updated_at: ['timestamptz', false, 'now()'],
  [COLUMN]: ['int4', true, null],
  shop_name: ['text', true, null],
};

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

// Every case calls this first: without the migration the case fails on an assertion, not on SQL
// that references a missing column.
async function ready(): Promise<void> {
  expect((await columns(h.app, ITEMS)).map((c) => c.name)).toContain(COLUMN);
}
async function primaryKey() {
  return (
    await sql<{ keys: string[] }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${ITEMS}) AND c.contype = 'p'`.execute(
      h.app,
    )
  ).rows;
}

it('[BR-PRICE-11] pool_items.commission_rate_bp 是 integer，可空，没有默认值', async () => {
  const found = await columns(h.app, ITEMS);
  expect(found.filter((c) => c.name === COLUMN)).toEqual([
    { name: COLUMN, type: 'int4', nullable: true, default_expr: null },
  ]);
});

it('[BR-PRICE-11] commission_rate_bp 为负被拒：插入和更新都违反 CHECK，不留下也不改动行', async () => {
  await ready();
  const { owner, pooled } = await seedPool(h.app);
  for (const value of NEGATIVE) {
    const entry = item(owner, pooled, { [COLUMN]: value });
    expect(await sqlState(insert(h.app, ITEMS, entry)), String(value)).toBe('23514');
    expect(await stored(h.app, ITEMS, itemKey(entry))).toEqual([]);
  }
  const entry = item(owner, pooled, { [COLUMN]: 350 });
  await insert(h.app, ITEMS, entry);
  const before = await stored(h.app, ITEMS, itemKey(entry));
  for (const value of NEGATIVE) {
    expect(
      await sqlState(update(h.app, ITEMS, itemKey(entry), { [COLUMN]: value })),
      String(value),
    ).toBe('23514');
  }
  expect(await stored(h.app, ITEMS, itemKey(entry))).toEqual(before);
});

it('[BR-PRICE-11] commission_rate_bp 取 0 和正值都能写入，原样读回，没有上限', async () => {
  await ready();
  const { owner, pooled } = await seedPool(h.app);
  for (const value of WRITABLE) {
    const entry = item(owner, pooled, { [COLUMN]: value });
    expect(await sqlState(insert(h.app, ITEMS, entry)), String(value)).toBe('ok');
    expect((await stored(h.app, ITEMS, itemKey(entry)))[0]?.[COLUMN], String(value)).toBe(value);
  }
});

it('[BR-PRICE-11] 不写 commission_rate_bp 的插入成功且该列为 NULL，显式写 NULL 同样成功', async () => {
  await ready();
  const { owner, pooled } = await seedPool(h.app);
  for (const entry of [item(owner, pooled), item(owner, pooled, { [COLUMN]: null })]) {
    expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
    const saved = await stored(h.app, ITEMS, itemKey(entry));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[COLUMN]).toBeNull();
  }
});

it('[BR-PRICE-11] 空值行下一次刷新能补上 commission_rate_bp：0 和正值都能从 NULL 更新进去', async () => {
  await ready();
  const { owner, pooled } = await seedPool(h.app);
  for (const value of WRITABLE) {
    const entry = item(owner, pooled);
    await insert(h.app, ITEMS, entry);
    expect(
      await sqlState(update(h.app, ITEMS, itemKey(entry), { [COLUMN]: value })),
      String(value),
    ).toBe('ok');
    expect((await stored(h.app, ITEMS, itemKey(entry)))[0]?.[COLUMN], String(value)).toBe(value);
  }
});

it('[BR-PRICE-11] 只加这一列：已有列的名字、类型、可空性和默认值都不变，没有多出别的列', async () => {
  await ready();
  const found = await columns(h.app, ITEMS);
  expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPE).sort());
  for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPE)) {
    expect(found, name).toContainEqual({ name, type, nullable, default_expr });
  }
});

it('[BR-PRICE-11] 主键仍是 (app_id, pool_id, product_key)：只有佣金率不同的同键插入失败，原行不变', async () => {
  await ready();
  expect(await primaryKey()).toEqual([{ keys: PRIMARY_KEY }]);
  const { owner, pooled } = await seedPool(h.app);
  const entry = item(owner, pooled, { [COLUMN]: 350 });
  expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
  const before = await stored(h.app, ITEMS, itemKey(entry));
  expect(await sqlState(insert(h.app, ITEMS, { ...entry, [COLUMN]: 500 }))).toBe('23505');
  expect(await stored(h.app, ITEMS, itemKey(entry))).toEqual(before);
});
