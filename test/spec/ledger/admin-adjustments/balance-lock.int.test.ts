// B2-12c balance row lock (claude-independent; spec-test r1 S1 on concurrency.int.test.ts #26):
// BR-FUND-24 ① (批准时在同一事务内重读余额并写凭证), BR-FUND-16 (account_balances 在同一事务内
// SELECT … FOR UPDATE 后更新), BR-FUND-10 并发 (提现冻结与扣减按 account_id 行锁串行；冻结先提交则调减
// 照常把 available 扣负，frozen 不动). Unlike kit.ts holdMember, the barrier here holds the member's
// account_balances row only (ledger.lockBalances on the suite's second pool, no users row), so a
// request found blocked by that backend waits on the balance row itself (pg_blocking_pids; the
// barrier's pg_locks carry nothing on app.users). Both commit orders are pinned: the freeze first,
// then the adjustment first (a freeze queued on the same row behind the request).
// Amounts by hand: freeze first — 3000, freeze 1000 → 2000 / 1000, decrease 5000 → −3000 / 1000;
// adjustment first — 3000, decrease 1500 → 1500 / 0, then freeze 1000 → 500 / 1000.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { expect, it } from 'vitest';
import type { AccountBalance } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  entriesOf,
  expectAdjusted,
  fixture,
  member,
  moneyOf,
  newForm,
  postFreeze,
  seedReconDiff,
  suite,
  templateEntries,
  track,
  waiting,
  withAdjustAdmin,
  type AdjustFixture,
  type Ref,
  type Tracked,
} from './kit.ts';

const s = suite();

interface BalanceHold {
  /** The backend holding the balance row. */
  readonly pid: number;
  release(): Promise<void>;
}

/**
 * Holds the member's account_balances row (ledger.lockBalances only, never the users row) from the
 * suite's second pool; `beforeCommit` runs on that transaction after release() and before commit.
 */
async function holdBalance(
  f: AdjustFixture,
  userId: string,
  beforeCommit?: (trx: Transaction<DB>, balance: AccountBalance) => Promise<void>,
): Promise<BalanceHold> {
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
      const [balance] = await f.ledger.lockBalances(trx, { appId: f.appId, userIds: [userId] });
      if (balance === undefined) throw new Error(`kit: ${userId} has no balance row`);
      const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      const pid = backend.rows[0]?.pid;
      if (pid === undefined) throw new Error('kit: no backend pid');
      locked(pid);
      await gate;
      if (beforeCommit !== undefined) await beforeCommit(trx, balance);
    });
  const pid = await Promise.race([
    ready,
    done.then(() => {
      throw new Error('kit: the balance hold ended before it locked');
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

/** Locks the barrier backend holds on app.users (relation or rows): must be none. */
async function usersLocksOf(f: AdjustFixture, pid: number): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM pg_locks
    WHERE pid = ${pid}::int AND relation = 'app.users'::regclass`.execute(f.db);
  return Number(result.rows[0]?.n ?? '0');
}

/**
 * True once some backend of the test database is blocked by `pid` (pg_blocking_pids); false when a
 * request ended first or after the timeout (the caller asserts).
 */
async function blockedBy(
  f: AdjustFixture,
  pid: number,
  pending: readonly Tracked<unknown>[],
  timeoutMs = 10_000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))`.execute(
      f.db,
    );
    if (Number(result.rows[0]?.n ?? '0') >= 1) return true;
    if (pending.some((request) => request.settled)) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** True once `check` holds; false when one of `pending` ended first or after the timeout. */
async function until(
  check: () => boolean,
  pending: readonly Tracked<unknown>[],
  timeoutMs = 10_000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    if (pending.some((request) => request.settled)) return check();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

function freezeEntries(userId: string, amount: bigint) {
  return templateEntries('WITHDRAW:FREEZE', { userId, platform: null, amount });
}

it('[AC-B2-12c#38] 只持余额行锁的屏障（不持 users 行锁）：调减阻塞在 account_balances 那一行上；冻结 1000 先提交，调减 5000 在锁后重读（应答 before 2000、after −3000）；调账凭证与冻结凭证分录逐行对模板，余额 −3000、冻结 1000', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const withdrawalId = randomUUID();
    const note = '多记的结算冲减（余额锁）';
    const hold = await holdBalance(f, userId, async (trx, balance) => {
      await postFreeze(f, trx, balance, 1000n, withdrawalId);
    });
    const pending = track(
      h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 5000n,
          reason: 'RECON_FIX',
          refs: [diff],
          note,
          contra: 'COMMISSION_REVENUE',
        }),
      ),
    );
    try {
      expect(await usersLocksOf(f, hold.pid), '屏障不持 users 的任何锁').toBe(0);
      expect(
        await blockedBy(f, hold.pid, [pending]),
        '调减应阻塞在只持余额行锁的屏障上（即 account_balances 行锁）',
      ).toBe(true);
    } finally {
      await hold.release();
    }

    await expectAdjusted(f, await pending.promise, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 5000n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [diff],
      note,
      before: { available: 2000n, frozen: 1000n },
    });
    expect(await entriesOf(f, `wd:${withdrawalId}:FREEZE`), 'WITHDRAW:FREEZE').toEqual(
      freezeEntries(userId, 1000n),
    );
    expect(await moneyOf(f, userId)).toEqual({ available: -3000n, frozen: 1000n });
  });
});

it('[AC-B2-12c#39] 调账先提交：调减 1500 阻塞在只持余额行锁的屏障上，随后的提现冻结排在它后面等同一余额行；屏障放开后调减先提交（before 3000、after 1500），冻结在锁内读到 1500 再冻结 1000；两张凭证分录逐行对模板，余额 500、冻结 1000', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const withdrawalId = randomUUID();
    const note = '多记的结算冲减（调账先提交）';
    const state: { seen?: AccountBalance; freezing?: Tracked<string> } = {};
    let openFreeze!: () => void;
    const freezeGate = new Promise<void>((resolve) => {
      openFreeze = resolve;
    });

    const hold = await holdBalance(f, userId);
    const adjusting = track(
      h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 1500n,
          reason: 'RECON_FIX',
          refs: [diff],
          note,
          contra: 'COMMISSION_REVENUE',
        }),
      ),
    );
    try {
      try {
        expect(await usersLocksOf(f, hold.pid), '屏障不持 users 的任何锁').toBe(0);
        expect(
          await blockedBy(f, hold.pid, [adjusting]),
          '调减应阻塞在只持余额行锁的屏障上（即 account_balances 行锁）',
        ).toBe(true);
        const freezing = track(
          f.db
            .transaction()
            .execute(async (trx) => {
              const [balance] = await f.ledger.lockBalances(trx, {
                appId: f.appId,
                userIds: [userId],
              });
              if (balance === undefined) throw new Error(`kit: ${userId} has no balance row`);
              state.seen = balance;
              await freezeGate;
              await postFreeze(f, trx, balance, 1000n, withdrawalId);
            })
            .then(
              () => 'committed',
              (error: unknown) => `failed: ${String(error)}`,
            ),
        );
        state.freezing = freezing;
        expect(await waiting(f, 2, [adjusting, freezing]), '冻结应在同一余额行上排在调减后面').toBe(
          true,
        );
      } finally {
        await hold.release();
      }

      const sent = await adjusting.promise;
      const queued = state.freezing!;
      expect(
        await until(() => state.seen !== undefined, [queued]),
        '调减提交后冻结才拿到余额行锁',
      ).toBe(true);
      await expectAdjusted(f, sent, {
        caller: h.maker,
        userId,
        direction: 'decrease',
        amount: 1500n,
        reason: 'RECON_FIX',
        contra: 'COMMISSION_REVENUE',
        refs: [diff],
        note,
        before: { available: 3000n, frozen: 0n },
      });
      expect(state.seen, '冻结在锁内读到调减之后的余额').toMatchObject({
        available_fen: 1500n,
        frozen_fen: 0n,
      });
    } finally {
      openFreeze();
      if (state.freezing !== undefined) await state.freezing.promise;
    }

    expect(await state.freezing?.promise, '冻结事务提交').toBe('committed');
    expect(await entriesOf(f, `wd:${withdrawalId}:FREEZE`), 'WITHDRAW:FREEZE').toEqual(
      freezeEntries(userId, 1000n),
    );
    expect(await moneyOf(f, userId)).toEqual({ available: 500n, frozen: 1000n });
  });
});
