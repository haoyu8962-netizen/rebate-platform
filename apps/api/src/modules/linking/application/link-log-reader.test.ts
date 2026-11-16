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
import { createLinkLogMomentReader } from './link-log-reader.ts';

const APP = 'couli';

/** A Kysely whose driver records each compiled statement and answers with the given rows. */
function stubDb(
  rows: readonly Record<string, unknown>[] = [],
  evidenceRows: readonly Record<string, unknown>[] = [],
): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      const answer = query.sql.includes('"link_log_evidence"') ? evidenceRows : rows;
      return { rows: answer as R[] };
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
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

it('[AC-B1-10j#20] 按 app_id 与去重 id 读时间与 scene（可空），不读商品等其他列', async () => {
  const at = new Date('2026-10-05T01:00:00.000Z');
  const { db, queries } = stubDb([
    { id: 7n, created_at: at, scene: null },
    { id: 8n, created_at: at, scene: 'detail' },
  ]);
  const moments = await createLinkLogMomentReader(db).moments(APP, [7n, 8n, 7n]);
  expect([...moments]).toEqual([
    ['7', { at, scene: null }],
    ['8', { at, scene: 'detail' }],
  ]);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('"app"."link_logs"');
  expect(queries[0]!.sql).not.toContain('product_key');
  expect(queries[0]!.parameters).toEqual([APP, ['7', '8']]);
  const empty = stubDb();
  expect((await createLinkLogMomentReader(empty.db).moments(APP, [])).size).toBe(0);
  expect(empty.queries).toEqual([]);
});

it('[AC-CT-13m#5] link_logs 查不到的 id 再按 app_id 查 link_log_evidence，同样只读时间与 scene；都查到就不查证据表', async () => {
  const at = new Date('2026-01-05T02:00:00.250Z');
  const live = new Date('2026-03-01T01:00:00.000Z');
  const { db, queries } = stubDb(
    [{ id: 9n, created_at: live, scene: null }],
    [{ id: 7n, created_at: at, scene: 'search' }],
  );
  const moments = await createLinkLogMomentReader(db).moments(APP, [7n, 8n, 9n, 7n]);
  expect([...moments]).toEqual([
    ['9', { at: live, scene: null }],
    ['7', { at, scene: 'search' }],
  ]);
  expect(queries).toHaveLength(2);
  expect(queries[0]!.sql).toContain('"app"."link_logs"');
  expect(queries[0]!.parameters).toEqual([APP, ['7', '8', '9']]);
  expect(queries[1]!.sql).toContain('"app"."link_log_evidence"');
  expect(queries[1]!.sql).not.toContain('product_key');
  expect(queries[1]!.parameters).toEqual([APP, ['7', '8']]);
});
