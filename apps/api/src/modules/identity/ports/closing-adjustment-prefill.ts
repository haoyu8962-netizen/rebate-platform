// B2-12d (BR-FUND-24 ⑧, BR-ID-28; D10-590 ③): identity's port for the system-prefilled
// ACCOUNT_CLOSED decrease. Declared here, implemented by ledger and handed in by app.module's
// assembly (identity never imports ledger's application code).
//
// Called on identity's transaction with the users row already locked:
// - by the cooling-period expiry right after the request moved to processing (available > 0);
// - by the processing round when the closing gate is pending and the member has no PENDING
//   ACCOUNT_CLOSED form (at most one new form per accounting day).
// A PENDING form that already exists is not an error (partial unique key); the implementation
// also writes nothing while available is not above 0. A thrown error rolls the caller's
// transaction back (the expiry's processing step with it).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface ClosingAdjustmentPrefillInput {
  readonly appId: string;
  readonly userId: string;
  /** deletion_requests.id: the form's one ref (ref_type account_deletion). */
  readonly deletionRequestId: string;
  /** The step's Clock reading. */
  readonly at: Date;
}

export interface DeletionClosingAdjustmentPrefill {
  prefill(trx: Transaction<DB>, input: ClosingAdjustmentPrefillInput): Promise<unknown>;
}
