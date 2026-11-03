// B2-09k rule tests for the five findings of rule-test review r1 (claude-independent, SPEC_REF
// 6f50a051): contracts/openapi.yaml adminBatchApproveWithdrawals, adminRejectWithdrawal, 08 BR-WDR-10,
// BR-WDR-05 (a) (b), BR-WDR-30. W2 judges the balance read under the member's locks, not one read
// before them. W3 does not take W2's guards: a negative balance or blocked_reason does not stop a
// rejection, or the money stays frozen for good, and the posting that brings available back to 0 or
// above lifts blocked_reason (BR-WDR-05 (a)). A review_mode=auto withdrawal can be rejected while
// APPROVED. A risk freeze or an effective hold does not stop a rejection (BR-WDR-05 (b)).
// Every transfer attempt counts, not the latest attempt: a transfer with result pending, success or
// unknown stops the rejection whatever came after it. A withdrawal has at most one transfer attempt
// (db/migrations/0094_payout-core.sql payout_attempts_transfer_once_key, D10-237), so two transfer
// attempts cannot be seeded; what can come after the transfer is a query, and a failed query is the
// newest attempt in these cases.
// Requests go through the real admin entry (review-harness.ts). Top-level it() only (规划/11 §4.3).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { voucher } from '../../ledger/posting/kit.ts';
import {
  AFTER_FREEZE,
  AMOUNT,
  APPROVE_ACTION,
  BALANCE,
  NOTE,
  PAYER_SIDE,
  REJECT_ACTION,
  adjust,
  ago,
  audits,
  balanceOf,
  changes,
  entries,
  everything,
  fixture,
  frozenMismatches,
  itemsOf,
  lockUsersRow,
  member,
  refused,
  rejectBody,
  rejectedBy,
  returnVouchers,
  rowOf,
  seedApproved,
  seedAttempt,
  seedHold,
  seedReview,
  seedRiskState,
  skippedItem,
  suite,
  track,
  waiting,
  withReviewAdmin,
  type Member,
  type ReviewAdmin,
  type WithdrawalRow,
  type ReviewFixture,
} from './review-harness.ts';

const s = suite();

/** The adjustment of the harness's adjust() on a transaction already holding the users row. */
async function adjustOn(
  trx: Transaction<DB>,
  f: ReviewFixture,
  who: Member,
  delta: bigint,
): Promise<void> {
  const [balance] = await f.ledger.lockBalances(trx, { appId: who.appId, userIds: [who.userId] });
  if (balance === undefined) throw new Error('seed: the member has no balance row');
  const adjustment = voucher(who.appId, balance.account_id, -delta);
  await f.ledger.post(trx, {
    ...adjustment,
    entries: adjustment.entries.map((line) => ({ ...line, ledger_type: 'ADMIN_ADJUST' })),
  });
}

/** The two lines of WITHDRAW:RETURN for `amount` (user subaccounts: signs opposite to the deltas). */
async function expectReturnVoucher(
  f: ReviewFixture,
  w: WithdrawalRow,
  amount: bigint,
): Promise<void> {
  expect(await entries(f.db, f.appId, `wd:${w.id}:RETURN`)).toEqual([
    {
      owner_type: 'user',
      subject: 'USER_BALANCE',
      sub_account: 'frozen',
      amount_fen: amount,
      ledger_type: 'WITHDRAW_RETURN',
    },
    {
      owner_type: 'user',
      subject: 'USER_BALANCE',
      sub_account: 'available',
      amount_fen: -amount,
      ledger_type: 'WITHDRAW_RETURN',
    },
  ]);
}

/**
 * A transfer with this result 20 minutes ago and a failed query 10 minutes ago: refused with
 * reject_attempt_exists, nothing written; without a hold and with the payer-side hold, whose query
 * guard alone would let the failed query through.
 */
async function refusedWithNewerFailure(
  f: ReviewFixture,
  h: ReviewAdmin,
  result: 'pending' | 'success' | 'unknown',
): Promise<void> {
  for (const hold of [null, PAYER_SIDE]) {
    const label = `${result} ${String(hold)}`;
    const who = await member(f, h);
    const w = await seedApproved(f, h, who, { hold_reason: hold });
    await seedAttempt(f, w, { kind: 'transfer', result, at: ago(f, 20) });
    await seedAttempt(f, w, { kind: 'query', result: 'fail', at: ago(f, 10) });
    const before = await everything(f);

    await refused(await h.reject(w.id, rejectBody()), 'reject_attempt_exists');

    expect(await everything(f), label).toEqual(before);
    expect(await rowOf(f, w), label).toEqual(w);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId), label).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });
    expect(await returnVouchers(f), label).toEqual([]);
  }
}

it('[AC-B2-09k#55] W2 在锁内读余额：available 0、frozen 12,345，通过请求在 users 行锁上等待时，另一事务写一笔 −1,001 的扣回并提交 → skipped negative_balance，单仍是 PENDING_REVIEW，没有审计、没有事件', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h, AMOUNT);
    const w = await seedReview(f, h, who);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 0n,
      frozen_fen: 12_345n,
    });
    const before = await everything(f);
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const pending = track(h.approve([w.id]));
    try {
      expect(await waiting(f, 1, [pending]), '通过请求应在 users 行锁上等待').toBe(true);
    } finally {
      await lock.release((trx) => adjustOn(trx, f, who, -1_001n));
    }

    expect(await itemsOf(await pending.promise)).toEqual([skippedItem(w.id, 'negative_balance')]);

    expect(await rowOf(f, w)).toEqual(w);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: -1_001n,
      frozen_fen: 12_345n,
    });
    expect(await audits(f, APPROVE_ACTION)).toEqual([]);
    expect(await changes(f.db, f.appId)).toEqual([]);
    const moved = { vouchers: [], entries: [], balances: [], idempotency: [] };
    expect({ ...(await everything(f)), ...moved }).toEqual({ ...before, ...moved });
  });
});

it('[AC-B2-09k#56] W3 不看 W2 的守卫：APPROVED、blocked_reason=NEGATIVE_BALANCE、一条 fail 转账尝试、hold_reason 为空、available −1,001、frozen 12,345，驳回成功：REJECTED，available 11,344，frozen 0，blocked_reason 清空', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h, AMOUNT);
    const w = await seedApproved(f, h, who, { blocked_reason: 'NEGATIVE_BALANCE' });
    await seedAttempt(f, w, { kind: 'transfer', result: 'fail', at: ago(f, 10) });
    await adjust(f, who, -1_001n);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: -1_001n,
      frozen_fen: 12_345n,
    });

    await rejectedBy(f, await h.reject(w.id, rejectBody()), w, h.reviewer.id, 'PAYEE_INFO_INVALID');

    // row_version is not pinned to + 1: the recovery port (BR-WDR-05 (a)) lifts blocked_reason on
    // the same transaction and counts as a change of its own.
    const after = await rowOf(f, w);
    expect(after.row_version).toBeGreaterThan(w.row_version);
    expect(after).toEqual({
      ...w,
      status: 'REJECTED',
      reject_reason_code: 'PAYEE_INFO_INVALID',
      reject_note: NOTE,
      reviewer_id: h.reviewer.id,
      reviewed_at: f.clock.now(),
      blocked_reason: null,
      row_version: after.row_version,
      updated_at: f.clock.now(),
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 11_344n,
      frozen_fen: 0n,
    });
    await expectReturnVoucher(f, w, 12_345n);
    expect(await returnVouchers(f)).toEqual([`wd:${w.id}:RETURN`]);
    expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'REJECTED' },
    ]);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09k#57] review_mode=auto 也能驳回：系统 W2 留下的 APPROVED、reviewer_id 为空、金额 12,345，驳回（OTHER）成功，reviewer_id 是调用者，退回 12,345；review_mode 与 auto_decision 不变', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedApproved(f, h, who, {
      review_mode: 'auto',
      reviewer_id: null,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: [],
        rule_version: 3,
        decided_at: ago(f, 20).toISOString(),
      },
    });
    expect(w.reviewer_id).toBeNull();

    await rejectedBy(
      f,
      await h.reject(w.id, rejectBody({ reason_code: 'OTHER' })),
      w,
      h.reviewer.id,
      'OTHER',
    );

    expect(await rowOf(f, w)).toEqual({
      ...w,
      status: 'REJECTED',
      reject_reason_code: 'OTHER',
      reject_note: NOTE,
      reviewer_id: h.reviewer.id,
      reviewed_at: f.clock.now(),
      row_version: w.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
    await expectReturnVoucher(f, w, 12_345n);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09k#58] 看全部尝试（防重复打款）：20 分钟前转账 unknown、10 分钟前查询 fail → 20001 reject_attempt_exists，什么都不写；只看最新一条的实现会把钱退了，而 unknown 那笔可能已打出去；付款方侧 hold 同样', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await refusedWithNewerFailure(f, h, 'unknown');
  });
});

it('[AC-B2-09k#59] 看全部尝试（防重复打款）：20 分钟前转账 pending、10 分钟前查询 fail → 20001 reject_attempt_exists，什么都不写；付款方侧 hold 同样', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await refusedWithNewerFailure(f, h, 'pending');
  });
});

it('[AC-B2-09k#60] 看全部尝试（防重复打款）：20 分钟前转账 success、10 分钟前查询 fail → 20001 reject_attempt_exists，什么都不写；付款方侧 hold 同样', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await refusedWithNewerFailure(f, h, 'success');
  });
});

it('[AC-B2-09k#61] 路由层驳回风控冻结的会员（BR-WDR-05 (b)：W3 不受影响）：PENDING_REVIEW 的单驳回成功，退回 12,345，冻结状态不被改动', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    await seedRiskState(f, who, 'frozen');
    const w = await seedReview(f, h, who);

    await rejectedBy(f, await h.reject(w.id, rejectBody()), w, h.reviewer.id, 'PAYEE_INFO_INVALID');

    expect(await rowOf(f, w)).toMatchObject({
      status: 'REJECTED',
      reject_reason_code: 'PAYEE_INFO_INVALID',
      reviewer_id: h.reviewer.id,
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
    await expectReturnVoucher(f, w, 12_345n);
    const states = await f.db
      .selectFrom('user_risk_state')
      .select(['user_id', 'state'])
      .where('app_id', '=', f.appId)
      .execute();
    expect(states).toEqual([{ user_id: who.userId, state: 'frozen' }]);
  });
});

it('[AC-B2-09k#62] 路由层驳回有生效 withdraw_holds 的会员（BR-WDR-05 (b)：W3 不受影响）：PENDING_REVIEW 的单驳回成功，退回 12,345，冻结记录不动', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const hold = await seedHold(f, who, { reason: 'manual' });
    const w = await seedReview(f, h, who);

    await rejectedBy(f, await h.reject(w.id, rejectBody()), w, h.reviewer.id, 'PAYEE_INFO_INVALID');

    expect(await rowOf(f, w)).toMatchObject({
      status: 'REJECTED',
      reject_reason_code: 'PAYEE_INFO_INVALID',
      reviewer_id: h.reviewer.id,
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
    await expectReturnVoucher(f, w, 12_345n);
    expect((await everything(f)).holds).toEqual([hold]);
  });
});
