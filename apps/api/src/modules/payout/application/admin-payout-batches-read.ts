// B2-07g: GET /admin/v1/payout-batches and GET /admin/v1/payout-batches/{batch_id}
// (listAdminPayoutBatches, getAdminPayoutBatch, CT-24zzo; 08 BR-WDR-12, BR-WDR-14, BR-WDR-17; ruling
// D10-2017 ②). Read only on the given handle, by app; the permission check (payout.execute or
// fund.view, read only) is the controller's and appId is always the guard's actor. No audit record,
// no write. Rule tests: test/spec/payout/admin-payout-batches-read/**.
//
// Both reads run in one repeatable-read transaction, so a list row and its members come from one
// snapshot. A detail carries the very counts of its list row (the same statement).
//
// memberNextQueryAt is the next_query_at of one member, the same source as the query job: the
// configuration payout.query_schedule read as readPayoutChannelConfig reads it, and the points of
// application/query-schedule.ts (nextQueryPoint / nextQueryDueMs), T being the `at` of the
// withdrawal's earliest kind=transfer attempt. Null unless the status is PAYING, needs_manual is
// false, there is a transfer attempt and channel_state is null or processing. payout.enabled and
// payout.queue_paused do not matter (BR-WDR-17: sent transfers keep being queried).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import {
  adminPayoutBatchMemberAttempts,
  adminPayoutBatchMembers,
  adminPayoutBatchStats,
  countAdminPayoutBatches,
  findAdminPayoutBatch,
  pageAdminPayoutBatches,
  type AdminPayoutBatchMemberAttempts,
  type AdminPayoutBatchMemberRow,
  type AdminPayoutBatchRow,
  type AdminPayoutBatchStats,
} from '../infra/admin-payout-batches-store.ts';
import { readPayoutChannelConfig } from './judgement.ts';
import { nextQueryDueMs, nextQueryPoint, type QuerySchedule } from './query-schedule.ts';
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

/** A 20001 with data.fields (created_from later than created_to, or a value that is no instant). */
export class AdminPayoutBatchFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('payout: admin payout batch read refused');
    this.name = 'AdminPayoutBatchFieldsError';
    this.fields = fields;
  }
}

/** payout_batches.id is a uuid column; any other text names no batch. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Summary = Schema<'AdminPayoutBatchSummary'>;
type Member = Schema<'AdminPayoutBatchMember'>;

/** BR-WDR-14: when the next scheduled query of the member's transfer is due, or null. */
export function memberNextQueryAt(
  schedule: QuerySchedule,
  facts: MemberQueryFacts,
  now: Date,
): Date | null {
  if (facts.status !== 'PAYING' || facts.needsManual) return null;
  // BR-WDR-33 ⑥: the WeChat confirmation stages are known states with their own time limits.
  if (facts.channelState !== null && facts.channelState !== 'processing') return null;
  const t = facts.firstTransferAt;
  if (t === null) return null;
  // A copy of T moved to the due instant (no `new Date` outside platform/clock).
  const due = structuredClone(t);
  due.setTime(nextQueryDueMs(schedule, t, nextQueryPoint(schedule, t, now)));
  return due;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function summaryView(row: AdminPayoutBatchRow, stats: AdminPayoutBatchStats | undefined): Summary {
  if (stats === undefined) throw new Error('payout: batch counts missing');
  return {
    batch_id: row.id,
    kind: row.kind as Summary['kind'],
    created_at: row.created_at.toISOString(),
    executed_at: iso(stats.executedAt),
    executor_id: row.created_by,
    member_count: stats.memberCount,
    result_counts: {
      paying: stats.paying,
      skipped: stats.skipped,
      blocked: stats.blocked,
      moved_out: stats.movedOut,
    },
    held_count: stats.heldCount,
  };
}

function channelStateOf(value: string | null): MemberQueryFacts['channelState'] {
  if (value === null || value === 'processing') return value;
  if (value === 'wait_user_confirm' || value === 'canceling') return value;
  throw new Error('payout: unknown withdrawal channel_state');
}

function memberView(
  row: AdminPayoutBatchMemberRow,
  attempts: AdminPayoutBatchMemberAttempts | undefined,
  schedule: QuerySchedule,
  now: Date,
): Member {
  const status = row.status as Member['status'];
  const firstTransferAt = attempts?.firstTransferAt ?? null;
  const last = attempts?.last ?? null;
  const nextQueryAt = memberNextQueryAt(
    schedule,
    {
      status,
      needsManual: row.needs_manual,
      channelState: channelStateOf(row.channel_state),
      firstTransferAt,
    },
    now,
  );
  return {
    execute_seq: row.execute_seq,
    withdrawal_id: row.withdrawal_id,
    out_biz_no: row.out_biz_no,
    net_fen: fenToJsonNumber(row.net_fen),
    status,
    result: row.result as Member['result'],
    // Shown only in APPROVED: EXECUTE does not clear an old reason (BR-WDR-12).
    hold_reason: status === 'APPROVED' ? (row.hold_reason as Member['hold_reason']) : null,
    needs_manual: row.needs_manual,
    last_attempt:
      last === null
        ? null
        : {
            kind: last.kind as NonNullable<Member['last_attempt']>['kind'],
            result: last.result as NonNullable<Member['last_attempt']>['result'],
            at: last.at.toISOString(),
          },
    next_query_at: iso(nextQueryAt),
    has_transfer_attempt: firstTransferAt !== null,
  };
}

/** The two date-time bounds: each an instant, the first not later than the second. */
function checkCreatedRange(createdFrom: string | undefined, createdTo: string | undefined): void {
  if (createdFrom !== undefined && !Number.isFinite(Date.parse(createdFrom))) {
    throw new AdminPayoutBatchFieldsError(['created_from']);
  }
  if (createdTo !== undefined && !Number.isFinite(Date.parse(createdTo))) {
    throw new AdminPayoutBatchFieldsError(['created_to']);
  }
  // Compared as instants: the two ends may carry different offsets. Equal ends: an empty page.
  if (
    createdFrom !== undefined &&
    createdTo !== undefined &&
    Date.parse(createdFrom) > Date.parse(createdTo)
  ) {
    throw new AdminPayoutBatchFieldsError(['created_from', 'created_to']);
  }
}

/** One page of the app's batches, newest first; a created_from later than created_to is refused. */
export async function listAdminPayoutBatches(
  deps: AdminPayoutBatchesReadDeps,
  appId: string,
  query: AdminPayoutBatchListQuery,
): Promise<Schema<'AdminPayoutBatchPage'>> {
  checkCreatedRange(query.createdFrom, query.createdTo);
  const { page, pageSize } = query;
  const filter = {
    appId,
    kind: query.kind,
    held: query.held,
    createdFrom: query.createdFrom,
    createdTo: query.createdTo,
  };
  return deps.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const total = await countAdminPayoutBatches(trx, filter);
      const offset = (page - 1) * pageSize;
      const rows =
        offset >= total ? [] : await pageAdminPayoutBatches(trx, filter, offset, pageSize);
      const stats = await adminPayoutBatchStats(
        trx,
        appId,
        rows.map((row) => row.id),
      );
      return {
        items: rows.map((row) => summaryView(row, stats.get(row.id))),
        page,
        page_size: pageSize,
        total,
      };
    });
}

/** One batch of the app with its members; null for an unknown id, a non-UUID or another app's. */
export async function getAdminPayoutBatch(
  deps: AdminPayoutBatchesReadDeps,
  appId: string,
  batchId: string,
): Promise<Schema<'AdminPayoutBatchDetail'> | null> {
  // Before the database: an id that is no uuid names no batch.
  if (!UUID.test(batchId)) return null;
  const id = batchId.toLowerCase();
  return deps.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const batch = await findAdminPayoutBatch(trx, appId, id);
      if (batch === undefined) return null;
      const stats = await adminPayoutBatchStats(trx, appId, [batch.id]);
      const members = await adminPayoutBatchMembers(trx, appId, batch.id);
      const attempts = await adminPayoutBatchMemberAttempts(
        trx,
        appId,
        members.map((row) => row.withdrawal_id),
      );
      const schedule = (await readPayoutChannelConfig(appId, trx, deps.config, deps.logger))
        .querySchedule;
      const now = deps.clock.now();
      return {
        ...summaryView(batch, stats.get(batch.id)),
        members: members.map((row) =>
          memberView(row, attempts.get(row.withdrawal_id), schedule, now),
        ),
      };
    });
}
