// Unit tests of the previous-intent reader over a scripted in-memory Kysely driver (no database).
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
import { createPgPreviousIntentReader } from './index.ts';

const SESSION = '0b9d3c1e-6f0a-4c8e-9a51-1f2e3d4c5b6a';
const RUN = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

function scriptedDb(rows: readonly Record<string, unknown>[], fail?: Error) {
  const seen: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      seen.push(query);
      if (fail !== undefined) throw fail;
      return { rows: rows as R[] };
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
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, seen };
}

it('returns order_query / earnings_query as is, from one query on app.agent_runs', async () => {
  for (const intent of ['order_query', 'earnings_query'] as const) {
    const { db, seen } = scriptedDb([{ intent }]);
    const reader = createPgPreviousIntentReader({ db });
    expect(await reader.previousIntent({ appId: 'a', sessionId: SESSION, runId: RUN })).toBe(
      intent,
    );
    expect(seen).toHaveLength(1);
    const text = seen[0]?.sql ?? '';
    expect(text).toContain('"app"."agent_runs"');
    expect(text).toMatch(/order by "p"\."accepted_at" desc, "p"\."id" desc limit \$\d+/);
    expect(seen[0]?.parameters).toEqual(expect.arrayContaining(['a', SESSION, RUN]));
  }
});

it('answers null for any other intent, NULL or no previous run', async () => {
  for (const rows of [
    [{ intent: 'rule_qa' }],
    [{ intent: 'page_guide' }],
    [{ intent: null }],
    [],
  ]) {
    const { db } = scriptedDb(rows);
    const reader = createPgPreviousIntentReader({ db });
    expect(await reader.previousIntent({ appId: 'a', sessionId: SESSION, runId: RUN })).toBeNull();
  }
});

it('answers null without any query for a session or run id that is not a uuid', async () => {
  const { db, seen } = scriptedDb([{ intent: 'order_query' }]);
  const reader = createPgPreviousIntentReader({ db });
  for (const sessionId of ['not-a-uuid', '', `${SESSION}x`]) {
    expect(await reader.previousIntent({ appId: 'a', sessionId, runId: RUN })).toBeNull();
  }
  expect(await reader.previousIntent({ appId: 'a', sessionId: SESSION, runId: 'x' })).toBeNull();
  expect(seen).toHaveLength(0);
});

it('rejects with the database error', async () => {
  const failure = new Error('synthetic read failure');
  const { db } = scriptedDb([], failure);
  const reader = createPgPreviousIntentReader({ db });
  await expect(reader.previousIntent({ appId: 'a', sessionId: SESSION, runId: RUN })).rejects.toBe(
    failure,
  );
});
