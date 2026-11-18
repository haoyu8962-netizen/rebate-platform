// B2-02x locks (claude-independent, SPEC_REF ba6655b1): recalcBalanceAdminReconDiff (CT-24zzn)
// within 08 BR-FUND-16 细则「加锁流程」 — the member's users row FOR UPDATE, then the member's
// account_balances row FOR UPDATE (steps 2 and 3, the order of every transaction that writes this
// balance; no order_key advisory lock); the sums are read after the locks are held, so a posting
// committed while the recalculation waits is in both the entries and the cache it reads, and a
// posting that waits behind the recalculation lands on the recalculated cache. Two recalculations
// at once are serialized (the second answers changed=false). Every outcome equals one serial
// order; nothing deadlocks. The second connection is the suite's one-connection holder pool.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  RECALC_ACTION,
  answer,
  audits,
  blockedBehind,
  cacheOf,
  creditOn,
  entrySums,
  expectRecalculated,
  fixture,
  holdBalance,
  holdRow,
  isBalanceLock,
  linesOf,
  lockWaiters,
  plainMember,
  seedMismatch,
  suite,
  tamper,
  track,
  tryLock,
  withRecalcAdmin,
  written,
  type AdjustFixture,
  type Member,
  type Tracked,
} from './kit.ts';

const s = suite();

const USERS_LOCK = /\busers\b[\s\S]*\bfor\s+update\b/i;

/** A credit of `amount` to the member on the holder pool: users row, balance row, then post. */
function postOnHolder(f: AdjustFixture, m: Member, amount: bigint): Promise<string> {
  return f.s
    .holder()
    .transaction()
    .execute(async (trx: Transaction<DB>) => {
      await lockUsersForUpdate(trx, { appId: m.appId, userIds: [m.userId] });
      const [balance] = await f.ledger.lockBalances(trx, { appId: m.appId, userIds: [m.userId] });
      if (balance === undefined) throw new Error(`kit: ${m.userId} has no ledger account`);
      return creditOn(f, trx, balance, amount);
    });
}

it('[AC-B2-02x#40] 先锁 users 行：另一连接持有该会员 users 行时，重算在 users 行的 FOR UPDATE 上等待，此时余额行还没被它锁（NOWAIT 能拿到）；放开后重算照常完成', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    const before = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const held = await holdRow(f, 'users', m.userId);
    const request = track(h.recalc(diff.id, { reason: '锁序' }));
    try {
      const waiters = await lockWaiters(f, 1, [request]);
      expect(waiters, '重算在等 users 行').toHaveLength(1);
      expect(waiters[0], '等待的语句是 users 行的 FOR UPDATE').toMatch(USERS_LOCK);
      expect(isBalanceLock(waiters[0] ?? ''), '不是先锁余额行').toBe(false);
      expect(await tryLock(f, m, 'account_balances'), '余额行此时未被重算锁住').toBe('ok');
    } finally {
      await held.release();
    }
    await expectRecalculated(f, await request.promise, {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, m)).toEqual(
      written(before, { available: 4900n, frozen: 0n, negativeSince: null }),
    );
  });
});

it('[AC-B2-02x#41] 再锁余额行：另一连接只持有该会员余额行时，重算已拿到 users 行（NOWAIT 拿不到，55P03）并在余额行的 FOR UPDATE 上等待；放开后完成', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const held = await holdBalance(f, m);
    expect(await held.untilLocked(), 'holder 拿到余额行').toBe(true);
    const request = track(h.recalc(diff.id, { reason: '锁序' }));
    try {
      const blocked = await blockedBehind(f, held.pid, [request]);
      expect(blocked, '重算被余额行挡住').toHaveLength(1);
      expect(isBalanceLock(blocked[0] ?? ''), `等待的语句是余额行 FOR UPDATE：${blocked[0]}`).toBe(
        true,
      );
      expect(await tryLock(f, m, 'users'), '重算已持有 users 行').toBe('55P03');
    } finally {
      await held.release();
    }
    await expectRecalculated(f, await request.promise, {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    expect(h.balanceLocks.length, '重算发过余额行 FOR UPDATE').toBeGreaterThan(0);
  });
});

it('[AC-B2-02x#42] 入账在先：重算等待期间另一事务入账 300 并提交 → 重算在锁内读到入账后的缓存与分录（before 5300、after 5200），结果等于先入账再重算；version 比开始时多 2', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    const start = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const held = await holdBalance(
      f,
      m,
      async (trx, balance) => {
        await creditOn(f, trx, balance, 300n);
      },
      { users: true },
    );
    expect(await held.untilLocked()).toBe(true);
    const request = track(h.recalc(diff.id, { reason: '入账并发' }));
    try {
      expect(await lockWaiters(f, 1, [request]), '重算等入账事务').not.toEqual([]);
      expect(request.settled).toBe(false);
    } finally {
      await held.release();
    }
    await expectRecalculated(f, await request.promise, {
      m,
      before: { available: 5300n, frozen: 0n },
      after: { available: 5200n, frozen: 0n },
      changed: true,
    });
    expect(await entrySums(f, m)).toEqual({ available: 5200n, frozen: 0n });
    expect(await cacheOf(f, m)).toEqual({
      ...start,
      available_fen: 5200n,
      version: start.version + 2n,
    });
  });
});

it('[AC-B2-02x#43] 重算在先：重算持锁期间另一事务的入账 300 在 users 行上等待；重算提交（before 5000、after 4900）后入账落在重算后的缓存上 → 5200，入账分录 balance_after_fen 5200、account_version 为最终 version；不死锁', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    const start = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const pause = h.pauseAfterBalanceLock();
    const request = h.recalc(diff.id, { reason: '重算先' });
    const state: { posting?: Tracked<string> } = {};
    try {
      expect(await pause.untilReached(request), '重算拿到余额行后停住').toBe(true);
      const pending = track(postOnHolder(f, m, 300n));
      state.posting = pending;
      const waiters = await lockWaiters(f, 1, [pending]);
      expect(waiters, '入账在等重算的锁').toHaveLength(1);
      expect(waiters[0]).toMatch(USERS_LOCK);
      expect(pending.settled).toBe(false);
    } finally {
      pause.resume();
    }
    await expectRecalculated(f, await request, {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    const posting = state.posting;
    expect(posting, '入账已发起').toBeDefined();
    const key = await posting!.promise;
    const final = await cacheOf(f, m);
    expect(final).toEqual({ ...start, available_fen: 5200n, version: start.version + 2n });
    expect(await entrySums(f, m)).toEqual({ available: 5200n, frozen: 0n });
    const userLines = (await linesOf(f, key)).filter((line) => line.owner_type === 'user');
    expect(userLines.map((line) => [line.balance_after_fen, line.account_version])).toEqual([
      [5200n, final.version],
    ]);
  });
});

it('[AC-B2-02x#44] 两个重算同时到：锁把它们排成先后——恰好一个 changed true（5000 → 4900）、一个 changed false（4900 → 4900），version 只加 1，各一条审计', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 4900n);
    const start = await tamper(f, m, { available: 5000n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    const sent = await Promise.all([
      h.recalc(diff.id, { reason: '并发一' }),
      h.recalc(diff.id, { reason: '并发二' }),
    ]);
    const data: { changed: boolean }[] = [];
    for (const one of sent) {
      data.push((await answer(one, 0)).data as { changed: boolean });
    }
    const first = sent[data.findIndex((d) => d.changed)];
    const second = sent[data.findIndex((d) => !d.changed)];
    expect(first, '恰好一个 changed true').toBeDefined();
    expect(second, '恰好一个 changed false').toBeDefined();
    await expectRecalculated(f, first!, {
      m,
      before: { available: 5000n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: true,
    });
    await expectRecalculated(f, second!, {
      m,
      before: { available: 4900n, frozen: 0n },
      after: { available: 4900n, frozen: 0n },
      changed: false,
    });
    expect(await cacheOf(f, m)).toEqual(
      written(start, { available: 4900n, frozen: 0n, negativeSince: null }),
    );
    expect(await audits(f, RECALC_ACTION)).toHaveLength(2);
  });
});
