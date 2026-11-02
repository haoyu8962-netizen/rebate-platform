import { expect, it } from 'vitest';
import { planCommissionSnapshot } from './commission-snapshot.ts';
import {
  STAFF_REJECT_REASONS,
  claimSnapshotInput,
  decideClaimReview,
  isStaffRejectReason,
  normalizeReviewReason,
  type ClaimSnapshotOrder,
} from './claim-review.ts';

const U = '0190a600-0000-7000-8000-0000000000aa';
const V = '0190a600-0000-7000-8000-0000000000bb';
const NOW = new Date('2028-01-02T03:04:05.000Z');

function order(patch: Partial<ClaimSnapshotOrder> = {}): ClaimSnapshotOrder {
  return {
    app_id: 'app-1',
    order_id: '0190a600-0000-7000-8000-0000000000cc',
    platform: 'jd',
    platform_status: 'PAID',
    rebate_status: 'UNATTRIBUTED',
    buy_type: 'self',
    activity_type: null,
    is_presale: false,
    paid_at: new Date('2027-12-12T03:00:00.000Z'),
    deposit_paid_at: null,
    est_commission_fen: 1200n,
    settle_commission_fen: null,
    subsidy_commission_fen: 0n,
    ...patch,
  };
}

it('[AC-B1-10k#28] 说明去首尾空白后按码点计 5～200 字，存去空白后的值', () => {
  expect(normalizeReviewReason('  证据核实一致 \n')).toBe('证据核实一致');
  expect(normalizeReviewReason('字'.repeat(5))).toBe('字'.repeat(5));
  expect(normalizeReviewReason('字'.repeat(200))).toBe('字'.repeat(200));
  expect(normalizeReviewReason('字'.repeat(201))).toBeNull();
  expect(normalizeReviewReason('  四个汉字  ')).toBeNull();
  expect(normalizeReviewReason('😀😀😀😀')).toBeNull();
  expect(normalizeReviewReason(undefined)).toBeNull();
});

it('[AC-B1-10k#29] 客服驳回码只有六个，系统码与变形一律不收', () => {
  for (const code of STAFF_REJECT_REASONS) expect(isStaffRejectReason(code)).toBe(true);
  for (const code of ['NOT_IN_POOL', 'ORDER_INVALID', 'fraud', ' OTHER', '', null, 3]) {
    expect(isStaffRejectReason(code)).toBe(false);
  }
});

it('[AC-B1-10k#30] 通过：已归属先于 VOID；同申请人 CANCEL，他人 NOT_IN_POOL，均为系统结案', () => {
  expect(decideClaimReview('approve', { user_id: U, rebate_status: 'VOID' }, U, null)).toEqual({
    event: 'CANCEL',
    rejectReason: null,
    byReviewer: false,
    attribute: false,
  });
  expect(decideClaimReview('approve', { user_id: V, rebate_status: 'ESTIMATED' }, U, null)).toEqual(
    { event: 'REJECT', rejectReason: 'NOT_IN_POOL', byReviewer: false, attribute: false },
  );
  expect(decideClaimReview('approve', { user_id: null, rebate_status: 'VOID' }, U, null)).toEqual({
    event: 'REJECT',
    rejectReason: 'ORDER_INVALID',
    byReviewer: false,
    attribute: false,
  });
  expect(
    decideClaimReview('approve', { user_id: null, rebate_status: 'UNATTRIBUTED' }, U, null),
  ).toEqual({ event: 'APPROVE', rejectReason: null, byReviewer: true, attribute: true });
});

it('[AC-B1-10k#31] 驳回：VOID 换成 ORDER_INVALID 系统处理，否则按客服原因（已归属也不改）', () => {
  expect(decideClaimReview('reject', { user_id: null, rebate_status: 'VOID' }, U, 'FRAUD')).toEqual(
    { event: 'REJECT', rejectReason: 'ORDER_INVALID', byReviewer: false, attribute: false },
  );
  expect(
    decideClaimReview('reject', { user_id: V, rebate_status: 'ESTIMATED' }, U, 'OTHER'),
  ).toEqual({ event: 'REJECT', rejectReason: 'OTHER', byReviewer: true, attribute: false });
  expect(() =>
    decideClaimReview('reject', { user_id: null, rebate_status: 'UNATTRIBUTED' }, U, null),
  ).toThrow(RangeError);
});

it('[AC-B1-10k#32] 找回通过的快照计划：PAID 调端口，归属人为申请人，基数取预估', () => {
  const plan = planCommissionSnapshot(claimSnapshotInput(order(), U, null, null, NOW));
  expect(plan).toMatchObject({
    kind: 'call',
    input: { ownerUserId: U, nBaseFen: 1200n, paidAtSource: 'platform', rebateMode: null },
  });
});

it('[AC-B1-10k#33] DEPOSIT_PAID 通过不生成快照（skip）', () => {
  const plan = planCommissionSnapshot(
    claimSnapshotInput(order({ platform_status: 'DEPOSIT_PAID' }), U, null, null, NOW),
  );
  expect(plan).toEqual({ kind: 'skip' });
});

it('[AC-B1-10k#34] 拼多多 est 为空（报文没给服务费）：不调端口，落待处理 SERVICE_FEE_RATE_MISSING；est 已是净额时照常建', () => {
  const plan = planCommissionSnapshot(
    claimSnapshotInput(order({ platform: 'pdd', est_commission_fen: null }), U, null, null, NOW),
  );
  expect(plan).toEqual({ kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' });
  const known = planCommissionSnapshot(
    claimSnapshotInput(order({ platform: 'pdd' }), U, null, null, NOW),
  );
  expect(known.kind).toBe('call');
});

it('[AC-B1-10k#35] 淘礼金推广位按 rebate_mode=none、红包面额空；无付款时间取首条已付历史', () => {
  const first = new Date('2027-12-20T00:00:00.000Z');
  const plan = planCommissionSnapshot(
    claimSnapshotInput(order({ paid_at: null }), U, 'taolijin', first, NOW),
  );
  expect(plan).toMatchObject({
    kind: 'call',
    input: { rebateMode: 'none', tljRedpacketFen: null, paidAt: first, paidAtSource: 'observed' },
  });
});
