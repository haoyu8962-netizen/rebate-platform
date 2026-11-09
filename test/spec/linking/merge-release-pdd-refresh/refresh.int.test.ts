// B1-20cb (D10-1154; B1-20c D10-1099 T-7 on the Pinduoduo refresh of GET /v1/unions/bindings,
// union-bindings-pdd.ts): two paths [AC-B1-20c#47] leaves uncovered.
// #1: the merge holds the users row (FOR UPDATE, status = deleted / deleted_reason = merged, not yet
//     committed) when the refresh's activation transaction asks for the bindings' user lock
//     (binding-lock.ts lockBindingUser, FOR NO KEY UPDATE). The test waits until the refresh is
//     seen blocked by the merge's backend (pg_blocking_pids, bounded poll; never a timed bet), then
//     commits: the refresh reads the tombstone after the lock, writes no active binding, the rows
//     stay as they were and the page still answers 200.
// #2: the account turns into a tombstone while the authority query is in flight (as #47) → no
//     union_pdd_pid_filings row is added; control in the same case: a live user of the same tenant
//     whose query answers authorized gets an active binding and exactly one filing row.
// Built on the frozen fixtures (bindings-pdd-query/kit.ts, open-pdd-auth/database.ts,
// pdd-pid-filings/kit.ts), imported and never modified.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { fixture, TIMEOUT, type Fixture } from '../bindings-pdd-query/kit.ts';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { filed, filings, REFRESH_PID } from '../pdd-pid-filings/kit.ts';

const database = databaseFixture(createTestDatabase);

/** The merge's side: locks the user's row, writes the tombstone, commits only on release. */
function merge(db: Kysely<DB>, f: Fixture) {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const done = db
    .transaction()
    .execute(async (trx) => {
      await sql`SELECT id FROM app.users WHERE app_id = ${f.appId} AND id = ${f.a.userId}
        FOR UPDATE`.execute(trx);
      await sql`UPDATE app.users SET status = 'deleted', deleted_reason = 'merged'
        WHERE app_id = ${f.appId} AND id = ${f.a.userId}`.execute(trx);
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      ready.resolve(pid.rows[0]!.pid);
      await release.promise;
    })
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        ready.reject(error);
        return { ok: false as const, error };
      },
    );
  return { ready: ready.promise, release: () => release.resolve(), done };
}

/** Resolves once a backend waits on `pid` for the users row lock; throws after the deadline. */
async function waitingOn(db: Kysely<DB>, pid: number): Promise<void> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const result = await sql<{ query: string }>`SELECT query FROM pg_stat_activity
      WHERE ${pid}::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`.execute(db);
    if (result.rows.some((row) => /users/i.test(row.query) && /for no key update/i.test(row.query)))
      return;
    if (performance.now() > deadline)
      throw new Error('the refresh never waited on the merge-held users row lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function status(f: Fixture) {
  return f.db
    .selectFrom('users')
    .select(['status', 'deleted_reason'])
    .where('app_id', '=', f.appId)
    .where('id', '=', f.a.userId)
    .executeTakeFirstOrThrow();
}

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-20cb#1] T-7 拼多多刷新与并号争用同一用户锁（存量 %s）：刷新确在等锁、并号提交墓碑后 → 不写 active，行原样，页面照常 200',
  async (stored) => {
    const f = await fixture(database(), stored);
    const before = await f.bindings();
    const filingsBefore = await filings(f);
    let held: ReturnType<typeof merge> | undefined;
    f.query.mockImplementationOnce(async () => {
      held = merge(f.db, f);
      await held.ready;
      return { authorized: true };
    });

    const request = f.list();
    let waited: unknown = null;
    try {
      // The query only returns once the merge holds the row; then the refresh must queue on it.
      await expect.poll(() => held !== undefined, { timeout: 5000, interval: 10 }).toBe(true);
      await waitingOn(f.db, await held!.ready);
    } catch (error) {
      waited = error;
    } finally {
      held?.release();
      await Promise.allSettled([held?.done, request]);
    }

    expect(waited).toBeNull();
    expect(await held!.done).toEqual({ ok: true });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(await status(f)).toEqual({ status: 'deleted', deleted_reason: 'merged' });
    expect(await request).toMatchObject({ status: 200, envelope: { code: 0 } });
    expect(await f.bindings()).toEqual(before);
    expect((await f.bindings()).filter((row) => row.status === 'active')).toEqual([]);
    expect(await filings(f)).toEqual(filingsBefore);
  },
  TIMEOUT,
);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-20cb#2] T-7 拼多多刷新途中账号变墓碑（存量 %s）→ 不新增 union_pdd_pid_filings 行；对照：同租户正常用户刷新答已授权 → 写 active 并新增一行备案',
  async (stored) => {
    const f = await fixture(database(), stored);
    const before = await f.bindings();
    expect(await filings(f)).toEqual([]);
    f.query.mockImplementationOnce(async () => {
      await sql`UPDATE app.users SET status = 'deleted', deleted_reason = 'merged'
        WHERE app_id = ${f.appId} AND id = ${f.a.userId}`.execute(f.db);
      return { authorized: true };
    });

    const tombstoned = await f.list();

    expect(f.query).toHaveBeenCalledTimes(1);
    expect(tombstoned).toMatchObject({ status: 200, envelope: { code: 0 } });
    expect(await f.bindings()).toEqual(before);
    expect(await filings(f)).toEqual([]);

    // Control: user b (live, no pdd binding) of the same tenant; the query answers authorized.
    f.current.mockResolvedValueOnce({ appId: f.appId, userId: f.b.userId, deviceId: f.b.deviceId });
    f.attrCode.mockResolvedValueOnce(f.b.attr);

    const live = await f.list();

    expect(f.query).toHaveBeenCalledTimes(2);
    expect(live).toMatchObject({ status: 200, envelope: { code: 0 } });
    const rows = await f.bindings();
    expect(rows.filter((row) => row.user_id === f.a.userId)).toEqual(before);
    expect(
      rows.filter((row) => row.user_id === f.b.userId).map((row) => [row.platform, row.status]),
    ).toEqual([['pdd', 'active']]);
    expect(await filings(f)).toEqual([filed(f, f.b.userId, REFRESH_PID, f.clock.now())]);
  },
  TIMEOUT,
);
