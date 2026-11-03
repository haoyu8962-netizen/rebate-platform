// B2-09k concurrency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchApproveWithdrawals, adminRejectWithdrawal, payout AGENTS.md 硬规则 1 (CAS, 20902) — two
// requests on one withdrawal: exactly one takes effect, the other gets 20902 or not_pending; one
// return voucher, the money returned once. The interleaving is made with a lock and no timing: the
// member's users row (first in the lock order, BR-WDR-07) is held from outside, the requests must wait
// on it, then it is released, or the row is moved by the holder first. Requests go through the real
// admin entry (review-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  BALANCE,
  REJECT_ACTION,
  answer,
  approvedItem,
  audits,
  balanceOf,
  changes,
  conflict,
  everything,
  fixture,
  itemsOf,
  lockUsersRow,
  member,
  moveBehind,
  rejectBody,
  rejectedBy,
  returnVouchers,
  rowOf,
  seedReview,
  skippedItem,
  suite,
  track,
  waiting,
  withReviewAdmin,
} from './review-harness.ts';

const s = suite();

it('[AC-B2-09k#38] 同一单两个不同键的驳回并发：恰一个成功，另一个 20902 withdrawal；只有一张 RETURN，100,003 只退回一次（不会 112,348），一个事件一条审计', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const first = track(h.reject(w.id, rejectBody()));
    const second = track(h.reject(w.id, rejectBody({ reason_code: 'OTHER' })));
    try {
      expect(await waiting(f, 2, [first, second]), '两个驳回都应在 users 行锁上等待').toBe(true);
    } finally {
      await lock.release();
    }
    const results = [await first.promise, await second.promise];

    const codes = results.map((sent) => sent.json().code).sort((a, b) => a - b);
    expect(codes).toEqual([0, 20902]);
    for (const sent of results) {
      if (sent.json().code === 0) await answer(sent, 0);
      else await conflict(sent);
    }
    expect(await rowOf(f, w)).toMatchObject({ status: 'REJECTED', row_version: w.row_version + 1 });
    expect(await returnVouchers(f)).toEqual([`wd:${w.id}:RETURN`]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
    expect(await changes(f.db, f.appId)).toHaveLength(1);
    expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09k#39] 通过和驳回并发：只有一方生效，另一方 not_pending 或 20902 withdrawal；通过赢则冻结不动、没有 RETURN，驳回赢则退回一次；各只有一条审计、一个事件', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const approve = track(h.approve([w.id]));
    const reject = track(h.reject(w.id, rejectBody()));
    try {
      expect(await waiting(f, 2, [approve, reject]), '两个请求都应在 users 行锁上等待').toBe(true);
    } finally {
      await lock.release();
    }

    const items = await itemsOf(await approve.promise);
    const rejected = await reject.promise;
    const approveWon = rejected.json().code !== 0;
    const returns = await returnVouchers(f);
    if (approveWon) {
      expect(items).toEqual([approvedItem(w.id)]);
      await conflict(rejected);
      expect(await rowOf(f, w)).toMatchObject({ status: 'APPROVED' });
      expect(returns).toEqual([]);
      expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
        available_fen: 87_658n,
        frozen_fen: 12_345n,
      });
      expect(await audits(f, APPROVE_ACTION)).toHaveLength(1);
      expect(await audits(f, REJECT_ACTION)).toEqual([]);
    } else {
      expect(items).toEqual([skippedItem(w.id, 'not_pending')]);
      await answer(rejected, 0);
      expect(await rowOf(f, w)).toMatchObject({ status: 'REJECTED' });
      expect(returns).toEqual([`wd:${w.id}:RETURN`]);
      expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
        available_fen: BALANCE,
        frozen_fen: 0n,
      });
      expect(await audits(f, APPROVE_ACTION)).toEqual([]);
      expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
    }
    expect(await changes(f.db, f.appId)).toHaveLength(1);
  });
});

it('[AC-B2-09k#40] CAS（确定性）：批量通过在 users 行锁上等待时，别的事务把这一单改成 APPROVED → 这一单 not_pending，同批另一单照常通过；这一单 reviewer 不变、没有审计', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const taken = await seedReview(f, h, who);
    const free = await seedReview(f, h, await member(f, h));
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const pending = track(h.approve([taken.id, free.id]));
    try {
      expect(await waiting(f, 1, [pending]), '批量通过应在 users 行锁上等待').toBe(true);
    } finally {
      await lock.release((trx) => moveBehind(trx, taken, f.clock.now()));
    }

    expect(await itemsOf(await pending.promise)).toEqual([
      skippedItem(taken.id, 'not_pending'),
      approvedItem(free.id),
    ]);
    expect(await rowOf(f, taken)).toEqual({
      ...taken,
      status: 'APPROVED',
      row_version: taken.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect((await audits(f, APPROVE_ACTION)).map((record) => record.target)).toEqual([free.id]);
  });
});

it('[AC-B2-09k#41] CAS（确定性）：驳回在 users 行锁上等待时，别的事务改了这一单（PENDING_REVIEW → APPROVED）→ 20902 withdrawal；没有 RETURN、没有事件、没有审计，余额不动', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const pending = track(h.reject(w.id, rejectBody()));
    try {
      expect(await waiting(f, 1, [pending]), '驳回应在 users 行锁上等待').toBe(true);
    } finally {
      await lock.release((trx) => moveBehind(trx, w, f.clock.now()));
    }

    await conflict(await pending.promise);

    expect(await rowOf(f, w)).toEqual({
      ...w,
      status: 'APPROVED',
      row_version: w.row_version + 1,
      updated_at: f.clock.now(),
    });
    const after = await everything(f);
    expect({ ...after, withdrawals: [], idempotency: [] }).toEqual({
      ...before,
      withdrawals: [],
      idempotency: [],
    });
  });
});

it('[AC-B2-09k#42] 串行不算并发：先通过，再驳回（新键）是合法的 W3，从 APPROVED 退回；再驳回一次（新键）→ 20902，只有一张 RETURN', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    expect(await itemsOf(await h.approve([w.id]))).toEqual([approvedItem(w.id)]);
    const approved = await rowOf(f, w);

    await rejectedBy(
      f,
      await h.reject(w.id, rejectBody()),
      approved,
      h.reviewer.id,
      'PAYEE_INFO_INVALID',
    );
    await conflict(await h.reject(w.id, rejectBody()));

    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
    expect(await returnVouchers(f)).toEqual([`wd:${w.id}:RETURN`]);
  });
});
