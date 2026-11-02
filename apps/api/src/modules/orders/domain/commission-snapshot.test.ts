// B1-08k 源码旁单元测试：第 ⑥ 步快照判定的纯函数（资格跨入、paid_at 降级、N 取值与服务费、淘礼金、来源列）。
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  chooseSnapshotPaidAt,
  crossesSnapshotEligibility,
  planCommissionSnapshot,
  snapshotPaidAtSource,
  type PlanCommissionSnapshotInput,
} from './commission-snapshot.ts';

const at = (iso: string) => new FixedClock(iso).now();
const DEPOSIT = at('2026-10-04T01:00:00.000Z');
const PAID = at('2026-10-12T02:00:00.000Z');
const MODIFIED = at('2026-10-13T03:00:00.000Z');
const FIRST_PAID = at('2026-10-14T04:00:00.000Z');
const NOW = at('2026-10-19T05:00:00.000Z');

function input(patch: Partial<PlanCommissionSnapshotInput> = {}): PlanCommissionSnapshotInput {
  return {
    before: null,
    after: { user_id: 'unit-owner', platform_status: 'PAID', rebate_status_before: 'UNATTRIBUTED' },
    order: {
      app_id: 'unit-app',
      order_id: 'unit-order',
      platform: 'pdd',
      buy_type: 'self',
      activity_type: null,
      is_presale: false,
      paid_at: PAID,
      deposit_paid_at: null,
      est_commission_fen: 500n,
      settle_commission_fen: null,
      subsidy_commission_fen: null,
    },
    incoming: { modified_at: MODIFIED, service_fee_fen: 20n },
    pidScene: 'self_buy',
    movedToPaidNow: true,
    firstPaidAt: NOW,
    now: NOW,
    ...patch,
  };
}

const presale = (paid_at: Date | null) => ({
  ...input().order,
  is_presale: true,
  deposit_paid_at: DEPOSIT,
  paid_at,
});

it('[AC-B1-08k#U1] 资格只在本次跨入时成立：已满足、未归因、定金、失效、作废与扣回都不跨入', () => {
  const after = input().after;
  expect(crossesSnapshotEligibility(null, after)).toBe(true);
  expect(
    crossesSnapshotEligibility(
      { user_id: null, platform_status: 'SETTLED', rebate_status: 'UNATTRIBUTED' },
      { ...after, platform_status: 'SETTLED' },
    ),
  ).toBe(true);
  expect(
    crossesSnapshotEligibility(
      { user_id: 'unit-owner', platform_status: 'DEPOSIT_PAID', rebate_status: 'ESTIMATED' },
      after,
    ),
  ).toBe(true);
  expect(
    crossesSnapshotEligibility(
      { user_id: 'unit-owner', platform_status: 'PAID', rebate_status: 'ESTIMATED' },
      { ...after, platform_status: 'RECEIVED' },
    ),
  ).toBe(false);
  expect(crossesSnapshotEligibility(null, { ...after, user_id: null })).toBe(false);
  expect(crossesSnapshotEligibility(null, { ...after, platform_status: 'DEPOSIT_PAID' })).toBe(
    false,
  );
  expect(crossesSnapshotEligibility(null, { ...after, platform_status: 'INVALID' })).toBe(false);
  for (const rebate of ['VOID', 'CLAWED_BACK']) {
    expect(
      crossesSnapshotEligibility(
        { user_id: null, platform_status: 'PAID', rebate_status: rebate },
        { ...after, rebate_status_before: rebate },
      ),
    ).toBe(false);
  }
});

it('[AC-B1-08k#U2] paid_at 三档：平台尾款时间 → 迁到 PAID 那次的修改时间 → 首条已付观测时刻', () => {
  expect(chooseSnapshotPaidAt(input())).toEqual({ paidAt: PAID, paidAtSource: 'platform' });
  expect(chooseSnapshotPaidAt(input({ order: presale(PAID) }))).toEqual({
    paidAt: PAID,
    paidAtSource: 'platform',
  });
  expect(chooseSnapshotPaidAt(input({ order: presale(at(DEPOSIT.toISOString())) }))).toEqual({
    paidAt: MODIFIED,
    paidAtSource: 'platform_modified',
  });
  expect(
    chooseSnapshotPaidAt(
      input({
        order: presale(null),
        incoming: { modified_at: null, service_fee_fen: 20n },
        firstPaidAt: FIRST_PAID,
      }),
    ),
  ).toEqual({ paidAt: FIRST_PAID, paidAtSource: 'observed' });
  // 晚归属（本次不是迁到 PAID 的那次）不得用本次报文的修改时间；没有任何已付历史时退到本次 now。
  expect(
    chooseSnapshotPaidAt(
      input({ order: presale(DEPOSIT), movedToPaidNow: false, firstPaidAt: null }),
    ),
  ).toEqual({ paidAt: NOW, paidAtSource: 'observed' });
});

it('[AC-B1-08k#U3] N 取写库后结算收入优先；拼多多 est 已是净额不再减，其他平台同样不减', () => {
  expect(planCommissionSnapshot(input())).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 500n },
  });
  const settled = { ...input().order, settle_commission_fen: 10n };
  expect(planCommissionSnapshot(input({ order: settled }))).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 10n },
  });
  expect(
    planCommissionSnapshot(
      input({
        order: { ...input().order, platform: 'jd' },
        incoming: { modified_at: null, service_fee_fen: null },
      }),
    ),
  ).toMatchObject({ kind: 'call', input: { nBaseFen: 500n } });
});

it('[AC-B1-08k#U4] 金额缺失与服务费缺失进 pending，不按 0；N 已知时本次缺服务费不影响', () => {
  const noAmount = { ...input().order, est_commission_fen: null };
  expect(planCommissionSnapshot(input({ order: noAmount }))).toEqual({
    kind: 'pending',
    reason: 'AMOUNT_PARSE_FAILED',
  });
  expect(
    planCommissionSnapshot(
      input({ order: noAmount, incoming: { modified_at: MODIFIED, service_fee_fen: null } }),
    ),
  ).toEqual({ kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' });
  // N 已知时本次缺服务费不影响（est 已是净额）。
  expect(
    planCommissionSnapshot(input({ incoming: { modified_at: MODIFIED, service_fee_fen: null } })),
  ).toMatchObject({ kind: 'call', input: { nBaseFen: 500n } });
});

it('[AC-B1-08k#U5] 入参逐字段：淘礼金 none + 红包空，非淘礼金红包 0；补贴、活动、归属照传', () => {
  const order = { ...input().order, activity_type: 'unit-activity', subsidy_commission_fen: 7n };
  expect(planCommissionSnapshot(input({ order }))).toEqual({
    kind: 'call',
    input: {
      appId: 'unit-app',
      orderId: 'unit-order',
      platform: 'pdd',
      paidAt: PAID,
      paidAtSource: 'platform',
      orderType: 'self',
      activityType: 'unit-activity',
      rebateMode: null,
      nBaseFen: 500n,
      subsidyCommissionFen: 7n,
      tljDeductFen: 0n,
      tljRedpacketFen: 0n,
      ownerUserId: 'unit-owner',
    },
  });
  expect(planCommissionSnapshot(input({ pidScene: 'taolijin' }))).toMatchObject({
    kind: 'call',
    input: { rebateMode: 'none', tljRedpacketFen: null, tljDeductFen: 0n },
  });
  expect(planCommissionSnapshot(input({ pidScene: null }))).toMatchObject({
    kind: 'call',
    input: { rebateMode: null, tljRedpacketFen: 0n },
  });
});

it('[AC-B1-08k#U6] orders.paid_at_source：跨入资格时 call 与 pending 都给来源，skip 不给', () => {
  const call = input();
  expect(snapshotPaidAtSource(call, planCommissionSnapshot(call))).toBe('platform');
  const pending = input({
    order: { ...presale(null), est_commission_fen: null },
    incoming: { modified_at: MODIFIED, service_fee_fen: 20n },
  });
  expect(snapshotPaidAtSource(pending, planCommissionSnapshot(pending))).toBe('platform_modified');
  const skip = input({ after: { ...call.after, user_id: null } });
  expect(snapshotPaidAtSource(skip, planCommissionSnapshot(skip))).toBeNull();
});
