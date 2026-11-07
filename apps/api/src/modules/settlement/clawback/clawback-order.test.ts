// B2-04zza 源码旁单元测试（不连库）：入账后维权等待中、新结算记录回应时，哪些结算计划仍留着等待。
// 依据 BR-FUND-08 细则（D10-474 ②）与编排 D10-781：负差一路（含义务没收 / 新开延后 / 保持重算）一律按
// R10 写并关闭维权记录，只有正差一路留着等待（FU-SETTLE-ADJ-POSITIVE）。
import {
  planCommissionAdjustment,
  type AdjustmentBeneficiary,
  type AdjustmentInput,
} from '@couli/domain';
import { expect, it } from 'vitest';
import { answeredRightsWaits } from './clawback-order.ts';

function seat(
  role: AdjustmentBeneficiary['role'],
  over: Partial<AdjustmentBeneficiary> = {},
): AdjustmentBeneficiary {
  return {
    user_id: `u-${role}`,
    role,
    ratio_bp: role === 'self' ? 5000n : 1000n,
    status: 'active',
    risk_state: 'normal',
    deletion_status: null,
    is_minor: false,
    net_fen: 0n,
    obligation: null,
    ...over,
  };
}

// booked 1000 / 1000，无预留：self 500、share 100、direct 100，平台 300。平台净额按 BR-FUND-19 ⑤ 的等式
// 取 booked − 受益人净额 − 未完成义务的待补记额（份额减净额），让夹具自洽。
function input(nNew: bigint, beneficiaries: readonly AdjustmentBeneficiary[]): AdjustmentInput {
  const held = beneficiaries.reduce((sum, b) => {
    const pending = b.obligation === null ? 0n : (1000n * b.ratio_bp) / 10000n - b.net_fen;
    return sum + b.net_fen + (pending > 0n ? pending : 0n);
  }, 0n);
  return {
    event: 'settlement',
    n_new_fen: nNew,
    reserve_bp: 0n,
    booked_base_fen: 1000n,
    booked_n_fen: 1000n,
    platform_net_fen: 1000n - held,
    beneficiaries,
  };
}

it('[AC-B2-04zza#U1] 负差 + 封禁受益人的首次入账义务要没收：不再等待，计划是 R10', () => {
  const plan = planCommissionAdjustment(
    input(800n, [
      seat('self', {
        status: 'held',
        risk_state: 'banned',
        obligation: { beneficiary_credit_id: 'bc-1', kind: 'first_credit' },
      }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ]),
  );
  expect(plan.route).toBe('immediate');
  expect(plan.transition).toBe('R10');
  expect(plan.beneficiaries.find((b) => b.role === 'self')?.obligation_action).toBe('forfeited');
  expect(answeredRightsWaits(plan)).toBe(false);
});

it('[AC-B2-04zza#U2] 负差 + 冻结受益人新开延后义务（open）：不再等待，计划是 R10', () => {
  const plan = planCommissionAdjustment(
    input(800n, [
      seat('self', { risk_state: 'frozen', net_fen: 0n }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ]),
  );
  expect(plan.route).toBe('immediate');
  expect(plan.transition).toBe('R10');
  expect(plan.beneficiaries.find((b) => b.role === 'self')?.obligation_action).toBe('open');
  expect(answeredRightsWaits(plan)).toBe(false);
});

it('[AC-B2-04zza#U3] 负差 + 已有义务仍冻结（keep，待补记额随 booked 重算）：不再等待', () => {
  const plan = planCommissionAdjustment(
    input(800n, [
      seat('self', {
        status: 'held',
        risk_state: 'frozen',
        obligation: { beneficiary_credit_id: 'bc-1', kind: 'first_credit' },
      }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ]),
  );
  const self = plan.beneficiaries.find((b) => b.role === 'self');
  expect(plan.transition).toBe('R10');
  expect(self?.obligation_action).toBe('keep');
  expect(self?.pending_after_fen).not.toBe(self?.pending_before_fen);
  expect(answeredRightsWaits(plan)).toBe(false);
});

it('[AC-B2-04zza#U4] 正差仍留着等待（approval 路）；无动作与纯负差不等待', () => {
  const seats = [
    seat('self', { net_fen: 500n }),
    seat('share', { net_fen: 100n }),
    seat('direct', { net_fen: 100n }),
  ];
  const up = planCommissionAdjustment(input(1200n, seats));
  expect(up.route).toBe('approval');
  expect(answeredRightsWaits(up)).toBe(true);
  const same = planCommissionAdjustment(input(1000n, seats));
  expect(same.transition).toBeNull();
  expect(answeredRightsWaits(same)).toBe(false);
  const down = planCommissionAdjustment(input(600n, seats));
  expect(down.transition).toBe('R10');
  expect(answeredRightsWaits(down)).toBe(false);
});

it('[AC-B2-04zza#U5] 结算事件的计划只有 null / R8 / R10，负差一路不出现 R9 与受益人正差', () => {
  const mixes: AdjustmentBeneficiary[][] = [
    [
      seat('self', { net_fen: 500n }),
      seat('share', {
        status: 'held',
        risk_state: 'banned',
        obligation: { beneficiary_credit_id: 'bc-2', kind: 'first_credit' },
      }),
      seat('direct', { risk_state: 'appealing', net_fen: 0n }),
    ],
    [
      seat('self', { deletion_status: 'done', net_fen: 500n }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ],
  ];
  for (const beneficiaries of mixes) {
    for (const nNew of [0n, 1n, 300n, 800n, 999n, 1000n, 1001n, 1500n]) {
      const plan = planCommissionAdjustment(input(nNew, beneficiaries));
      expect(plan.transition).not.toBe('R9');
      if (plan.route === 'immediate' && plan.transition === 'R10') {
        expect(plan.beneficiaries.every((b) => b.delta_fen <= 0n)).toBe(true);
      }
    }
  }
});
