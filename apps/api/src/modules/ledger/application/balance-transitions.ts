/**
 * B2-02y (D10-2064 ②): the posting path's balance transitions as exported pure functions —
 * BR-FUND-12 negative_since and the BR-WDR-05 (a) zero crossings (account.went_negative /
 * recovery hook). Amounts are available_fen before and after one voucher's net change.
 */

/** Input of nextNegativeSince: available before / after, the stored negative_since, today's 会计日. */
export interface NegativeSinceInput {
  readonly availableBefore: bigint;
  readonly availableAfter: bigint;
  readonly negativeSinceBefore: string | null;
  readonly day: string;
}

/** BR-FUND-12: the negative_since to store after the change. */
export function nextNegativeSince(input: NegativeSinceInput): string | null {
  void input;
  throw new Error('NotImplemented: nextNegativeSince');
}

/** BR-WDR-05 (a): true when available goes from < 0 to >= 0. */
export function recovers(availableBefore: bigint, availableAfter: bigint): boolean {
  void availableBefore;
  void availableAfter;
  throw new Error('NotImplemented: recovers');
}

/** BR-WDR-05 (a): true when available goes from >= 0 to < 0. */
export function goesNegative(availableBefore: bigint, availableAfter: bigint): boolean {
  void availableBefore;
  void availableAfter;
  throw new Error('NotImplemented: goesNegative');
}
