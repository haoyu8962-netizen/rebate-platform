import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { readOwnTaobaoOrderNos } from './own-taobao-orders.ts';

function fakeDb(rows: readonly Record<string, unknown>[]) {
  const statements: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => undefined,
        acquireConnection: async () => ({
          async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
            statements.push(query);
            return { rows: rows as R[] };
          },
          async *streamQuery() {
            throw new Error('not streamed');
          },
        }),
        releaseConnection: async () => undefined,
        destroy: async () => undefined,
        beginTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
      }),
    },
  });
  return { db, statements };
}

it('[AC-B1-04zzu-UNIT#4] readOwnTaobaoOrderNos：空入参不发语句；非空入参一条只读语句（app、taobao、去重后的单号），答案只含所问单号（子单号或父单号命中）', async () => {
  const empty = fakeDb([]);
  expect([...(await readOwnTaobaoOrderNos(empty.db, 'unit-app', []))]).toEqual([]);
  expect(empty.statements).toHaveLength(0);

  const { db, statements } = fakeDb([
    { sub_order_id: 'S1', parent_order_id: 'P1' },
    { sub_order_id: 'S2', parent_order_id: 'P1' },
    { sub_order_id: 'S3', parent_order_id: null },
  ]);
  const found = await readOwnTaobaoOrderNos(db, 'unit-app', ['S1', 'P1', 'S1', 'X9']);
  expect([...found].sort()).toEqual(['P1', 'S1']);
  expect(statements).toHaveLength(1);
  const statement = statements[0]!;
  expect(statement.sql).toMatch(/^select\b/i);
  expect(statement.sql).toContain('"app"."orders"');
  expect(statement.sql).not.toMatch(/\bfor\s+update\b/i);
  expect(statement.parameters).toEqual(['unit-app', 'taobao', 'S1', 'P1', 'X9', 'S1', 'P1', 'X9']);
});
