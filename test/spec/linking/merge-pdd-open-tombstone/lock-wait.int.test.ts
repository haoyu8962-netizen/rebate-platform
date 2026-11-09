// B1-06zk #3 (FU-MERGE-PDD-OPEN-TOMBSTONE, D10-1123; BR-ID-06 细则「并号后的源账号」): the merge
// and the activation contend for the same users row lock. The merge transaction (stand-in, kit.ts
// holdMerge) locks the source users row FOR UPDATE and writes status = 'deleted' while the union
// authority query is in flight, and does not commit; the activation, still seeing the committed
// 'normal', must wait on that lock. Only once the request is seen waiting on the merge's lock
// (pg_blocking_pids; no sleeps decide order) does the merge commit. The tombstone is read after the
// user lock → no active binding, no union_pdd_pid_filings row; the open answers 10001. A status
// read before the lock (or before the activation) misses it.
// Main activates the tombstone (red there).
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { expect, it, type Mock } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { fixture as openFixture, outcome, service, type Query } from '../open-pdd-auth/kit.ts';
import { noAuthEntry, response } from '../open-pdd-auth/assertions.ts';
import { filings } from '../pdd-pid-filings/kit.ts';
import {
  TIMEOUT,
  expectTombstone,
  holdMerge,
  waitingOnMerge,
  type HeldMerge,
  type TombstoneCase,
  type TombstoneReason,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

type Contended = Pick<TombstoneCase, 'binding' | 'reason'>;

const OPEN_CASES: readonly Contended[] = [
  { binding: 'absent', reason: 'merged' },
  { binding: 'invalid', reason: 'merged' },
  { binding: 'pending_auth', reason: 'account_deleted' },
];

/**
 * Runs `request` with its single union authority query answered filed after the merge stand-in
 * holds the user's row lock; commits the merge once the request waits on it. Returns the request's
 * value and the merge's end.
 */
async function contended<T>(
  f: {
    readonly db: Kysely<DB>;
    readonly appId: string;
    readonly a: { readonly userId: string };
    readonly query: Mock<Query>;
  },
  reason: TombstoneReason,
  request: () => Promise<T>,
): Promise<{ readonly value: T; readonly merged: Awaited<HeldMerge['done']> | null }> {
  const held = Promise.withResolvers<HeldMerge>();
  f.query.mockImplementationOnce(async () => {
    try {
      held.resolve(await holdMerge(f.db, f.appId, f.a.userId, reason));
    } catch (error) {
      held.reject(error);
      throw error;
    }
    return { authorized: true };
  });
  const pending = request();
  const entered = await Promise.race([held.promise, pending.then(() => null)]);
  try {
    // The request reached its query and the merge holds the lock; the activation must wait on it.
    expect(entered).not.toBeNull();
    if (entered !== null) await waitingOnMerge(f.db, entered.pid);
  } finally {
    entered?.commit();
    await Promise.allSettled([entered?.done, pending]);
  }
  return { value: await pending, merged: entered === null ? null : await entered.done };
}

it.each(OPEN_CASES)(
  '[AC-B1-06zk#3] 自己的拼多多 open 与并号争用同一用户锁：$binding 绑定、查询答已备案，并号持 users FOR UPDATE 写墓碑（deleted_reason=$reason）未提交，open 等锁后并号提交 → 10001，不写 active 绑定、不写备案、不转链',
  async ({ binding, reason }) => {
    const f = await openFixture(database(), { binding, query: true, scene: 'search' });
    const before = await f.bindings();

    const { value, merged } = await contended(f, reason, () =>
      outcome(() => service(f).open(f.request())),
    );

    expect(merged).toEqual({ ok: true });
    expect(f.query).toHaveBeenCalledTimes(1);
    const result = await response(value, 10001, 401);
    noAuthEntry(result);
    expect(f.convert).not.toHaveBeenCalled();
    const after = await f.bindings();
    expect(after.filter((row) => row.status === 'active')).toEqual([]);
    expect(after).toEqual(before);
    expect(await filings(f)).toEqual([]);
    expect(await f.sessions()).toEqual([]);
    await expectTombstone(f.db, f.appId, f.a.userId, reason);
  },
  TIMEOUT,
);
