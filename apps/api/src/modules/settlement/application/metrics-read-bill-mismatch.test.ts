// Unit tests of readSettleBillMismatch (B2-09zn): no database; a fake Kysely driver answers the one
// SELECT and records it. Pins the shape of the query (latest generated bill per app, its own
// amount_mismatch_count, whole Unix seconds) and the mapping of its rows.
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { readSettleBillMismatch } from './metrics-read-bill-mismatch.ts';

function fakeDb(rows: readonly unknown[]): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return { rows } as QueryResult<R>;
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('streamQuery is not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

it('[AC-B2-09zn#u3] 只读 settle_bills：已出账里按 bill_id 取最大的一张，先取最新再丢 NULL 计数', async () => {
  const { db, queries } = fakeDb([]);
  expect(await readSettleBillMismatch(db)).toEqual({ bills: {} });
  expect(queries).toHaveLength(1);
  const sql = normalized(queries[0]!.sql);
  expect(sql).toMatch(/^SELECT /);
  expect(sql).toContain('FROM app.settle_bills b');
  expect(sql).toContain('DISTINCT ON (b.app_id)');
  expect(sql).toContain('WHERE b.generated_at IS NOT NULL');
  expect(sql).toContain('ORDER BY b.app_id, b.bill_id COLLATE "C" DESC');
  // The NULL count is dropped outside the subquery, after the latest bill was picked.
  expect(sql).toMatch(/\) latest WHERE latest\.amount_mismatch_count IS NOT NULL$/);
  expect(sql).toContain('floor(extract(epoch FROM latest.generated_at))::bigint');
  // The column as it is: no recount, no supplement data.
  expect(sql).not.toMatch(/count\(|sum\(|supplement/i);
  expect(queries[0]!.parameters).toEqual([]);
});

it('[AC-B2-09zn#u4] 行映射成数字，0 保留，NULL 计数没有 key，出账秒照数据库给的整数', async () => {
  const { db } = fakeDb([
    { app_id: 'alpha', amount_mismatch_count: 2, generated_at_seconds: '1767225600' },
    { app_id: 'zero', amount_mismatch_count: 0, generated_at_seconds: 1_764_547_200n },
    { app_id: 'none', amount_mismatch_count: null, generated_at_seconds: '1767225600' },
  ]);
  const result = await readSettleBillMismatch(db);
  expect(result).toEqual({
    bills: {
      alpha: { amountMismatch: 2, generatedAtSeconds: 1_767_225_600 },
      zero: { amountMismatch: 0, generatedAtSeconds: 1_764_547_200 },
    },
  });
  expect(typeof result.bills['zero']?.generatedAtSeconds).toBe('number');
});
