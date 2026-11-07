// B1-04zzx (D10-860 ①⑤): Catalog.filterCategories over app.category_blocklist for items without a
// level-one category (categoryId null or ''). Database via createTestDatabase (@couli/db/testing);
// SQL only seeds rows, the operation goes through the public catalog/index.ts. Synthetic values.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createCatalog,
  type CategoryCandidate,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

it('[AC-B1-04zzx#12] 无类目商品（null 或空串）：同平台启用且带关键词的行按标题字面包含命中即滤；纯类目行、禁用行、他平台与他应用的行不适用；有类目照旧；顺序与对象不变', async () => {
  const catalog = createCatalog({
    db,
    clock: new FixedClock('2031-05-06T07:08:09.000Z'),
    warn: () => undefined,
  });
  await sql`INSERT INTO app.category_blocklist (id, app_id, platform, category_id, keyword, reason, status, updated_by)
    VALUES ('0199b0c4-0000-7000-8000-000000000001', 'blk-a', 'taobao', '50', NULL, '合成', 'active', 'test'),
           ('0199b0c4-0000-7000-8000-000000000002', 'blk-a', 'taobao', '70', '禁售词', '合成', 'active', 'test'),
           ('0199b0c4-0000-7000-8000-000000000003', 'blk-a', 'taobao', '71', '停用词', '合成', 'disabled', 'test'),
           ('0199b0c4-0000-7000-8000-000000000004', 'blk-a', 'jd', '72', '跨平台词', '合成', 'active', 'test'),
           ('0199b0c4-0000-7000-8000-000000000005', 'blk-b', 'taobao', '73', '他应用词', '合成', 'active', 'test'),
           ('0199b0c4-0000-7000-8000-000000000006', 'blk-a', 'taobao', '74', 'A+B', '合成', 'active', 'test')`.execute(
    db,
  );
  const items: readonly (CategoryCandidate & { readonly id: string })[] = [
    { platform: 'taobao', categoryId: null, title: '合成 t1 禁售词', id: 't1' },
    { platform: 'taobao', categoryId: '', title: '合成 t2 禁售词', id: 't2' },
    { platform: 'taobao', categoryId: null, title: '合成 t3', id: 't3' },
    { platform: 'taobao', categoryId: null, title: '合成 t4 停用词', id: 't4' },
    { platform: 'taobao', categoryId: '', title: '合成 t5 跨平台词', id: 't5' },
    { platform: 'taobao', categoryId: null, title: '合成 t6 他应用词', id: 't6' },
    { platform: 'taobao', categoryId: '50', title: '合成 t7', id: 't7' },
    { platform: 'taobao', categoryId: '70', title: '合成 t8 禁售词', id: 't8' },
    { platform: 'taobao', categoryId: '70', title: '合成 t9', id: 't9' },
    { platform: 'taobao', categoryId: null, title: '合成 t10 AAB', id: 't10' },
    { platform: 'taobao', categoryId: '', title: '合成 t11 A+B', id: 't11' },
  ];
  const before = structuredClone(items);
  const kept = await catalog.filterCategories('blk-a', items);
  expect(kept.map((item) => item.id)).toEqual(['t3', 't4', 't5', 't6', 't9', 't10']);
  for (const item of kept) expect(items).toContain(item);
  expect(items).toEqual(before);
  const other = await catalog.filterCategories('blk-b', items);
  expect(other.map((item) => item.id)).toEqual(
    items.filter((item) => item.id !== 't6').map((item) => item.id),
  );
});
