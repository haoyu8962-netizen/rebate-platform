// B2-04zi (BR-FUND-01「R9 与 R9b 的判定」, BR-FUND-09 整单分路): where a new settlement amount stands
// against the booked pair of a CREDITED order, before any lock is taken. The amounts themselves stay
// with @couli/domain planCommissionAdjustment; this only names the direction the sync hook routes on.
import { applyReserve } from '@couli/money';

/**
 * - `zero`: the commission's positive part is 0, or the booked base was above 0 and the new base is
 *   0 → R8 (BR-FUND-08), whatever the reason;
 * - `same`: base and positive part both equal the booked pair → no action (BR-FUND-09 ③);
 * - `down`: the base is lower, or equal with a lower positive part → the negative route (immediate);
 * - `up`: anything else → the positive route (a candidate to approve, never written by the sync).
 */
export type SettleDirection = 'zero' | 'same' | 'down' | 'up';

export interface BookedPair {
  readonly base: bigint;
  readonly n: bigint;
}

export function settleDirection(
  settleFen: bigint,
  booked: BookedPair,
  reserveBp: bigint,
): SettleDirection {
  const nPositive = settleFen > 0n ? settleFen : 0n;
  // BR-CALC-02: the base of the new amount with the snapshot's reserve_bp.
  const { after_reserve_fen: base } = applyReserve(settleFen, reserveBp);
  if (nPositive === 0n || (booked.base > 0n && base === 0n)) return 'zero';
  if (base === booked.base) {
    if (nPositive === booked.n) return 'same';
    return nPositive < booked.n ? 'down' : 'up';
  }
  return base < booked.base ? 'down' : 'up';
}
