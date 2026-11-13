import { expect, it } from 'vitest';
import type { AdminClaimFilter } from '../infra/admin-claim-reads.ts';
import { countClaimsPendingReviewWith } from './claim-review-count.ts';

const APP = 'claims_unit';

function reads(rows: { status: string; n: number }[]) {
  const filters: AdminClaimFilter[] = [];
  return {
    filters,
    counts: (filter: AdminClaimFilter) => {
      filters.push(filter);
      return Promise.resolve(rows);
    },
  };
}

it('[AC-B1-10v#1] count is auto_matched + manual_review; other statuses are left out', async () => {
  const r = reads([
    { status: 'submitted', n: 4 },
    { status: 'auto_matched', n: 3 },
    { status: 'manual_review', n: 5 },
    { status: 'approved', n: 7 },
    { status: 'rejected', n: 2 },
    { status: 'cancelled', n: 1 },
  ]);
  expect(await countClaimsPendingReviewWith(r, APP)).toEqual({
    count: 8,
    breakdown: { auto_matched: 3, manual_review: 5 },
  });
});

it('[AC-B1-10v#2] no rows gives zero for the count and both sub-counts', async () => {
  expect(await countClaimsPendingReviewWith(reads([]), APP)).toEqual({
    count: 0,
    breakdown: { auto_matched: 0, manual_review: 0 },
  });
});

it('[AC-B1-10v#3] asks the list read with only the app filter, as the unfiltered list page does', async () => {
  const r = reads([{ status: 'auto_matched', n: 1 }]);
  await countClaimsPendingReviewWith(r, APP);
  expect(r.filters).toEqual([{ appId: APP }]);
});

it('[AC-B1-10v#4] a status outside the enum is refused like the list page refuses it', async () => {
  await expect(
    countClaimsPendingReviewWith(reads([{ status: 'other', n: 1 }]), APP),
  ).rejects.toThrow('orders: unknown claim status');
});
