// Unit tests of countReconDiffOpen (B2-02w, D10-1401): no database; a fake Kysely driver answers
// the one SELECT and records it, so the count's query can be compared with the list's total query.
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
import { countReconDiffOpen } from './admin-recon-diffs-open-count.ts';
import { listAdminReconDiffs } from './admin-recon-diffs.ts';

class FakeConnection implements DatabaseConnection {
  constructor(
    private readonly rows: readonly unknown[],
    private readonly queries: CompiledQuery[],
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.queries.push(query);
    return { rows: this.rows } as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  constructor(private readonly connection: FakeConnection) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

function fakeDb(rows: readonly unknown[]): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const connection = new FakeConnection(rows, queries);
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(connection),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const APP = 'couli';

it('[B2-02w] 计数是一条只读 SELECT count：按 app、source ∈ R1–R3、status=open 过滤，结果转成数字', async () => {
  const { db, queries } = fakeDb([{ total: '7' }]);
  await expect(countReconDiffOpen(db, APP)).resolves.toBe(7);
  expect(queries).toHaveLength(1);
  const [query] = queries;
  expect(query?.sql).toMatch(/^select count\(\*\) as "total" from "app"\."recon_diffs"/);
  expect(query?.sql).not.toMatch(/limit|offset|for update|for share|insert|update |delete/i);
  expect(query?.parameters).toEqual([APP, 'R1', 'R2', 'R3', 'open']);
});

it('[B2-02w] 计数的查询与差错单列表 status=open 求 total 的查询逐字相同（同一判定）', async () => {
  const counted = fakeDb([{ total: '0' }]);
  await countReconDiffOpen(counted.db, APP);
  const listed = fakeDb([{ total: '0' }]);
  const page = await listAdminReconDiffs(listed.db, APP, { status: 'open', page_size: 1 });
  expect(page.total).toBe(0);
  // total 0: the list skips the page query, so its only query is the total.
  expect(listed.queries).toHaveLength(1);
  expect(counted.queries).toHaveLength(1);
  expect(counted.queries[0]?.sql).toBe(listed.queries[0]?.sql);
  expect(counted.queries[0]?.parameters).toEqual(listed.queries[0]?.parameters);
});
