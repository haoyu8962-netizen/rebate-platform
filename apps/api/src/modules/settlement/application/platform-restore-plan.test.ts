// B2-09gb 源码旁单元测试：平台恢复的纯计算（BR-FUND-22 R12 / R13、BR-CALC-02、BR-CALC-09；D10-986 ②、D10-994）。
import { expect, it } from 'vitest';
import {
  effectiveCommissionPositive,
  parsePlatformRestoreRef,
  planR13,
  r12TargetOf,
  type R13Beneficiary,
} from './platform-restore-plan.ts';

const NORMAL = { risk_state: 'normal', deletion_status: null, is_minor: false } as const;

function person(
  role: R13Beneficiary['role'],
  ratioBp: number,
  patch: Partial<R13Beneficiary> = {},
): R13Beneficiary {
  return {
    userId: `u-${role}`,
    role,
    ratioBp,
    forfeited: false,
    state: NORMAL,
    netFen: 0n,
    ...patch,
  };
}

const THREE = [person('self', 5000), person('direct', 1000), person('indirect', 500)];

it('[AC-B2-09gb#U1] ref_id 只认 `{platform}:{sub_order_id}#RESTORE#{正整数}` 且 ref_type 为 order', () => {
  expect(parsePlatformRestoreRef('order', 'taobao:123#RESTORE#45')).toEqual({
    platform: 'taobao',
    subOrderId: '123',
    orderKey: 'taobao:123',
    entryId: 45n,
  });
  for (const bad of [
    'taobao:123',
    'taobao:123#RESTORE#',
    'taobao:123#RESTORE#abc',
    'taobao:123#REFUND#45',
    '#RESTORE#45',
    'taobao#RESTORE#45',
    'taobao:#RESTORE#45',
    'a:b:c#RESTORE#45',
    'taobao:123#RESTORE#0',
    'taobao:123#RESTORE#9223372036854775808',
  ]) {
    expect(parsePlatformRestoreRef('order', bad), bad).toBeNull();
  }
  expect(parsePlatformRestoreRef('withdrawal', 'taobao:123#RESTORE#45')).toBeNull();
});

it('[AC-B2-09gb#U2] R12 目标：未归因回 UNATTRIBUTED；RECEIVED / SETTLED 有收货时间回 WAITING，否则 ESTIMATED', () => {
  const at = new Date('2026-10-01T00:00:00.000Z');
  expect(r12TargetOf({ user_id: null, platform_status: 'SETTLED', received_at: at })).toBe(
    'UNATTRIBUTED',
  );
  expect(r12TargetOf({ user_id: 'u', platform_status: 'PAID', received_at: at })).toBe('ESTIMATED');
  expect(r12TargetOf({ user_id: 'u', platform_status: 'DEPOSIT_PAID', received_at: null })).toBe(
    'ESTIMATED',
  );
  expect(r12TargetOf({ user_id: 'u', platform_status: 'RECEIVED', received_at: at })).toBe(
    'WAITING',
  );
  expect(r12TargetOf({ user_id: 'u', platform_status: 'RECEIVED', received_at: null })).toBe(
    'ESTIMATED',
  );
});

it('[AC-B2-09gb#U3] 有效联盟佣金：结算佣金非空只取它，否则取预估；取正数部分', () => {
  expect(effectiveCommissionPositive(2000n, 5555n)).toBe(2000n);
  expect(effectiveCommissionPositive(0n, 5000n)).toBe(0n);
  expect(effectiveCommissionPositive(-50n, 5555n)).toBe(0n);
  expect(effectiveCommissionPositive(null, 1500n)).toBe(1500n);
  expect(effectiveCommissionPositive(null, null)).toBe(0n);
});

it('[AC-B2-09gb#U4] R13 全额扣回后重算：N 2000、预留 1500 → B 1700，850 / 170 / 85，平台 895', () => {
  const plan = planR13({ nFen: 2000n, reserveBp: 1500, beneficiaries: THREE, platformNetFen: 0n });
  expect(plan.baseFen).toBe(1700n);
  expect(plan.rows.map((r) => [r.outcome, r.amountFen])).toEqual([
    ['credited', 850n],
    ['credited', 170n],
    ['credited', 85n],
  ]);
  expect(plan.platformPostFen).toBe(895n);
  expect(plan.restoredFen).toBe(1105n);
});

it('[AC-B2-09gb#U5] R13 受益人分流：冻结 / 申诉延后，封禁 / 注销 / 未成年推广与已剥夺份额归平台', () => {
  const plan = planR13({
    nFen: 2000n,
    reserveBp: 1500,
    platformNetFen: 0n,
    beneficiaries: [
      person('self', 5000, { state: { ...NORMAL, is_minor: true } }),
      person('direct', 1000, { state: { ...NORMAL, risk_state: 'frozen' } }),
      person('indirect', 500, { state: { ...NORMAL, deletion_status: 'processing' } }),
      person('share', 1000, { forfeited: true }),
    ],
  });
  expect(plan.rows.map((r) => [r.role, r.outcome, r.amountFen, r.forfeitReason])).toEqual([
    ['self', 'credited', 850n, null],
    ['direct', 'deferred', 170n, null],
    ['indirect', 'platform', 0n, 'deleted'],
    ['share', 'platform', 0n, null],
  ]);
  // 2000 − 850 − 170（延后仍归受益人）。
  expect(plan.platformPostFen).toBe(980n);
  expect(plan.restoredFen).toBe(850n);
});

it('[AC-B2-09gb#U6] R13 差额 0 与负差不写：受益人负差与平台负差只记下（D10-986 ②、D10-994）', () => {
  const plan = planR13({
    nFen: 2000n,
    reserveBp: 1500,
    platformNetFen: 1000n,
    beneficiaries: [
      person('self', 5000, { netFen: 850n }),
      person('direct', 1000, { netFen: 200n }),
      person('indirect', 500),
    ],
  });
  expect(plan.rows.map((r) => [r.outcome, r.amountFen, r.differenceFen])).toEqual([
    ['none', 0n, 0n],
    ['none', 0n, -30n],
    ['credited', 85n, 85n],
  ]);
  expect(plan.platformEntitlementFen).toBe(895n);
  expect(plan.platformDifferenceFen).toBe(-105n);
  expect(plan.platformPostFen).toBe(0n);
  expect(plan.restoredFen).toBe(85n);
});

it('[AC-B2-09gb#U7] R13 有效佣金必须为正', () => {
  expect(() =>
    planR13({ nFen: 0n, reserveBp: 1500, beneficiaries: THREE, platformNetFen: 0n }),
  ).toThrow(RangeError);
});
