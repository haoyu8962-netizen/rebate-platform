// B1-04zzx (D10-860 ③⑤): the search tab over the real Catalog.filterCategories and
// app.category_blocklist. A row takes effect on the next request and stops when disabled (no list
// cache this step, D10-860 ④); another app's rows never apply. Database via createTestDatabase
// (@couli/db/testing); SQL only seeds and updates rows. Synthetic values.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createCatalog,
  searchProducts,
  type SearchProductsOptions,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { QUERY, fixture } from '../search/kit.ts';
import { APP, goods, titles } from './kit.ts';

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

it('[AC-B1-04zzx#13] 搜索接真实名单：启用行下次请求即滤（含无类目按关键词），改为禁用后下次请求即放行，他应用的行不生效', async () => {
  const f = fixture();
  const catalog = createCatalog({ db, clock: f.clock, warn: () => undefined });
  const options: SearchProductsOptions = { ...f.options, categoryFilter: catalog };
  const run = () => searchProducts({ ...QUERY, limit: 10 }, options);
  f.pages.set(1, {
    items: [
      goods('a', '50'),
      goods('b', '60'),
      goods('c', undefined, { title: 'synthetic-c-禁售词' }),
      goods('d', ''),
    ],
    hasMore: false,
  });
  const all = ['synthetic-a', 'synthetic-b', 'synthetic-c-禁售词', 'synthetic-d'];
  expect(titles((await run()).items)).toEqual(all);

  await sql`INSERT INTO app.category_blocklist (id, app_id, platform, category_id, keyword, reason, status, updated_by)
    VALUES ('0199b0c4-0000-7000-8000-000000000101', ${APP}, 'taobao', '50', NULL, '合成', 'active', 'test'),
           ('0199b0c4-0000-7000-8000-000000000102', ${APP}, 'taobao', '70', '禁售词', '合成', 'active', 'test'),
           ('0199b0c4-0000-7000-8000-000000000103', 'synthetic-other-app', 'taobao', '60', NULL, '合成', 'active', 'test')`.execute(
    db,
  );
  expect(titles((await run()).items)).toEqual(['synthetic-b', 'synthetic-d']);

  await sql`UPDATE app.category_blocklist SET status = 'disabled'
    WHERE id = '0199b0c4-0000-7000-8000-000000000101'`.execute(db);
  expect(titles((await run()).items)).toEqual(['synthetic-a', 'synthetic-b', 'synthetic-d']);
});
