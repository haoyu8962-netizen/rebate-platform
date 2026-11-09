// B1-06zk rule-test helpers (FU-MERGE-PDD-OPEN-TOMBSTONE; D10-1123 / B1-20c T-7; BR-ID-06 「当前账号置
// 墓碑（status=deleted，deleted_reason=merged）」, 细则「并号后的源账号」). A user whose row is a
// tombstone (users.status = 'deleted': after a merge, deleted_reason merged; after a completed
// deletion as well) never gets an active Pinduoduo binding nor a union_pdd_pid_filings row from
// activatePddBinding (the open, the GET /v1/unions/bindings refresh, the share creation): read after
// the user lock, answered as the banned user is (10001), never a 500.
// The fixtures are the frozen kits (open-pdd-auth/kit.ts, bindings-pdd-query/kit.ts, shares/kit.ts,
// pdd-pid-filings/kit.ts), imported and never modified. The tombstone is written straight onto the
// users row from another connection, as a committed merge leaves it: either before the request, or
// while the union authority query is in flight (the merge committing after the request's earlier
// checks and before its activation, the window D10-1123 names). holdMerge / waitingOnMerge (#3, #4)
// hold the merge uncommitted on the users row lock (FOR UPDATE, tombstone written) until the
// request's activation is seen waiting on it, then commit: a status read before the lock misses it.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { BindingStatus } from '../open-pdd-auth/database.ts';

export const TIMEOUT = 120_000;

/** users.deleted_reason of the tombstone: a merge (BR-ID-06) or a completed deletion (BR-ID-27). */
export type TombstoneReason = 'merged' | 'account_deleted';

/** When the tombstone is committed: before the request, or during the authority query. */
export type TombstoneWhen = 'before_request' | 'during_query';

export interface TombstoneCase {
  readonly binding: Exclude<BindingStatus, 'active' | 'blocked'>;
  readonly when: TombstoneWhen;
  readonly reason: TombstoneReason;
}

/** Every stored state that goes through the activation (not active, not blocked). */
export const CASES: readonly TombstoneCase[] = [
  { binding: 'absent', when: 'before_request', reason: 'merged' },
  { binding: 'absent', when: 'during_query', reason: 'merged' },
  { binding: 'unbound', when: 'during_query', reason: 'merged' },
  { binding: 'pending_auth', when: 'during_query', reason: 'merged' },
  { binding: 'invalid', when: 'before_request', reason: 'merged' },
  { binding: 'released', when: 'during_query', reason: 'account_deleted' },
];

/** The authorization page's projection of a stored pdd binding (union-auth-reads.ts binding). */
export const PROJECTION: Readonly<Record<TombstoneCase['binding'], string>> = {
  absent: 'unbound',
  unbound: 'unbound',
  pending_auth: 'pending_auth',
  invalid: 'invalid',
  released: 'released',
};

/** Makes the user's row a tombstone, as the merge (or the deletion) commits it. */
export async function tombstone(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  reason: TombstoneReason,
): Promise<void> {
  const updated = await db
    .updateTable('users')
    .set((eb) => ({
      status: 'deleted',
      deleted_reason: reason,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .where('status', '<>', 'deleted')
    .executeTakeFirst();
  expect(updated.numUpdatedRows).toBe(1n);
}

/** A merge stand-in holding the source user's row lock with the tombstone written, uncommitted. */
export interface HeldMerge {
  /** The backend of the merge transaction (what the activation must wait on). */
  readonly pid: number;
  /** Lets the merge transaction commit. */
  readonly commit: () => void;
  readonly done: Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>;
}

/**
 * The merge transaction as 规划/02 §18 orders it, stopped before its commit: the source users row
 * locked FOR UPDATE, then status = 'deleted' (deleted_reason) written on it. It commits only when
 * the test says so, after the request has been seen waiting on that lock (no sleeps decide order).
 */
export async function holdMerge(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  reason: TombstoneReason,
): Promise<HeldMerge> {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const done = db
    .transaction()
    .execute(async (trx) => {
      // A broken locking implementation must fail an assertion, never hang the suite.
      await sql`SET LOCAL lock_timeout = '4s'`.execute(trx);
      await trx
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const updated = await trx
        .updateTable('users')
        .set((eb) => ({
          status: 'deleted',
          deleted_reason: reason,
          row_version: eb('row_version', '+', 1),
        }))
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .where('status', '<>', 'deleted')
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new Error('synthetic merge: no user row tombstoned');
      const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      ready.resolve(backend.rows[0]!.pid);
      await release.promise;
    })
    .then(
      () => ({ ok: true }) as const,
      (error: unknown) => {
        ready.reject(error);
        return { ok: false, error } as const;
      },
    );
  return { pid: await ready.promise, commit: () => release.resolve(), done };
}

/** Bounded polling until a backend on the users row waits on `pid`'s lock (else an assertion). */
export async function waitingOnMerge(db: Kysely<DB>, pid: number): Promise<void> {
  const deadline = performance.now() + 10_000;
  let waiting = false;
  do {
    const result = await sql<{ query: string }>`SELECT query FROM pg_stat_activity
      WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`.execute(db);
    waiting = result.rows.some((row) => /users/i.test(row.query));
    if (waiting) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  } while (performance.now() < deadline);
  expect(waiting).toBe(true);
}

/** The user's row still is the tombstone written (no path revives it). */
export async function expectTombstone(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  reason: TombstoneReason,
): Promise<void> {
  const row = await db
    .selectFrom('users')
    .select(['status', 'deleted_reason'])
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ status: 'deleted', deleted_reason: reason });
}
