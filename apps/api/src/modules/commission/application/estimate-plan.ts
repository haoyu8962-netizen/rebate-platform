// B2-03q (D10-565): the amounts of a later commission_version, from the snapshot's frozen terms and
// a new N. Pure: no I/O, no clock. Same splitCommission as the snapshot (BR-CALC-02/04/13) and the
// same four amounts (BR-CALC-27); a share is only ever 0 by forfeiture, held counts.
import { splitCommission, type CommissionBeneficiary } from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import type { ReadSnapshotBeneficiary } from '../domain/snapshot-read.ts';

/** What the snapshot froze; beneficiaries in any order, exactly who took part at snapshot time. */
export interface FrozenTerms {
  readonly orderType: 'self' | 'share';
  readonly reserveBp: number;
  readonly tljDeductFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly beneficiaries: readonly ReadSnapshotBeneficiary[];
}

export interface PlannedAmount {
  readonly user_id: string;
  readonly role: ReadSnapshotBeneficiary['role'];
  readonly base_fen: bigint;
  readonly amount_fen: bigint;
}

export interface PlannedTotals {
  readonly n_total_fen: bigint;
  readonly pre_base_deduct_fen: bigint;
  readonly base_fen: bigint;
  readonly user_share_total_fen: bigint;
  readonly tlj_redpacket_fen: bigint | null;
  readonly platform_est_profit_fen: bigint | null;
}

export interface VersionPlan {
  readonly amounts: readonly PlannedAmount[];
  readonly totals: PlannedTotals;
}

/** The union commission net of the service fee (BR-CALC-03); a missing fee is unknown, never 0. */
export function netCommission(
  commissionFen: bigint | null,
  feeDeducted: boolean,
  serviceFeeFen: bigint | null,
): bigint | null {
  if (commissionFen === null) return null;
  if (!feeDeducted) return commissionFen;
  return serviceFeeFen === null ? null : subFen(commissionFen, serviceFeeFen);
}

function split(
  terms: FrozenTerms,
  nFen: bigint,
  isForfeited: (b: ReadSnapshotBeneficiary) => boolean,
) {
  const person = (b: ReadSnapshotBeneficiary): CommissionBeneficiary => ({
    user_id: b.userId,
    ratio_bp: BigInt(b.ratioBp),
    status: isForfeited(b) ? 'forfeited' : 'active',
  });
  const one = (roles: readonly string[]) => {
    const found = terms.beneficiaries.filter((b) => roles.includes(b.role));
    if (found.length > 1) throw new Error(`commission: snapshot repeats role ${roles.join('/')}`);
    return found[0] ?? null;
  };
  const owner = one(['self', 'share']);
  if (owner === null) throw new Error('commission: snapshot has no owner beneficiary');
  const direct = one(['direct']);
  const indirect = one(['indirect']);
  return splitCommission({
    n_base_fen: nFen,
    reserve_bp: BigInt(terms.reserveBp),
    tlj_deduct_fen: terms.tljDeductFen,
    order_type: terms.orderType,
    // The frozen list decides who takes part: an indirect row exists only if it was enabled then.
    indirect_enabled: indirect !== null,
    owner: person(owner),
    direct: direct === null ? null : person(direct),
    indirect: indirect === null ? null : person(indirect),
  });
}

/** B of N under the frozen terms (BR-CALC-02): subsidy stays out of N, a negative N counts as 0. */
export function frozenBase(terms: FrozenTerms, nFen: bigint): bigint {
  return split(terms, nFen, () => false).base_fen;
}

export function planVersion(
  terms: FrozenTerms,
  nFen: bigint,
  redpacketFen: bigint | null,
  isForfeited: (b: ReadSnapshotBeneficiary) => boolean,
): VersionPlan {
  const { base_fen, shares } = split(terms, nFen, isForfeited);
  let userTotal = 0n;
  for (const share of shares) userTotal = addFen(userTotal, share.amount_fen);
  const nTotal = addFen(nFen, terms.subsidyCommissionFen);
  return {
    amounts: shares.map((share) => ({
      user_id: share.user_id,
      role: share.role,
      base_fen,
      amount_fen: share.amount_fen,
    })),
    totals: {
      n_total_fen: nTotal,
      pre_base_deduct_fen: subFen(nTotal, base_fen),
      base_fen,
      user_share_total_fen: userTotal,
      tlj_redpacket_fen: redpacketFen,
      platform_est_profit_fen:
        redpacketFen === null ? null : subFen(subFen(nTotal, userTotal), redpacketFen),
    },
  };
}
