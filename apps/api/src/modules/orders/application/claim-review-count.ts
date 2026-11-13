// B1-10v (D10-1401): the dashboard card claim_review_pending (order.claim; BR-ATTR-18) — per app,
// the claims waiting for review (auto_matched + manual_review) with the two sub-counts. Read only;
// it reuses the counts(filter) read of the console claim list (infra/admin-claim-reads.ts) and the
// list's own claimCounts, unfiltered, so the card always equals the list page's own counts.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { claimCounts } from '../domain/admin-claim-view.ts';
import { createAdminClaimReads, type AdminClaimReads } from '../infra/admin-claim-reads.ts';

/** The card's figure: count = auto_matched + manual_review. */
export interface ClaimReviewCount {
  readonly count: number;
  readonly breakdown: {
    readonly auto_matched: number;
    readonly manual_review: number;
  };
}

/** The card over a given claim read: the list's counts with no filter but the app. */
export async function countClaimsPendingReviewWith(
  reads: Pick<AdminClaimReads, 'counts'>,
  appId: string,
): Promise<ClaimReviewCount> {
  const counts = claimCounts(await reads.counts({ appId }));
  return {
    count: counts.auto_matched + counts.manual_review,
    breakdown: { auto_matched: counts.auto_matched, manual_review: counts.manual_review },
  };
}

export function countClaimsPendingReview(db: Kysely<DB>, appId: string): Promise<ClaimReviewCount> {
  return countClaimsPendingReviewWith(createAdminClaimReads(db), appId);
}
