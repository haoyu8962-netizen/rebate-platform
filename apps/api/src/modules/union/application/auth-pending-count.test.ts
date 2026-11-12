import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
} from 'kysely';
import { expect, it } from 'vitest';
import { countUnionAuthPending } from './auth-pending-count.ts';

/** 不连库：记录每条编译后的语句，并以给定的行作答（pg 的 count(*) 是 bigint，以字符串返回）。 */
function recordingDb(rows: readonly Record<string, unknown>[]): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery: <R>(query: CompiledQuery) => {
      queries.push(query);
      return Promise.resolve({ rows: rows as R[] });
    },
    streamQuery: () => {
      throw new Error('stream not supported');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
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

it('[AC-B1-22zc-UNIT#3][BR-ID-24] 只读一条 count(*)：按本 app 与 auth_status in (expiring, expired) 过滤', async () => {
  const { db, queries } = recordingDb([{ count: '5' }]);
  await expect(countUnionAuthPending(db, 'couli')).resolves.toBe(5);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toBe(
    'select count(*) as "count" from "app"."union_accounts" where "app_id" = $1 and "auth_status" in ($2, $3)',
  );
  expect(queries[0]!.parameters).toEqual(['couli', 'expiring', 'expired']);
});

it('[AC-B1-22zc-UNIT#4][BR-ID-24] count 转成 number：0 行时为 0', async () => {
  const { db } = recordingDb([{ count: '0' }]);
  const count = await countUnionAuthPending(db, 'other-app');
  expect(count).toBe(0);
  expect(typeof count).toBe('number');
});
