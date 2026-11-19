// B2-07g skeleton (rule-test phase; the implementation round fills it in): GET /admin/v1/payout-batches
// and GET /admin/v1/payout-batches/{batch_id} (listAdminPayoutBatches, getAdminPayoutBatch, CT-24zzo;
// 08 BR-WDR-12, BR-WDR-14, BR-WDR-17; ruling D10-2017 ②). Read only: no audit record, no write.
// Rule tests: test/spec/payout/admin-payout-batches-read/**.
//
// memberNextQueryAt is the next_query_at of one member, the same source as the query job: the
// configuration payout.query_schedule read as readPayoutChannelConfig reads it, and the points of
// application/query-schedule.ts (nextQueryPoint / nextQueryDueMs), T being the `at` of the
// withdrawal's earliest kind=transfer attempt. Null unless the status is PAYING, needs_manual is
// false, there is a transfer attempt and channel_state is null or processing.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import type { QuerySchedule } from './query-schedule.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** What the two reads need (the admin entry's handle, its Clock and content's configuration). */
export interface AdminPayoutBatchesReadDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: PayoutConfigPort;
  readonly logger: Pick<Logger, 'warn'>;
}

/** The checked query of GET /admin/v1/payout-batches (the route schema has validated it). */
export interface AdminPayoutBatchListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly kind?: Schema<'AdminPayoutBatchKind'>;
  readonly held?: boolean;
  /** ISO 8601 with offset, inclusive. */
  readonly createdFrom?: string;
  /** ISO 8601 with offset, exclusive. */
  readonly createdTo?: string;
}

/** The facts of one withdrawal next_query_at is derived from. */
export interface MemberQueryFacts {
  readonly status: Schema<'WithdrawalStatus'>;
  readonly needsManual: boolean;
  readonly channelState: 'processing' | 'wait_user_confirm' | 'canceling' | null;
  /** The `at` of the withdrawal's earliest kind=transfer attempt; null without one. */
  readonly firstTransferAt: Date | null;
}

/** BR-WDR-14: when the next scheduled query of the member's transfer is due, or null. */
export function memberNextQueryAt(
  schedule: QuerySchedule,
  facts: MemberQueryFacts,
  now: Date,
): Date | null {
  void schedule;
  void facts;
  void now;
  throw new Error('NotImplemented: memberNextQueryAt');
}

/** One page of the app's batches, newest first; a created_from later than created_to is refused. */
export function listAdminPayoutBatches(
  deps: AdminPayoutBatchesReadDeps,
  appId: string,
  query: AdminPayoutBatchListQuery,
): Promise<Schema<'AdminPayoutBatchPage'>> {
  void deps;
  void appId;
  void query;
  throw new Error('NotImplemented: listAdminPayoutBatches');
}

/** One batch of the app with its members; null for an unknown id, a non-UUID or another app's. */
export function getAdminPayoutBatch(
  deps: AdminPayoutBatchesReadDeps,
  appId: string,
  batchId: string,
): Promise<Schema<'AdminPayoutBatchDetail'> | null> {
  void deps;
  void appId;
  void batchId;
  throw new Error('NotImplemented: getAdminPayoutBatch');
}
