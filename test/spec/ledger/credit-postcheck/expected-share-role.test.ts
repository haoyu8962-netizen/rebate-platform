// B2-02t rule test: the anti-false-freeze property of D10-1038 ② (a) on share orders (no database). The
// recomputation must equal planInitialCredit to the fen for role share too. Runs and seed come from
// propParams() only.
import { planInitialCredit, type CreditBeneficiaryState } from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { expectedShareFen } from '../../../../apps/api/src/modules/ledger/index.ts';

const state: fc.Arbitrary<CreditBeneficiaryState> = fc.record({
  risk_state: fc.constantFrom('normal', 'frozen', 'appealing', 'banned'),
  deletion_status: fc.constantFrom(null, 'cooling', 'processing', 'done', 'cancelled'),
  is_minor: fc.boolean(),
});

const base = fc.oneof(
  fc.constantFrom(0n, 1n, 2147483649n, 9007199254740993n),
  fc.bigInt({ min: 0n, max: 1000000n }).map((value) => value | 1n),
  fc.bigInt({ min: 0n, max: 4000000000000000000n }),
);

/** Three ratios whose sum is at most 10000, each possibly 0. */
const ratios = fc.integer({ min: 0, max: 10000 }).chain((share) =>
  fc.integer({ min: 0, max: 10000 - share }).chain((direct) =>
    fc.integer({ min: 0, max: 10000 - share - direct }).map((indirect) => ({
      share: BigInt(share),
      direct: BigInt(direct),
      indirect: BigInt(indirect),
    })),
  ),
);

it('[AC-B2-02t#34] 属性（防误冻，分享单）：任意 B、合法比例与受益人状态，share 及其上级的重算份额严格等于 planInitialCredit', () => {
  const stats = createPropStats('ledger:credit-postcheck:expected-equals-plan-share');
  try {
    fc.assert(
      fc.property(
        base,
        ratios,
        fc.tuple(state, state, state),
        fc.tuple(fc.boolean(), fc.boolean()),
        (b, r, states, forfeited) => {
          const beneficiaries = [
            // The sharer stays active, so that every run reaches the recomputation for role share.
            { user_id: 'u-share', role: 'share' as const, ratio_bp: r.share, snapshot: false },
            {
              user_id: 'u-direct',
              role: 'direct' as const,
              ratio_bp: r.direct,
              snapshot: forfeited[0],
            },
            {
              user_id: 'u-indirect',
              role: 'indirect' as const,
              ratio_bp: r.indirect,
              snapshot: forfeited[1],
            },
          ];
          const plan = planInitialCredit({
            platform: 'taobao',
            sub_order_id: 'prop-sub-order',
            b_credit_fen: b,
            reserve_fen: 0n,
            beneficiaries: beneficiaries.map((p, i) => ({
              user_id: p.user_id,
              role: p.role,
              ratio_bp: p.ratio_bp,
              snapshot_status: p.snapshot ? ('forfeited' as const) : ('active' as const),
              current: states[i]!,
            })),
          });
          if (b === 0n) stats.hit('base_zero');
          if (b % 2n === 1n) stats.hit('base_odd');
          if (b > 2147483648n) stats.hit('base_above_2_31');
          plan.beneficiaries.forEach((decision, i) => {
            const person = beneficiaries[i]!;
            stats.hit(`${person.role}_${decision.action}`);
            if (person.snapshot) {
              // A share forfeited in the snapshot has no voucher, so it is never checked.
              expect(decision.share_fen).toBe(0n);
              return;
            }
            if (person.ratio_bp === 0n) stats.hit('ratio_zero');
            expect(
              expectedShareFen({ base_fen: b, ratio_bp: person.ratio_bp, net_before_fen: 0n }),
            ).toBe(decision.share_fen);
          });
          return true;
        },
      ),
      propParams(),
    );
  } finally {
    stats.flush();
  }
}, 900_000);
