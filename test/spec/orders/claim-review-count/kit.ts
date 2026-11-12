import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { claim_status } from '../../../../packages/contracts-ts/src/index.ts';

const ROOT = new URL('../../../../', import.meta.url);

export interface ClaimReviewCount {
  count: number;
  breakdown: { auto_matched: number; manual_review: number };
}
export type CountClaimsPendingReview = (db: Kysely<DB>, appId: string) => Promise<ClaimReviewCount>;

export const NONE: ClaimReviewCount = {
  count: 0,
  breakdown: { auto_matched: 0, manual_review: 0 },
};

export const PENDING = ['auto_matched', 'manual_review'] as const;

/** Every other claim_status value (contracts/enums claim_status): none of them is counted. */
export const NOT_PENDING: readonly string[] = claim_status.filter(
  (status) => !(PENDING as readonly string[]).includes(status),
);

// Dynamic import keeps Nest decorators out of the rule-test project's erasable-only TS build. The
// export must come from the module's only public surface, orders/index.ts.
export async function load(): Promise<CountClaimsPendingReview> {
  const orders = (await import(new URL('apps/api/src/modules/orders/index.ts', ROOT).href)) as {
    countClaimsPendingReview?: unknown;
  };
  expect(typeof orders.countClaimsPendingReview, 'orders/index.ts exports the count').toBe(
    'function',
  );
  return orders.countClaimsPendingReview as CountClaimsPendingReview;
}

/** Status-dependent claim columns that satisfy claims_evidence_status_check. */
export function evidenceFor(status: string, weak = false): { evidence_level: string | null } {
  if (status === 'submitted') return { evidence_level: null };
  if (status === 'auto_matched') return { evidence_level: 'strong' };
  return { evidence_level: weak ? 'weak' : 'none' };
}
