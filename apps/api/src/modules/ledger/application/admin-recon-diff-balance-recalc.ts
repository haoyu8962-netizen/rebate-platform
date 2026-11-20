// B2-02x: the pure decision of recalcBalanceAdminReconDiff
// (POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc, CT-24zzn + CT-24zzna; 08 BR-FUND-19
// 细则「差异以分录为准修正」, BR-FUND-16 细则「加锁流程」, BR-FUND-12 negative_since, BR-WDR-05 (a) 跨零,
// D10-2032, D10-2041, D10-2064 ③, D10-2084).
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
//     compare-and-set of every posting), negative_since and wentNegative / recovered through the
//     posting path's own functions (./balance-transitions.ts, B2-02y).
// decideBalanceRecalc(input) is what the operation applies: planBalanceRecalc plus the contract's
// range of an amount in a response, ±(2^53 − 1) (D10-2064 ③): a sum outside it is refused as
// `sum_out_of_range` (a sum outside bigint included), a cached value outside it as
// `cache_out_of_range`. recalcBalanceAuditRecord builds the audit record's target, before and
// after; balanceRecalcSourceRef the source `recalc:<recon_diff_id>:<version>` (D10-2084). The
// transaction itself is in ./admin-recon-diff-balance-recalc-use-case.ts. Pure module: no I/O.
import { goesNegative, nextNegativeSince, recovers } from './balance-transitions.ts';

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

/** The cache is written with these values (the compare-and-set of every posting). */
export interface BalanceRecalcWrite {
  readonly kind: 'write';
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  readonly negative_since: string | null;
  readonly version: bigint;
  readonly wentNegative: boolean;
  readonly recovered: boolean;
}

export type BalanceRecalcPlan =
  | { readonly kind: 'refused'; readonly cause: BalanceRecalcRefusal }
  | { readonly kind: 'unchanged' }
  | BalanceRecalcWrite;

/** The signed PostgreSQL bigint range, the range account_balances can store (D10-2032 ②). */
const BIGINT_MIN = -9_223_372_036_854_775_808n;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

function inBigintRange(value: bigint): boolean {
  return value >= BIGINT_MIN && value <= BIGINT_MAX;
}

/** What the recalculation does with the cache read under the lock and the entry sums. */
export function planBalanceRecalc(input: BalanceRecalcPlanInput): BalanceRecalcPlan {
  const { cache, sums, accountingDay } = input;
  // A negative frozen sum first: below −2^63 it is negative as well (the cause is not pinned).
  if (sums.frozen_fen < 0n) return { kind: 'refused', cause: 'frozen_negative' };
  if (!inBigintRange(sums.available_fen) || !inBigintRange(sums.frozen_fen)) {
    return { kind: 'refused', cause: 'out_of_range' };
  }
  if (sums.available_fen === cache.available_fen && sums.frozen_fen === cache.frozen_fen) {
    return { kind: 'unchanged' };
  }
  return {
    kind: 'write',
    available_fen: sums.available_fen,
    frozen_fen: sums.frozen_fen,
    // BR-FUND-12 exactly as the posting path (B2-02y).
    negative_since: nextNegativeSince({
      availableBefore: cache.available_fen,
      availableAfter: sums.available_fen,
      negativeSinceBefore: cache.negative_since,
      day: accountingDay,
    }),
    // The compare-and-set of every posting: the row read under the lock, version + 1.
    version: cache.version + 1n,
    // BR-WDR-05 (a), the posting path's checks (B2-02y): available only.
    wentNegative: goesNegative(cache.available_fen, sums.available_fen),
    recovered: recovers(cache.available_fen, sums.available_fen),
  };
}

/** Why the operation refuses (the audit record's `refused`). */
export type BalanceRecalcRefusalCause =
  'frozen_negative' | 'sum_out_of_range' | 'cache_out_of_range';

export type BalanceRecalcDecision =
  | { readonly kind: 'refused'; readonly cause: BalanceRecalcRefusalCause }
  | { readonly kind: 'unchanged' }
  | BalanceRecalcWrite;

/** The range of an amount in a response: −(2^53 − 1) … 2^53 − 1 (BR-CALC-01, D10-2064 ③). */
const JSON_FEN_MAX = 9_007_199_254_740_991n;

function inJsonRange(value: bigint): boolean {
  return value >= -JSON_FEN_MAX && value <= JSON_FEN_MAX;
}

/**
 * What recalcBalanceAdminReconDiff applies (contract「Refused」): a negative frozen sum is
 * `frozen_negative`; otherwise a sum outside ±(2^53 − 1) (one outside bigint included) is
 * `sum_out_of_range`; otherwise a cached available_fen or frozen_fen outside ±(2^53 − 1) is
 * `cache_out_of_range`; otherwise planBalanceRecalc's unchanged or write. The bounds themselves
 * are accepted.
 */
export function decideBalanceRecalc(input: BalanceRecalcPlanInput): BalanceRecalcDecision {
  const plan = planBalanceRecalc(input);
  if (plan.kind === 'refused') {
    return {
      kind: 'refused',
      cause: plan.cause === 'frozen_negative' ? 'frozen_negative' : 'sum_out_of_range',
    };
  }
  const { cache, sums } = input;
  if (!inJsonRange(sums.available_fen) || !inJsonRange(sums.frozen_fen)) {
    return { kind: 'refused', cause: 'sum_out_of_range' };
  }
  if (!inJsonRange(cache.available_fen) || !inJsonRange(cache.frozen_fen)) {
    return { kind: 'refused', cause: 'cache_out_of_range' };
  }
  return plan;
}

/** A JSON object of the audit record: strings, booleans and nested objects only. */
export interface BalanceRecalcAuditJson {
  readonly [key: string]: string | boolean | BalanceRecalcAuditJson;
}

/** What the audit record of one call says (amounts as exact decimal strings). */
export interface BalanceRecalcAuditRecord {
  readonly target: string;
  readonly before: BalanceRecalcAuditJson;
  readonly after: BalanceRecalcAuditJson;
}

export interface BalanceRecalcAuditInput {
  readonly reconDiffId: string;
  readonly userId: string;
  /** The trimmed reason. */
  readonly reason: string;
  /** The cache as read under the lock. */
  readonly cache: BalanceRecalcCache;
  /** The member-sign entry sums as computed. */
  readonly sums: BalanceRecalcSums;
  readonly decision: BalanceRecalcDecision;
}

/**
 * The recon_diff_balance_recalc record (contract recalcBalanceAdminReconDiff): target the
 * difference; `before` the cache read under the lock; `after` the difference, the member, the
 * reason, `changed` and the cache as it stands after the call. Each side writes its own
 * available_fen from available and frozen_fen from frozen (never crossed). A refusal also records
 * its cause and the sums as computed (exact, possibly outside bigint) under `entry_sums`; its
 * `after` values are the untouched cache. Amounts are decimal strings, as the other ledger audit
 * records write them (a JSON number cannot hold every bigint). No personal data.
 */
export function recalcBalanceAuditRecord(input: BalanceRecalcAuditInput): BalanceRecalcAuditRecord {
  const { cache, sums, decision } = input;
  const before = {
    available_fen: cache.available_fen.toString(),
    frozen_fen: cache.frozen_fen.toString(),
  };
  const common = {
    recon_diff_id: input.reconDiffId,
    user_id: input.userId,
    reason: input.reason,
  };
  if (decision.kind === 'refused') {
    return {
      target: input.reconDiffId,
      before,
      after: {
        ...common,
        changed: false,
        refused: decision.cause,
        available_fen: cache.available_fen.toString(),
        frozen_fen: cache.frozen_fen.toString(),
        entry_sums: {
          available_fen: sums.available_fen.toString(),
          frozen_fen: sums.frozen_fen.toString(),
        },
      },
    };
  }
  const written = decision.kind === 'write';
  return {
    target: input.reconDiffId,
    before,
    after: {
      ...common,
      changed: written,
      available_fen: (written ? decision.available_fen : cache.available_fen).toString(),
      frozen_fen: (written ? decision.frozen_fen : cache.frozen_fen).toString(),
    },
  };
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
  return `recalc:${input.reconDiffId}:${input.version.toString()}`;
}
