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
import { expect } from 'vitest';
import { equality, type PidRow } from '../taobao-dataoke-switches/kit.ts';

/** Rows in the order `order by "union_account_id"` asks for; insertion order without one. */
function ordered(rows: PidRow[], sql: string): PidRow[] {
  const match = /order by\s+"union_account_id"(\s+desc)?/i.exec(sql);
  if (match === null) return rows;
  const sign = match[1] === undefined ? 1 : -1;
  return [...rows].sort(
    (left, right) => sign * left.union_account_id.localeCompare(right.union_account_id),
  );
}

/**
 * Real Kysely compilation over an in-memory union_pids. Reads must be one SELECT of app.union_pids
 * bound by app_id, platform, pid_scene and status (`equality` fails a statement without one of
 * them); the rows are filtered by the bound values and sorted by union_account_id only when the
 * statement asks, so the reader sees what the database would. The B1-04p archive insert
 * (union_raw_payloads) of an assembled module is recorded apart.
 */
export function slotDatabase(initial: readonly PidRow[] = []) {
  let rows: readonly PidRow[] = initial;
  const statements: CompiledQuery[] = [];
  const archived: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(statement: CompiledQuery): Promise<QueryResult<R>> {
      if (/^insert into "app"\."union_raw_payloads"/i.test(statement.sql)) {
        archived.push(statement);
        return { rows: [{ id: BigInt(archived.length) }] as R[], numAffectedRows: 1n };
      }
      statements.push(statement);
      expect(statement.sql).toMatch(/^select\b/i);
      expect(statement.sql).toContain('"app"."union_pids"');
      expect(statement.sql).not.toMatch(/\b(insert|update|delete|for update)\b/i);
      const appId = equality(statement, 'app_id');
      const platform = equality(statement, 'platform');
      const scene = equality(statement, 'pid_scene');
      const status = equality(statement, 'status');
      const matching = rows.filter(
        (row) =>
          row.app_id === appId &&
          row.platform === platform &&
          row.pid_scene === scene &&
          row.status === status,
      );
      return { rows: ordered(matching, statement.sql) as R[] };
    },
    async *streamQuery() {
      expect.fail('the slot reader must not stream rows');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return {
    db,
    statements,
    archived,
    replace(next: readonly PidRow[]) {
      rows = next;
    },
  };
}
