// B2-09zl: the dashboard's withdraw_review_pending count (contracts/openapi.yaml AdminDashboardTodo,
// permission point withdraw.review; 编排 D10-1401). Equal to the total of the console list
// (listAdminWithdrawals) filtered by display_status pending_review: the same judgement
// (infra/admin-withdrawals-store.ts pendingReview), so the card and the list cannot drift
// (08 BR-WDR-08 细则：待审数量按同一口径计数). Not readPayoutReviewOverdue, a worker metric with
// another rule. Read only, by app; the permission check is the dashboard's.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { countPendingReviewWithdrawals } from '../infra/admin-withdrawals-store.ts';

/** The app's withdrawals waiting for review (display_status pending_review). */
export function countWithdrawReviewPending(db: Kysely<DB>, appId: string): Promise<number> {
  return countPendingReviewWithdrawals(db, appId);
}
