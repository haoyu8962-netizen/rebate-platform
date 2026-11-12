// B1-10v (D10-1401): the dashboard card claim_review_pending (order.claim; BR-ATTR-18) — per app,
// the claims waiting for review (auto_matched + manual_review) with the two sub-counts. Read only;
// to reuse the counts(filter) read of the console claim list (infra/admin-claim-reads.ts) so the
// card always equals the list page's own counts. Skeleton: the implementation task fills it in.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The card's figure: count = auto_matched + manual_review. */
export interface ClaimReviewCount {
  readonly count: number;
  readonly breakdown: {
    readonly auto_matched: number;
    readonly manual_review: number;
  };
}

export function countClaimsPendingReview(db: Kysely<DB>, appId: string): Promise<ClaimReviewCount> {
  void db;
  void appId;
  throw new Error('NotImplemented: countClaimsPendingReview');
}
