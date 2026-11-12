// B2-09c: the console's read-only statements over payout's own tables (withdrawals,
// payout_batches, payout_batch_items, payout_attempts, withdraw_holds), every one scoped by
// app_id. No locks, no writes, no logging. payout_attempts is read for its summary columns only:
// the channel request and response bodies are never selected.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import { sql, type ExpressionBuilder, type Kysely, type Selectable } from 'kysely';

type WithdrawalRow = Selectable<DB['withdrawals']>;

/** The console filter of the withdrawals (every field ANDed; absent = all). */
export interface AdminWithdrawalFilter {
  readonly appId: string;
  readonly status: string | undefined;
  readonly displayStatus: string | undefined;
  readonly reviewMode: string | undefined;
  readonly payoutChannel: string | undefined;
  /** A uuid (lower case); the caller answers an empty page for any other text. */
  readonly userId: string | undefined;
  readonly outBizNo: string | undefined;
  readonly amountMinFen: bigint | undefined;
  readonly amountMaxFen: bigint | undefined;
  /** ISO 8601 with offset, inclusive. */
  readonly createdFrom: string | undefined;
  /** ISO 8601 with offset, exclusive. */
  readonly createdTo: string | undefined;
  readonly holdReason: string | undefined;
  readonly blocked: boolean | undefined;
  readonly riskFlag: string | undefined;
}

const PAYER_SIDE = 'payer_side_after_transfer';

/**
 * B2-09zl: 「等待审核」of the BR-WDR-08 细则 table (display_status pending_review): PENDING_REVIEW,
 * and APPROVED not held for a payer-side failure after a transfer. The one judgement the console
 * list filter and the dashboard count (withdraw_review_pending) share; 08 counts the waiting
 * number by the same rule.
 */
export function pendingReview(eb: ExpressionBuilder<DB, 'withdrawals'>) {
  return eb.or([
    eb('status', '=', 'PENDING_REVIEW'),
    eb.and([
      eb('status', '=', 'APPROVED'),
      eb.or([eb('hold_reason', 'is', null), eb('hold_reason', '<>', PAYER_SIDE)]),
    ]),
  ]);
}

/**
 * B2-09zl: the app's withdrawals waiting for review, the same rows as the console list filtered
 * by display_status pending_review. Read only on the given handle; the partial index
 * withdrawals_open_idx (app_id, user_id) WHERE status IN (PENDING_REVIEW, APPROVED, PAYING)
 * covers the rows by its app_id prefix.
 */
export async function countPendingReviewWithdrawals(
  db: Kysely<DB>,
  appId: string,
): Promise<number> {
  const row = await db
    .withSchema('app')
    .selectFrom('withdrawals')
    .where('app_id', '=', appId)
    .where(pendingReview)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

function adminWithdrawalQuery(db: Kysely<DB>, filter: AdminWithdrawalFilter) {
  let query = db.withSchema('app').selectFrom('withdrawals').where('app_id', '=', filter.appId);
  if (filter.status !== undefined) query = query.where('status', '=', filter.status);
  // The BR-WDR-08 细则 table of adminWithdrawalDisplayStatus, as conditions on the stored columns.
  switch (filter.displayStatus) {
    case undefined:
      break;
    case 'pending_review':
      query = query.where(pendingReview);
      break;
    case 'pending_handle':
      query = query.where('status', '=', 'APPROVED').where('hold_reason', '=', PAYER_SIDE);
      break;
    case 'paid_auto_system':
      query = query.where('status', '=', 'PAID_API').where('review_mode', '=', 'auto');
      break;
    case 'paid_auto_review':
      query = query
        .where('status', '=', 'PAID_API')
        .where((eb) => eb.or([eb('review_mode', 'is', null), eb('review_mode', '<>', 'auto')]));
      break;
    case 'rejected':
      query = query.where('status', '=', 'REJECTED');
      break;
    case 'paid_manual':
      query = query.where('status', '=', 'PAID_MANUAL');
      break;
    case 'paying':
      query = query.where('status', '=', 'PAYING');
      break;
    case 'failed':
      query = query.where('status', '=', 'FAILED');
      break;
    default:
      throw new Error('payout: unknown admin withdrawal display status');
  }
  if (filter.reviewMode !== undefined) query = query.where('review_mode', '=', filter.reviewMode);
  if (filter.payoutChannel !== undefined) {
    query = query.where('payout_channel', '=', filter.payoutChannel);
  }
  if (filter.userId !== undefined) query = query.where('user_id', '=', filter.userId);
  if (filter.outBizNo !== undefined) query = query.where('out_biz_no', '=', filter.outBizNo);
  if (filter.amountMinFen !== undefined) {
    query = query.where('amount_fen', '>=', filter.amountMinFen);
  }
  if (filter.amountMaxFen !== undefined) {
    query = query.where('amount_fen', '<=', filter.amountMaxFen);
  }
  if (filter.createdFrom !== undefined) {
    query = query.where('created_at', '>=', sql<Date>`${filter.createdFrom}::timestamptz`);
  }
  if (filter.createdTo !== undefined) {
    query = query.where('created_at', '<', sql<Date>`${filter.createdTo}::timestamptz`);
  }
  if (filter.holdReason !== undefined) query = query.where('hold_reason', '=', filter.holdReason);
  if (filter.blocked === true) query = query.where('blocked_reason', 'is not', null);
  if (filter.blocked === false) query = query.where('blocked_reason', 'is', null);
  if (filter.riskFlag !== undefined) {
    // An element of the snapshot array whose code is this one (a code listed inside the value of
    // risk_calc_failed is not a hit).
    const probe = JSON.stringify([{ code: filter.riskFlag }]);
    query = query.where(sql<boolean>`risk_flags @> ${probe}::jsonb`);
  }
  return query;
}

export async function countAdminWithdrawals(
  db: Kysely<DB>,
  filter: AdminWithdrawalFilter,
): Promise<number> {
  const row = await adminWithdrawalQuery(db, filter)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

/** One page of the filter set, created_at then id descending. */
export async function pageAdminWithdrawals(
  db: Kysely<DB>,
  filter: AdminWithdrawalFilter,
  offset: number,
  limit: number,
): Promise<WithdrawalRow[]> {
  return adminWithdrawalQuery(db, filter)
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
}

/** The app's withdrawal of this id (undefined for any other). */
export async function findAdminWithdrawal(
  db: Kysely<DB>,
  appId: string,
  id: string,
): Promise<WithdrawalRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', id)
    .executeTakeFirst();
}

/** The app's payout batch of this id. */
export async function findAdminWithdrawalBatch(db: Kysely<DB>, appId: string, batchId: string) {
  return db
    .withSchema('app')
    .selectFrom('payout_batches')
    .select(['id', 'kind', 'created_at'])
    .where('app_id', '=', appId)
    .where('id', '=', batchId)
    .executeTakeFirst();
}

/** Every payout_batch_items row of the withdrawal, oldest first. */
export async function withdrawalBatchItems(db: Kysely<DB>, appId: string, withdrawalId: string) {
  return db
    .withSchema('app')
    .selectFrom('payout_batch_items')
    .select(['batch_id', 'result', 'reason', 'moved_to_batch_id', 'at'])
    .where('app_id', '=', appId)
    .where('withdrawal_id', '=', withdrawalId)
    .orderBy('at')
    .orderBy('id')
    .execute();
}

/** Every transfer attempt of the withdrawal as a summary (no bodies), oldest first. */
export async function withdrawalAttempts(db: Kysely<DB>, appId: string, withdrawalId: string) {
  return db
    .withSchema('app')
    .selectFrom('payout_attempts')
    .select(['id', 'kind', 'result', 'resp_code', 'resp_sub_code', 'at'])
    .where('app_id', '=', appId)
    .where('withdrawal_id', '=', withdrawalId)
    .orderBy('at')
    .orderBy('id')
    .execute();
}

/** The user's withdraw_holds in effect at `now` (not released, not expired), oldest first. */
export async function holdsInEffect(db: Kysely<DB>, appId: string, userId: string, now: Date) {
  return db
    .withSchema('app')
    .selectFrom('withdraw_holds')
    .select(['id', 'reason', 'source_ref', 'created_at', 'hold_until'])
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('released_at', 'is', null)
    .where((eb) => eb.or([eb('hold_until', 'is', null), eb('hold_until', '>', now)]))
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}
