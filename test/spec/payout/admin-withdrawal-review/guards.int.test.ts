// B2-09k rejection guard rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminRejectWithdrawal, 08 BR-WDR-10, BR-WDR-08 W3, BR-WDR-17 (决-08 A), BR-WDR-15. A transfer attempt
// with result pending, success or unknown → 20001 reject_attempt_exists. While the switch
// payout.proven_success_writeoff.enabled is on (default on), hold_reason=payer_side_after_transfer is
// checked against its latest query, because a transfer the channel reported as failed may still have
// been paid: no query, or the latest unknown → reject_query_required; the latest success →
// reject_query_success; only the latest fail lets the rejection through. With the switch off the check
// does not run. Every refusal writes nothing (status, balance, vouchers, audit). The guard is in the
// domain command, not only in the route: one case calls withdrawalCommands.reject directly.
// Requests go through the real admin entry (review-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  createWithdrawalCommands,
  type RejectWithdrawalCommand,
  type WithdrawalCommandsOptions,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-commands.ts';
import type { PayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { createPayoutAttemptsStore } from '../../../../apps/api/src/modules/payout/infra/payout-attempts-store.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  AFTER_FREEZE,
  AMOUNT,
  BALANCE,
  NOTE,
  PAYER_SIDE,
  SWITCH,
  ago,
  balanceOf,
  conflict,
  everything,
  fixture,
  member,
  refused,
  rejectBody,
  rejectedBy,
  returnVouchers,
  rowOf,
  seedApproved,
  seedAttempt,
  seedQueries,
  seedReturned,
  seedReview,
  setSwitch,
  suite,
  withReviewAdmin,
  type AttemptResult,
  type ReviewAdmin,
  type WithdrawalRow,
  type ReviewFixture,
} from './review-harness.ts';

const s = suite();

/** A payer-side withdrawal with these queries, refused for `reason`, nothing written. */
async function queryRefusal(
  f: ReviewFixture,
  h: ReviewAdmin,
  queries: readonly (readonly [AttemptResult, number])[],
  reason: 'reject_query_required' | 'reject_query_success',
): Promise<void> {
  const who = await member(f, h);
  const w = await seedReturned(f, h, who);
  await seedQueries(f, w, queries);
  const before = await everything(f);

  await refused(await h.reject(w.id, rejectBody()), reason);

  expect(await everything(f)).toEqual(before);
  expect(await rowOf(f, w)).toEqual(w);
  expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
    available_fen: AFTER_FREEZE,
    frozen_fen: AMOUNT,
  });
  expect(await returnVouchers(f)).toEqual([]);
}

/** A payer-side withdrawal with these queries is rejected and its money returned. */
async function queryPass(
  f: ReviewFixture,
  h: ReviewAdmin,
  queries: readonly (readonly [AttemptResult, number])[],
): Promise<WithdrawalRow> {
  const who = await member(f, h);
  const w = await seedReturned(f, h, who);
  await seedQueries(f, w, queries);

  await rejectedBy(f, await h.reject(w.id, rejectBody()), w, h.reviewer.id, 'PAYEE_INFO_INVALID');

  expect(await rowOf(f, w)).toMatchObject({
    status: 'REJECTED',
    reject_reason_code: 'PAYEE_INFO_INVALID',
    reject_note: NOTE,
    reviewer_id: h.reviewer.id,
  });
  expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
    available_fen: BALANCE,
    frozen_fen: 0n,
  });
  return w;
}

it('[AC-B2-09k#25] 有 result 为 pending、success、unknown 的转账尝试（APPROVED，没有付款方侧 hold）→ 20001 reject_attempt_exists，只能走 BR-WDR-15；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    for (const result of ['pending', 'success', 'unknown'] as const) {
      const who = await member(f, h);
      const w = await seedApproved(f, h, who);
      await seedAttempt(f, w, { kind: 'transfer', result, at: ago(f, 10) });
      const before = await everything(f);
      await refused(await h.reject(w.id, rejectBody()), 'reject_attempt_exists');
      expect(await everything(f), result).toEqual(before);
    }
  });
});

it('[AC-B2-09k#26] 判断顺序：不在 PENDING_REVIEW / APPROVED 的单（PAYING 且有 pending 转账）先回 20902，不是 reject_attempt_exists；有 unknown 转账且 hold 为付款方侧的先回 reject_attempt_exists，不是查询守卫', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const paying = await seedReview(f, h, who, { status: 'PAYING', execute_seq: 1 });
    await seedAttempt(f, paying, { kind: 'transfer', result: 'pending', at: ago(f, 10) });
    const held = await seedApproved(f, h, who, { hold_reason: PAYER_SIDE });
    await seedAttempt(f, held, { kind: 'transfer', result: 'unknown', at: ago(f, 10) });
    const before = await everything(f);

    await conflict(await h.reject(paying.id, rejectBody()));
    await refused(await h.reject(held.id, rejectBody()), 'reject_attempt_exists');

    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09k#27] 只有 fail 转账尝试且 hold 不是付款方侧的单可以驳回，不用先查询：没有 hold 的、hold 为 member_blocked 的都退回 12,345', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    for (const hold of [null, 'member_blocked'] as const) {
      const who = await member(f, h);
      const w = await seedApproved(f, h, who, { hold_reason: hold });
      await seedAttempt(f, w, { kind: 'transfer', result: 'fail', at: ago(f, 10) });

      await rejectedBy(
        f,
        await h.reject(w.id, rejectBody()),
        w,
        h.reviewer.id,
        'PAYEE_INFO_INVALID',
      );

      expect(await rowOf(f, w), String(hold)).toMatchObject({ status: 'REJECTED' });
      expect(await balanceOf(f.db, f.ledger, f.appId, who.userId), String(hold)).toEqual({
        available_fen: BALANCE,
        frozen_fen: 0n,
      });
    }
  });
});

it('[AC-B2-09k#28] 先查询守卫（防重复打款）：付款方侧 hold + 一条 fail 转账尝试、没有查询记录 → reject_query_required（fail 的转账尝试不算查询）；开关没有行时默认 on；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await queryRefusal(f, h, [], 'reject_query_required');
  });
});

it('[AC-B2-09k#29] 开关显式为 true 时同样拦：没有查询记录 → reject_query_required；什么都不写', async () => {
  const f = fixture(s);
  await setSwitch(f, SWITCH, true);
  await withReviewAdmin(f, async (h) => {
    await queryRefusal(f, h, [], 'reject_query_required');
  });
});

it('[AC-B2-09k#30] 最近查询 result=unknown（含「订单不存在」，它目前按 unknown 记）→ reject_query_required；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await queryRefusal(f, h, [['unknown', 5]], 'reject_query_required');
  });
});

it('[AC-B2-09k#31] 最近查询 result=pending 也不放行：只有 fail 放行（BR-WDR-17：结果必须是明确失败）→ reject_query_required', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await queryRefusal(f, h, [['pending', 5]], 'reject_query_required');
  });
});

it('[AC-B2-09k#32] 最近查询 result=success → reject_query_success（钱已出去，只能走 W11，驳回会重复打款）；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await queryRefusal(f, h, [['success', 5]], 'reject_query_success');
  });
});

it('[AC-B2-09k#33] 最近查询 result=fail → 可以驳回，12,345 退回，一张 RETURN', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const w = await queryPass(f, h, [['fail', 5]]);
    expect(await returnVouchers(f)).toEqual([`wd:${w.id}:RETURN`]);
  });
});

it('[AC-B2-09k#34] 取「最近一次」（按 at，与写入顺序无关）：先 fail 后 success → reject_query_success；先 fail 后 unknown → reject_query_required', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await queryRefusal(
      f,
      h,
      [
        ['fail', 40],
        ['success', 10],
      ],
      'reject_query_success',
    );
    await queryRefusal(
      f,
      h,
      [
        ['success', 10],
        ['fail', 40],
      ],
      'reject_query_success',
    );
    await queryRefusal(
      f,
      h,
      [
        ['unknown', 10],
        ['fail', 40],
      ],
      'reject_query_required',
    );
  });
});

it('[AC-B2-09k#35] 取「最近一次」（按 at，与写入顺序无关）：先 success 后 fail、先 unknown 后 fail 都按最近的 fail 放行', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    await queryPass(f, h, [
      ['success', 40],
      ['fail', 10],
    ]);
    await queryPass(f, h, [
      ['fail', 10],
      ['success', 40],
    ]);
    await queryPass(f, h, [
      ['unknown', 40],
      ['fail', 10],
    ]);
  });
});

it('[AC-B2-09k#36] 开关 off 时不跑这道检查：付款方侧 hold 没有查询、最近查询 unknown、最近查询 success 都可以驳回（转账尝试守卫仍在）', async () => {
  const f = fixture(s);
  await setSwitch(f, SWITCH, false);
  await withReviewAdmin(f, async (h) => {
    await queryPass(f, h, []);
    await queryPass(f, h, [['unknown', 5]]);
    await queryPass(f, h, [['success', 5]]);

    const who = await member(f, h);
    const w = await seedApproved(f, h, who, { hold_reason: PAYER_SIDE });
    await seedAttempt(f, w, { kind: 'transfer', result: 'unknown', at: ago(f, 10) });
    await refused(await h.reject(w.id, rejectBody()), 'reject_attempt_exists');
  });
});

it('[AC-B2-09k#37] 守卫在领域命令里：直接调 withdrawalCommands.reject，付款方侧 hold 没查询 / unknown → refused query_required，success → refused query_success，什么都不写；最近一次 fail 才改 REJECTED；不传开关端口或开关没有行按默认 on 拦，开关 false 不拦；systemRejectNegative 不变', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const options: WithdrawalCommandsOptions = {
      clock: f.clock,
      ledger: f.ledger,
      lockUsersForUpdate,
      attempts: createPayoutAttemptsStore(),
      eventBus: createEventBus({
        clock: f.clock,
        subscriptions: [],
        queue: {
          send: async () => {
            throw new Error('unexpected queue subscription');
          },
        },
      }),
    };
    const noRow: PayoutConfigPort = { configValue: async () => null };
    const off: PayoutConfigPort = { configValue: async () => ({ value: false, version: 2 }) };
    const reviewerId = h.reviewer.id;
    const rejectAs = (row: WithdrawalRow, config?: PayoutConfigPort) => {
      const built = config === undefined ? options : { ...options, config };
      const commands = createWithdrawalCommands(built);
      const input: RejectWithdrawalCommand = {
        appId: row.app_id,
        withdrawalId: row.id,
        expectedStatus: 'APPROVED',
        expectedRowVersion: row.row_version,
        reviewerId,
        reasonCode: 'OTHER',
        note: NOTE,
      };
      return f.db.transaction().execute((trx) => commands.reject(trx, input));
    };

    const who = await member(f, h);
    const w = await seedReturned(f, h, who);
    const before = await everything(f);
    const required = { kind: 'refused', reason: 'query_required' };
    expect(await rejectAs(w)).toEqual(required);
    expect(await rejectAs(w, noRow)).toEqual(required);
    expect(await everything(f)).toEqual(before);

    await seedQueries(f, w, [['unknown', 12]]);
    const unknown = await everything(f);
    expect(await rejectAs(w, noRow)).toEqual(required);
    expect(await everything(f)).toEqual(unknown);

    await seedQueries(f, w, [['success', 9]]);
    const success = await everything(f);
    expect(await rejectAs(w, noRow)).toEqual({ kind: 'refused', reason: 'query_success' });
    expect(await everything(f)).toEqual(success);

    await seedQueries(f, w, [['fail', 6]]);
    expect(await rejectAs(w, noRow)).toEqual({ kind: 'changed', status: 'REJECTED' });
    expect(await rowOf(f, w)).toMatchObject({ status: 'REJECTED', reviewer_id: reviewerId });

    const switchedOff = await seedReturned(f, h, await member(f, h));
    expect(await rejectAs(switchedOff, off)).toEqual({ kind: 'changed', status: 'REJECTED' });

    const commands = createWithdrawalCommands(options);
    const held = await seedReturned(f, h, await member(f, h));
    const pending = await seedReview(f, h, await member(f, h));
    const system = (row: WithdrawalRow, expectedStatus: 'APPROVED' | 'PENDING_REVIEW') =>
      f.db.transaction().execute((trx) =>
        commands.systemRejectNegative(trx, {
          appId: row.app_id,
          withdrawalId: row.id,
          expectedStatus,
          expectedRowVersion: row.row_version,
          reviewerId: null,
        }),
      );
    expect(await system(held, 'APPROVED')).toEqual({ kind: 'refused', reason: 'attempt_exists' });
    expect(await system(pending, 'PENDING_REVIEW')).toEqual({
      kind: 'changed',
      status: 'REJECTED',
    });
    expect(await rowOf(f, pending)).toMatchObject({
      reject_reason_code: 'NEGATIVE_BALANCE',
      reject_note: 'system:went_negative',
      reviewer_id: null,
    });
  });
});
