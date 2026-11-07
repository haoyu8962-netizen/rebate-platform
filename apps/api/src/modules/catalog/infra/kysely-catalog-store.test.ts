import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';
import type { ProductRef } from '../domain/types.ts';
import { createKyselyCatalogStore } from './kysely-catalog-store.ts';

/** A Kysely whose driver records each compiled statement and answers no rows. */
function recordingDb(): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });
  return { db, queries };
}

const REF: ProductRef = {
  appId: 'unit-app',
  platform: 'taobao',
  productKey: 'tb:unit1',
  rawItemId: 'unit-raw-1',
  rawFetchedAt: '2026-11-01T00:00:00.000Z',
  receivedAt: '2026-11-01T00:00:01.000Z',
  canonicalUrl: null,
  title: '合成单测商品',
  shopId: null,
  shopType: null,
  source: 'search',
};

it('[AC-B1-05zm-UNIT#3] product_refs upsert：冲突时 shop_id 用 COALESCE(excluded, 已存)，其余列照旧取 excluded', async () => {
  const { db, queries } = recordingDb();
  await createKyselyCatalogStore(db).upsertProductRef(REF, new Date('2026-11-01T00:00:02.000Z'));
  expect(queries).toHaveLength(1);
  const text = queries[0]!.sql;
  expect(text).toContain('"shop_id" = COALESCE(excluded.shop_id, product_refs.shop_id)');
  expect(text).toContain('"shop_type" = "excluded"."shop_type"');
  expect(text).toContain('"title" = "excluded"."title"');
});
