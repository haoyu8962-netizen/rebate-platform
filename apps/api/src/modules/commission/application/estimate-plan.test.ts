import { expect, it } from 'vitest';
import type { ReadSnapshotBeneficiary } from '../domain/snapshot-read.ts';
import { frozenBase, planVersion, storedN, type FrozenTerms } from './estimate-plan.ts';

const person = (
  role: ReadSnapshotBeneficiary['role'],
  ratioBp: number,
): ReadSnapshotBeneficiary => ({
  userId: `user-${role}`,
  role,
  ratioBp,
  level: 'L1',
  initialStatus: 'active',
  forfeitReason: null,
});

const terms: FrozenTerms = {
  orderType: 'self',
  reserveBp: 1500,
  tljDeductFen: 0n,
  subsidyCommissionFen: 0n,
  beneficiaries: [person('indirect', 500), person('self', 5000), person('direct', 1000)],
};

it('[AC-B2-03q] frozenBase：负 N 为 0，不受没收影响', () => {
  expect(frozenBase(terms, 2000n)).toBe(1700n);
  expect(frozenBase(terms, -1n)).toBe(0n);
});

it('[AC-B2-03q] planVersion：行序按本人、直推、间推，没收份额 0 且不计入利润扣减', () => {
  const plan = planVersion(terms, 2000n, 50n, (b) => b.role === 'direct');
  expect(plan.amounts.map((a) => [a.role, a.base_fen, a.amount_fen])).toEqual([
    ['self', 1700n, 850n],
    ['direct', 1700n, 0n],
    ['indirect', 1700n, 85n],
  ]);
  expect(plan.totals).toEqual({
    n_total_fen: 2000n,
    pre_base_deduct_fen: 300n,
    base_fen: 1700n,
    user_share_total_fen: 935n,
    tlj_redpacket_fen: 50n,
    platform_est_profit_fen: 1015n,
  });
});

it('[AC-B2-03s#U4] planVersion：负 N 把 B 夹到 0，份额 0，四段金额保留负的 N', () => {
  const plan = planVersion(terms, -100n, 0n, () => false);
  expect(plan.amounts.map((a) => [a.role, a.base_fen, a.amount_fen])).toEqual([
    ['self', 0n, 0n],
    ['direct', 0n, 0n],
    ['indirect', 0n, 0n],
  ]);
  expect(plan.totals).toEqual({
    n_total_fen: -100n,
    pre_base_deduct_fen: -100n,
    base_fen: 0n,
    user_share_total_fen: 0n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: -100n,
  });
});

it('[AC-B2-03q] planVersion：面额 null 时利润也是 null', () => {
  expect(planVersion(terms, 2000n, null, () => false).totals).toMatchObject({
    tlj_redpacket_fen: null,
    platform_est_profit_fen: null,
  });
});

it('[AC-B2-03q] 快照缺本人或角色重复：抛错，不猜', () => {
  expect(() => frozenBase({ ...terms, beneficiaries: [person('direct', 1000)] }, 1n)).toThrow(
    'no owner',
  );
  expect(() =>
    frozenBase({ ...terms, beneficiaries: [person('self', 1000), person('share', 1000)] }, 1n),
  ).toThrow('repeats role');
});

it('[AC-B2-03r-UNIT#4] storedN：去掉冻结补贴，还原版本的 N，可为负', () => {
  expect(storedN({ ...terms, subsidyCommissionFen: 111n }, 1111n)).toBe(1000n);
  expect(storedN({ ...terms, subsidyCommissionFen: 0n }, 1000n)).toBe(1000n);
  expect(storedN({ ...terms, subsidyCommissionFen: 111n }, 100n)).toBe(-11n);
});
