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
  expect(statement.parameters).toEqual([
    'unit-app',
    'taobao',
    ['S1', 'P1', 'X9'],
    ['S1', 'P1', 'X9'],
    'unit-app',
    'taobao',
  ]);
});

it('[AC-B1-09x-UNIT#1] readOwnTaobaoOrderNos：子单号由 order_keys 驱动、lateral 按主键逐行取 orders（orders 上不加别的过滤），父单号 unnest 逐值、lateral 里单值等值（不用多值 IN / ANY）且以字面量 offset 0 防上拉，两路 UNION ALL 一条语句，语句里没有 or；两路命中同一单只答一次', async () => {
  const { db, statements } = fakeDb([
    { sub_order_id: 'S6', parent_order_id: 'S6' },
    { sub_order_id: 'S6', parent_order_id: 'S6' },
  ]);
  expect([...(await readOwnTaobaoOrderNos(db, 'unit-app', ['S6']))]).toEqual(['S6']);
  expect(statements).toHaveLength(1);
  const { sql, parameters } = statements[0]!;
  expect(sql).not.toMatch(/\bor\b/i);
  expect(sql).toBe(
    'select "o"."sub_order_id", "o"."parent_order_id" from "app"."order_keys" as "k"' +
      ' cross join lateral (select "o"."sub_order_id", "o"."parent_order_id" from "app"."orders" as "o"' +
      ' where "o"."order_id" = "k"."order_id" and "o"."attr_at" = "k"."attr_at") as "o"' +
      ' where "k"."app_id" = $1 and "k"."platform" = $2 and "k"."sub_order_id" = any($3)' +
      ' union all select "o"."sub_order_id", "o"."parent_order_id" from unnest($4::text[]) as q(asked_no)' +
      ' cross join lateral (select "o"."sub_order_id", "o"."parent_order_id" from "app"."orders" as "o"' +
      ' where "o"."app_id" = $5 and "o"."platform" = $6 and "o"."parent_order_id" is not null' +
      ' and "o"."parent_order_id" = "q"."asked_no" offset 0) as "o"',
  );
  expect(parameters).toEqual(['unit-app', 'taobao', ['S6'], ['S6'], 'unit-app', 'taobao']);
});
