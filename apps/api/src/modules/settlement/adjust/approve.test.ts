// B2-09zc (money r4 S1): where an approval keeps a forfeit reason. The plans come from the domain
// planner (event 'settlement', the positive route), so the cases are the planner's own amounts.
import { planCommissionAdjustment, type AdjustmentBeneficiary } from '@couli/domain';
import { describe, expect, it } from 'vitest';
import { forfeitCarrier, forfeitsOf } from './approve.ts';

function member(
  role: AdjustmentBeneficiary['role'],
  ratioBp: bigint,
  netFen: bigint,
  risk: AdjustmentBeneficiary['risk_state'],
): AdjustmentBeneficiary {
  return {
    user_id: `${role}-user`,
    role,
    ratio_bp: ratioBp,
    status: 'active',
    risk_state: risk,
    deletion_status: null,
    is_minor: false,
    net_fen: netFen,
    obligation: null,
  };
}

function plan(nNew: bigint, booked: bigint, platformNet: bigint, people: AdjustmentBeneficiary[]) {
  return planCommissionAdjustment({
    event: 'settlement',
    n_new_fen: nNew,
    reserve_bp: 0n,
    booked_base_fen: booked,
    booked_n_fen: booked,
    platform_net_fen: platformNet,
    beneficiaries: people,
  });
}

describe('forfeitCarrier', () => {
  it('1009 → 1010, self banned, direct frozen: the forfeited 1 has no voucher → its own audit', () => {
    const p = plan(1010n, 1009n, 405n, [
      member('self', 5000n, 504n, 'banned'),
      member('direct', 1000n, 100n, 'frozen'),
    ]);
    expect(p.route).toBe('approval');
    expect(p.platform_delta_fen).toBe(0n);
    expect(p.beneficiaries.every((b) => b.delta_fen === 0n)).toBe(true);
    expect(forfeitsOf(p)).toEqual([{ role: 'self', amount_fen: '1', reason: 'banned' }]);
    expect(forfeitCarrier(p)).toBe('audit');
  });

  it('1234 → 1300, self banned: the platform voucher carries the reason', () => {
    const p = plan(1300n, 1234n, 494n, [
      member('self', 5000n, 617n, 'banned'),
      member('direct', 1000n, 123n, 'normal'),
    ]);
    expect(p.platform_delta_fen).toBe(59n);
    expect(forfeitsOf(p)).toEqual([{ role: 'self', amount_fen: '33', reason: 'banned' }]);
    expect(forfeitCarrier(p)).toBe('platform_voucher');
  });

  it('no forfeited share: nothing to keep', () => {
    const p = plan(1300n, 1234n, 494n, [
      member('self', 5000n, 617n, 'normal'),
      member('direct', 1000n, 123n, 'normal'),
    ]);
    expect(forfeitsOf(p)).toEqual([]);
    expect(forfeitCarrier(p)).toBe('none');
  });
});
