// Unit tests of readChannelMismatchOpen (B2-09zn): no database; a fake Kysely driver answers the one
// SELECT and records it. Pins that the type is compared for equality with channel_mismatch only (the
// collection side's pay_mismatch / pay_anomaly never count), not with IN (...) or a prefix match.
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
import { readChannelMismatchOpen } from './channel-mismatch-open-read.ts';

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

it('[AC-B2-09zn#u1] type 只与 channel_mismatch 做等值比较，status 只取 open 与 processing', async () => {
  const { db, queries } = fakeDb([]);
  expect(await readChannelMismatchOpen(db)).toEqual({ open: {} });
  expect(queries).toHaveLength(1);
  const query = queries[0]!;
  expect(query.sql).toMatch(/"type" = \$1\b/);
  expect(query.sql).not.toMatch(/"type"\s+(?:in|like|ilike)\b/i);
  expect(query.sql).not.toMatch(/starts_with|like/i);
  expect(query.sql).toMatch(/"status" in \(\$2, \$3\)/);
  expect(query.sql).toMatch(/from "app"\."recon_diffs"/);
  expect(query.sql).toMatch(/group by "app_id"/);
  expect(query.parameters).toEqual(['channel_mismatch', 'open', 'processing']);
  for (const other of ['pay_mismatch', 'pay_anomaly', 'ledger_mismatch', 'union_mismatch']) {
    expect(query.parameters).not.toContain(other);
  }
});

it('[AC-B2-09zn#u2] 每个 app_id 一个数字计数，没有行的 app 没有 key', async () => {
  const { db } = fakeDb([
    { app_id: 'alpha', open: 3 },
    { app_id: 'beta', open: '2' },
  ]);
  const result = await readChannelMismatchOpen(db);
  expect(result).toEqual({ open: { alpha: 3, beta: 2 } });
  expect(typeof result.open['beta']).toBe('number');
  expect(Object.hasOwn(result.open, 'gamma')).toBe(false);
});
