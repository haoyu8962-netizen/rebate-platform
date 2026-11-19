// B2-02x skeleton (rule-test phase, claude-independent; SPEC_REF ba6655b1): the pure decision of
// recalcBalanceAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc,
// CT-24zzn + CT-24zzna; 08 BR-FUND-19 细则「差异以分录为准修正」, BR-FUND-16 细则「加锁流程」,
// BR-FUND-12 negative_since, BR-WDR-05 (a) 跨零, D10-2032, D10-2041).
//
// planBalanceRecalc(input) → BalanceRecalcPlan, given the member's account_balances row as read
// under the lock (`cache`), the member-sign sums of the account's ledger entries per sub-account
// (`sums`: available = 0 − Σ entries of sub-account available, frozen = 0 − Σ entries of
// sub-account frozen; exact integers, possibly outside the PostgreSQL bigint range) and the
// Clock's +08:00 accounting day (`accountingDay`, YYYY-MM-DD):
//   - refused: the frozen sum is below 0 (`frozen_negative`), or either sum is outside
//     −2^63 … 2^63 − 1 (`out_of_range`); nothing is written.
//   - unchanged: both sums equal the cache; the row is not written (version and negative_since
//     stay).
//   - write: available_fen / frozen_fen are the sums, version is the cache's + 1 (the
//     compare-and-set of every posting), negative_since follows the posting path (new available
//     < 0: the cache's negative_since when the old available was < 0 and had one, else the
//     accounting day; new available ≥ 0: null); wentNegative when available goes from ≥ 0 to
//     < 0, recovered when it goes from < 0 to ≥ 0 (the same check as the posting path).
// Implementation is not part of this phase: every function only throws NotImplemented.

/** The member's account_balances row as read under the lock. */
export interface BalanceRecalcCache {
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  /** +08:00 accounting date, YYYY-MM-DD, or null. */
  readonly negative_since: string | null;
  readonly version: bigint;
}

/** The member-sign sums of the account's ledger entries, per sub-account (exact integers). */
export interface BalanceRecalcSums {
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
}

export interface BalanceRecalcPlanInput {
  readonly cache: BalanceRecalcCache;
  readonly sums: BalanceRecalcSums;
  /** The Clock's +08:00 accounting day, YYYY-MM-DD. */
  readonly accountingDay: string;
}

/** Why sums that cannot be a balance are refused (D10-2032 ②). */
export type BalanceRecalcRefusal = 'frozen_negative' | 'out_of_range';

export type BalanceRecalcPlan =
  | { readonly kind: 'refused'; readonly cause: BalanceRecalcRefusal }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'write';
      readonly available_fen: bigint;
      readonly frozen_fen: bigint;
      readonly negative_since: string | null;
      readonly version: bigint;
      readonly wentNegative: boolean;
      readonly recovered: boolean;
    };

/** What the recalculation does with the cache read under the lock and the entry sums. */
export function planBalanceRecalc(input: BalanceRecalcPlanInput): BalanceRecalcPlan {
  void input;
  throw new Error('NotImplemented: planBalanceRecalc');
}

export interface BalanceRecalcSourceInput {
  /** The recon_diffs row whose recalculation wrote the balance row. */
  readonly reconDiffId: string;
  /** The balance row's version after the recalculation wrote it (the plan's `version`). */
  readonly version: bigint;
}

/**
 * D10-2084: the source of a recalculation (the recovery hook's `voucherId` when available goes from
 * < 0 to ≥ 0, and any voucher a recalculation would carry): `recalc:<recon_diff_id>:<version>`, the
 * version in decimal; two recalculations of one difference that write two versions have two sources.
 */
export function balanceRecalcSourceRef(input: BalanceRecalcSourceInput): string {
  void input;
  throw new Error('NotImplemented: balanceRecalcSourceRef');
}
