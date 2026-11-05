// Deterministic schedules: prove a blocking chain rooted at our external holder's backend.
// No sleep and no assumption that launching promises means either request reached its lock.
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { ReviewFixture } from './unknown-harness.ts';

export async function holdRow(
  f: ReviewFixture,
  table: 'users' | 'withdrawals' | 'tax_ytd',
  id: string,
) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => {
    locked = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const result = await sql`SELECT id FROM app.${sql.id(table)}
      WHERE app_id = ${f.appId} AND id = ${id} FOR UPDATE`.execute(trx);
      expect(result.rows).toHaveLength(1);
      const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      locked(backend.rows[0]!.pid);
      await gate;
    });
  const pid = await Promise.race([
    ready,
    done.then(() => {
      throw new Error('holder ended before ready');
    }),
  ]);
  return {
    pid,
    async release() {
      open();
      await done;
    },
  };
}

export async function blocked(
  f: ReviewFixture,
  holder: number,
  count: number,
  pending: readonly { readonly settled: boolean }[],
): Promise<number[]> {
  for (let poll = 0; poll < 2000; poll += 1) {
    const result = await sql<{ pid: number }>`WITH RECURSIVE waiting_on(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND ${holder}::integer = ANY(pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_stat_activity a JOIN waiting_on w ON w.pid = ANY(pg_blocking_pids(a.pid))
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
    ) SELECT DISTINCT pid FROM waiting_on`.execute(f.db);
    if (result.rows.length >= count) return result.rows.map((row) => row.pid);
    if (pending.some((request) => request.settled)) return [];
  }
  return [];
}

export async function waitersSql(f: ReviewFixture, pids: readonly number[]): Promise<string[]> {
  if (pids.length === 0) return [];
  const result = await sql<{ query: string }>`SELECT query FROM pg_stat_activity
    WHERE pid = ANY(${pids}::integer[])`.execute(f.db);
  return result.rows.map((row) => row.query);
}
