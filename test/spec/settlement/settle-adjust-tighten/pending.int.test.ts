// B2-09zf rule test (claude-independent, D10-828 ①; refs 08 BR-FUND-09 ②, BR-FUND-08, BR-CALC-09):
// the base grew (B_settle > booked_base_fen), so the shares are split again on B_settle and a
// beneficiary's difference is the new share less the net already credited (BR-FUND-09: diff = 按
// B_settle 与快照重拆的应得份额 − 已入账净额，口径同 BR-FUND-08). The approval credits that whole
// difference and closes the beneficiary's open obligation, so the amount still owed to him under it
// (待补记额) is part of the difference — it is never taken off it again.
// Seeded on the real path: the order is credited by the real credit service while `self` is frozen,
// so his share is held (net 0, an open first_credit obligation); the freeze is lifted afterwards (the
// supplement has not run yet, the obligation is still open), then a new settlement record raises N.
// Expected amounts by hand from BR-CALC-02 / BR-CALC-04 / BR-CALC-09, never from the planner.
import { addFen, subFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
} from '../settle-adjust-generate/harness.ts';

const p = databaseFixture(createDatabase);

it(
  '[AC-B2-09zf#1] 基数变大且受益人带待补额：预留 0、自购 5000 / 直推 1000，入账 1234 时自购冻结（净额 0、未完成义务待补 617，直推 123、平台 494），解冻后结算上调到 1300 → 候选 self +650（新份额 650 − 净额 0，不再扣 617）、direct +7、平台 +26；凭证、余额、义务都不变',
  async () => {
    const h = await adjustHarness(p.db);
    // B_credit = floor(1234 × 10000 / 10000) = 1234: self floor(1234 × 5000 / 10000) = 617 (held,
    // frozen), direct floor(1234 × 1000 / 10000) = 123, platform 1234 − 617 − 123 = 494.
    const o = await h.credited({
      settleFen: 1234n,
      reserveBp: 0,
      people: [
        { role: 'self', ratioBp: 5000, state: 'frozen' },
        { role: 'direct', ratioBp: 1000 },
      ],
    });

    // The seeded state: self has no CREDIT (net 0) and one open obligation; the amount still owed
    // to him under it is booked_n − platform net − Σ nets (BR-FUND-19 ⑤) = 1234 − 494 − 123 − 0.
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 1234n,
      booked_n_fen: 1234n,
    });
    expect(await h.netOf(o, 'self')).toBe(0n);
    expect(await h.netOf(o, 'direct')).toBe(123n);
    const nets = await h.nets(o);
    expect(nets.platform_net_fen).toBe(494n);
    const credited = nets.beneficiaries.reduce((sum, b) => addFen(sum, b.net_fen), 0n);
    expect(subFen(subFen(1234n, nets.platform_net_fen), credited)).toBe(617n);
    expect(await h.balance(o.user('self'))).toBe(0n);
    const obligations = await h.orderObligations(o);
    expect(obligations).toEqual([
      expect.objectContaining({
        user_id: o.user('self'),
        role: 'self',
        kind: 'first_credit',
        status: 'open',
      }),
    ]);

    // The freeze is lifted; the obligation stays open until it is settled.
    await h.setRisk(p.db, o.user('self'), 'normal');
    const seq = await h.settle(o, 1300n);
    const before = await h.state();

    const result = await h.run();

    // B_settle = 1300 > 1234: self 650 − 0 = +650 (the 617 still owed is part of it), direct
    // 130 − 123 = +7; platform: 1300 − (650 + 130) = 520, 520 − 494 = +26.
    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 650n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
    expect(result).toMatchObject({ orders: 1, candidates: 3, superseded: 0 });
    expect(await h.batches()).toHaveLength(1);
    // Candidates only: no voucher, no balance, the obligation still open, the booked pair as before.
    expect(await h.state()).toEqual(before);
    expect(await h.orderObligations(o)).toEqual(obligations);
    expect(await h.balance(o.user('self'))).toBe(0n);
  },
  TIMEOUT,
);
