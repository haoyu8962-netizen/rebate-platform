// B1-18i 源码旁单元测试：仅补贴变化的版本的合计行（BR-CALC-27「仅补贴变化的版本」，纯函数，不连库）。
// 合计行：① = 上一版本存的 N + 新补贴（空记 0），② = ① − B，④ = ① − Σ用户份额 − 淘礼金红包；B、Σ份额、红包沿用。
import { expect, it } from 'vitest';
import { subsidyOnlyTotals } from './estimates.ts';

const latest = {
  base_fen: 600n,
  user_share_total_fen: 360n,
  tlj_redpacket_fen: 0n,
};

it('[AC-B1-18i#U6] 份额与 B 沿用上一版本（R7 后 N 600），只按新补贴 350 重算 ① ② ④，补贴列记 350', () => {
  expect(subsidyOnlyTotals(latest, 600n, 350n)).toEqual({
    n_total_fen: 950n,
    pre_base_deduct_fen: 350n,
    base_fen: 600n,
    user_share_total_fen: 360n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: 590n,
    subsidy_commission_fen: 350n,
  });
});

it('[AC-B1-18i#U7] 新补贴为空记 0；红包参与 ④；红包未知时 ④ 未知', () => {
  expect(
    subsidyOnlyTotals({ ...latest, base_fen: 1000n, user_share_total_fen: 500n }, 1000n, null),
  ).toMatchObject({
    n_total_fen: 1000n,
    pre_base_deduct_fen: 0n,
    platform_est_profit_fen: 500n,
    subsidy_commission_fen: 0n,
  });
  expect(subsidyOnlyTotals({ ...latest, tlj_redpacket_fen: 40n }, 600n, 100n)).toMatchObject({
    n_total_fen: 700n,
    platform_est_profit_fen: 300n,
  });
  expect(subsidyOnlyTotals({ ...latest, tlj_redpacket_fen: null }, 600n, 100n)).toMatchObject({
    tlj_redpacket_fen: null,
    platform_est_profit_fen: null,
  });
});
