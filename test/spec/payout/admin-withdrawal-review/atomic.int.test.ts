// B2-09k atomicity rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminRejectWithdrawal (status, voucher, event and audit in one transaction under the member's
// balance lock) and adminBatchApproveWithdrawals (each id in its own transaction: an unexpected failure
// of one id ends the request with 5xx; ids already approved stay approved, and the same key runs the
// rest again: those come back not_pending). The failure is a one-shot fault in the entry's database
// handle (review-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AFTER_FREEZE,
  AMOUNT,
  APPROVE_ACTION,
  BALANCE,
  REJECT_ACTION,
  answer,
  approvedItem,
  audits,
  balanceOf,
  changes,
  everything,
  fixture,
  itemsOf,
  member,
  newKey,
  rejectBody,
  rejectedBy,
  returnVouchers,
  rowOf,
  seedReview,
  skippedItem,
  suite,
  withReviewAdmin,
  type FaultPoint,
} from './review-harness.ts';

const s = suite();

async function rejectFault(point: FaultPoint): Promise<void> {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    const key = newKey();

    h.fault.point = point;
    const sent = await h.reject(w.id, rejectBody(), { key });

    expect(h.fault.tripped, `${point} 必须在驳回事务里执行`).toBe(1);
    await answer(sent, 50001);
    expect(await everything(f)).toEqual(before);
    expect(await rowOf(f, w)).toEqual(w);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });

    await rejectedBy(
      f,
      await h.reject(w.id, rejectBody(), { key }),
      w,
      h.reviewer.id,
      'PAYEE_INFO_INVALID',
    );
    expect(await returnVouchers(f)).toEqual([`wd:${w.id}:RETURN`]);
    expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
  });
}

it('[AC-B2-09k#50] 驳回时写审计失败 → 50001，状态、余额、凭证、事件都不变；同一 key 重发即成功且只有一张凭证一条审计', async () => {
  await rejectFault('reject_audit');
});

it('[AC-B2-09k#51] 驳回时写凭证失败 → 50001，状态、余额、凭证、事件都不变；同一 key 重发即成功且只有一张凭证一条审计', async () => {
  await rejectFault('voucher');
});

it('[AC-B2-09k#52] 批量里某一单中途失败（第二单写审计失败）→ 50001：第一单留在 APPROVED 且有审计和事件，第二单回滚（状态、事件都没有），第三单还没跑；同一 key 重试其余：第一单 not_pending，后两单通过，每单恰一条审计', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const first = await seedReview(f, h, who);
    const second = await seedReview(f, h, who);
    const third = await seedReview(f, h, who);
    const ids = [first.id, second.id, third.id];
    const key = newKey();

    h.fault.point = 'approve_audit';
    h.fault.contains = second.id;
    const sent = await h.approve(ids, { key });

    expect(h.fault.tripped, '第二单的审计必须在它自己的事务里写').toBe(1);
    await answer(sent, 50001);
    expect(await rowOf(f, first)).toMatchObject({ status: 'APPROVED', reviewer_id: h.reviewer.id });
    expect(await rowOf(f, second)).toEqual(second);
    expect(await rowOf(f, third)).toEqual(third);
    expect((await audits(f, APPROVE_ACTION)).map((record) => record.target)).toEqual([first.id]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: first.id, user_id: who.userId, status: 'APPROVED' },
    ]);

    expect(await itemsOf(await h.approve(ids, { key }))).toEqual([
      skippedItem(first.id, 'not_pending'),
      approvedItem(second.id),
      approvedItem(third.id),
    ]);
    expect(await rowOf(f, second)).toMatchObject({
      status: 'APPROVED',
      reviewer_id: h.reviewer.id,
    });
    expect(await rowOf(f, third)).toMatchObject({ status: 'APPROVED', reviewer_id: h.reviewer.id });
    expect((await audits(f, APPROVE_ACTION)).map((record) => record.target).sort()).toEqual(
      [...ids].sort(),
    );
    expect(await changes(f.db, f.appId)).toHaveLength(3);
  });
});
