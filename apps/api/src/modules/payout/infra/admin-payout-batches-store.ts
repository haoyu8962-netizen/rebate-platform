// B2-07g: the console's read-only statements of the payout batch list and detail (contracts/openapi.yaml
// listAdminPayoutBatches, getAdminPayoutBatch, CT-24zzo; 08 BR-WDR-12, BR-WDR-14, BR-WDR-17; ruling
// D10-2017 ②) over payout's own tables (payout_batches, payout_batch_items, withdrawals,
// payout_attempts), every one scoped by app_id. No locks, no writes, no logging. payout_attempts is
// read for kind, result and at only: the channel request and response bodies are never selected.
//
// A member of a batch is a withdrawal with at least one payout_batch_items row of the batch; its
// result there is its newest item of the batch (`at`, then the item id). A member is held on the
// batch when its withdrawal is still on it (withdrawals.batch_id), in APPROVED and has a hold_reason.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';

/** The console filter of the batches (every field ANDed; absent = all). */
export interface AdminPayoutBatchFilter {
  readonly appId: string;
  readonly kind: string | undefined;
  /** true = a held member, false = none. */
  readonly held: boolean | undefined;
  /** ISO 8601 with offset, inclusive. */
  readonly createdFrom: string | undefined;
  /** ISO 8601 with offset, exclusive. */
  readonly createdTo: string | undefined;
}

/** One payout_batches row as the reads use it. */
export interface AdminPayoutBatchRow {
  readonly id: string;
  readonly kind: string;
  readonly created_by: string | null;
  readonly created_at: Date;
}

/** The member counts of one batch (zero for a batch without a member). */
export interface AdminPayoutBatchStats {
  readonly memberCount: number;
  readonly paying: number;
  readonly skipped: number;
  readonly blocked: number;
  readonly movedOut: number;
  readonly heldCount: number;
  /** The earliest `at` of its paying, skipped or blocked items; null without one. */
  readonly executedAt: Date | null;
}

/** One member of a batch with its withdrawal as it is now. */
export interface AdminPayoutBatchMemberRow {
  readonly withdrawal_id: string;
  readonly result: string;
  readonly execute_seq: number;
  readonly out_biz_no: string;
  readonly net_fen: bigint;
  readonly status: string;
  readonly hold_reason: string | null;
  readonly needs_manual: boolean;
  readonly channel_state: string | null;
}

/** What a member's payout_attempts give the detail. */
export interface AdminPayoutBatchMemberAttempts {
  /** The `at` of its earliest kind=transfer attempt (any result). */
  readonly firstTransferAt: Date | null;
  /** Its newest attempt of any kind (`at`, then the attempt id). */
  readonly last: { readonly kind: string; readonly result: string; readonly at: Date } | null;
}

type BatchScope = ExpressionBuilder<DB & { b: DB['payout_batches'] }, 'b'>;

/** A member of batch `b` still on it, in APPROVED and with a hold_reason. */
function heldMember(eb: BatchScope, appId: string) {
  return eb.exists(
    eb
      .selectFrom('payout_batch_items as hi')
      .innerJoin('withdrawals as hw', (join) =>
        join.onRef('hw.app_id', '=', 'hi.app_id').onRef('hw.id', '=', 'hi.withdrawal_id'),
      )
      .select(sql<number>`1`.as('one'))
      .where('hi.app_id', '=', appId)
      .whereRef('hi.batch_id', '=', 'b.id')
      .whereRef('hw.batch_id', '=', 'b.id')
      .where('hw.status', '=', 'APPROVED')
      .where('hw.hold_reason', 'is not', null),
  );
}

function adminPayoutBatchQuery(db: Kysely<DB>, filter: AdminPayoutBatchFilter) {
  let query = db
    .withSchema('app')
    .selectFrom('payout_batches as b')
    .where('b.app_id', '=', filter.appId);
  if (filter.kind !== undefined) query = query.where('b.kind', '=', filter.kind);
  if (filter.createdFrom !== undefined) {
    query = query.where('b.created_at', '>=', sql<Date>`${filter.createdFrom}::timestamptz`);
  }
  if (filter.createdTo !== undefined) {
    query = query.where('b.created_at', '<', sql<Date>`${filter.createdTo}::timestamptz`);
  }
  if (filter.held === true) query = query.where((eb) => heldMember(eb, filter.appId));
  if (filter.held === false) query = query.where((eb) => eb.not(heldMember(eb, filter.appId)));
  return query;
}

export async function countAdminPayoutBatches(
  db: Kysely<DB>,
  filter: AdminPayoutBatchFilter,
): Promise<number> {
  const row = await adminPayoutBatchQuery(db, filter)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

/** One page of the filter set, created_at then id descending. */
export async function pageAdminPayoutBatches(
  db: Kysely<DB>,
  filter: AdminPayoutBatchFilter,
  offset: number,
  limit: number,
): Promise<AdminPayoutBatchRow[]> {
  return adminPayoutBatchQuery(db, filter)
    .select(['b.id', 'b.kind', 'b.created_by', 'b.created_at'])
    .orderBy('b.created_at', 'desc')
    .orderBy('b.id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
}

/** The app's payout batch of this id (undefined for any other). */
export async function findAdminPayoutBatch(
  db: Kysely<DB>,
  appId: string,
  batchId: string,
): Promise<AdminPayoutBatchRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('payout_batches')
    .select(['id', 'kind', 'created_by', 'created_at'])
    .where('app_id', '=', appId)
    .where('id', '=', batchId)
    .executeTakeFirst();
}

const EMPTY_STATS: AdminPayoutBatchStats = {
  memberCount: 0,
  paying: 0,
  skipped: 0,
  blocked: 0,
  movedOut: 0,
  heldCount: 0,
  executedAt: null,
};

/** The member counts and executed_at of each of these batches of the app. */
export async function adminPayoutBatchStats(
  db: Kysely<DB>,
  appId: string,
  batchIds: readonly string[],
): Promise<Map<string, AdminPayoutBatchStats>> {
  const stats = new Map<string, AdminPayoutBatchStats>();
  if (batchIds.length === 0) return stats;
  const ids = [...batchIds];
  const app = db.withSchema('app');
  // Each member's newest item of the batch (`at`, then the item id).
  const latest = app
    .selectFrom('payout_batch_items as i')
    .distinctOn(['i.batch_id', 'i.withdrawal_id'])
    .select(['i.batch_id', 'i.withdrawal_id', 'i.result'])
    .where('i.app_id', '=', appId)
    .where('i.batch_id', 'in', ids)
    .orderBy('i.batch_id')
    .orderBy('i.withdrawal_id')
    .orderBy('i.at', 'desc')
    .orderBy('i.id', 'desc')
    .as('m');
  const counted = await app
    .selectFrom(latest)
    .innerJoin('withdrawals as w', (join) =>
      join.on('w.app_id', '=', appId).onRef('w.id', '=', 'm.withdrawal_id'),
    )
    .select((eb) => [
      'm.batch_id',
      eb.fn.countAll<string>().as('member_count'),
      eb.fn.countAll<string>().filterWhere('m.result', '=', 'paying').as('paying'),
      eb.fn.countAll<string>().filterWhere('m.result', '=', 'skipped').as('skipped'),
      eb.fn.countAll<string>().filterWhere('m.result', '=', 'blocked').as('blocked'),
      eb.fn.countAll<string>().filterWhere('m.result', '=', 'moved_out').as('moved_out'),
      eb.fn
        .countAll<string>()
        .filterWhere((inner) =>
          inner.and([
            inner('w.batch_id', '=', inner.ref('m.batch_id')),
            inner('w.status', '=', 'APPROVED'),
            inner('w.hold_reason', 'is not', null),
          ]),
        )
        .as('held_count'),
    ])
    .groupBy('m.batch_id')
    .execute();
  const executed = await app
    .selectFrom('payout_batch_items')
    .select((eb) => ['batch_id', eb.fn.min('at').as('executed_at')])
    .where('app_id', '=', appId)
    .where('batch_id', 'in', ids)
    .where('result', 'in', ['paying', 'skipped', 'blocked'])
    .groupBy('batch_id')
    .execute();
  const executedAt = new Map(executed.map((row) => [row.batch_id, row.executed_at as Date]));
  for (const id of ids) stats.set(id, { ...EMPTY_STATS, executedAt: executedAt.get(id) ?? null });
  for (const row of counted) {
    stats.set(row.batch_id, {
      memberCount: Number(row.member_count),
      paying: Number(row.paying),
      skipped: Number(row.skipped),
      blocked: Number(row.blocked),
      movedOut: Number(row.moved_out),
      heldCount: Number(row.held_count),
      executedAt: executedAt.get(row.batch_id) ?? null,
    });
  }
  return stats;
}

/**
 * The members of the batch with their withdrawals now, in the order of their first item of the
 * batch, then withdrawal_id ascending.
 */
export async function adminPayoutBatchMembers(
  db: Kysely<DB>,
  appId: string,
  batchId: string,
): Promise<AdminPayoutBatchMemberRow[]> {
  const app = db.withSchema('app');
  const latest = app
    .selectFrom('payout_batch_items as i')
    .distinctOn('i.withdrawal_id')
    .select(['i.withdrawal_id', 'i.result'])
    .where('i.app_id', '=', appId)
    .where('i.batch_id', '=', batchId)
    .orderBy('i.withdrawal_id')
    .orderBy('i.at', 'desc')
    .orderBy('i.id', 'desc')
    .as('m');
  const first = app
    .selectFrom('payout_batch_items as fi')
    .select((eb) => ['fi.withdrawal_id', eb.fn.min('fi.at').as('first_at')])
    .where('fi.app_id', '=', appId)
    .where('fi.batch_id', '=', batchId)
    .groupBy('fi.withdrawal_id')
    .as('f');
  return app
    .selectFrom(latest)
    .innerJoin(first, (join) => join.onRef('f.withdrawal_id', '=', 'm.withdrawal_id'))
    .innerJoin('withdrawals as w', (join) =>
      join.on('w.app_id', '=', appId).onRef('w.id', '=', 'm.withdrawal_id'),
    )
    .select([
      'm.withdrawal_id',
      'm.result',
      'w.execute_seq',
      'w.out_biz_no',
      'w.net_fen',
      'w.status',
      'w.hold_reason',
      'w.needs_manual',
      'w.channel_state',
    ])
    .orderBy('f.first_at')
    .orderBy('m.withdrawal_id')
    .execute();
}

/** The earliest transfer attempt and the newest attempt of each of these withdrawals of the app. */
export async function adminPayoutBatchMemberAttempts(
  db: Kysely<DB>,
  appId: string,
  withdrawalIds: readonly string[],
): Promise<Map<string, AdminPayoutBatchMemberAttempts>> {
  const result = new Map<string, AdminPayoutBatchMemberAttempts>();
  if (withdrawalIds.length === 0) return result;
  const ids = [...withdrawalIds];
  const app = db.withSchema('app');
  const newest = await app
    .selectFrom('payout_attempts')
    .distinctOn('withdrawal_id')
    .select(['withdrawal_id', 'kind', 'result', 'at'])
    .where('app_id', '=', appId)
    .where('withdrawal_id', 'in', ids)
    .orderBy('withdrawal_id')
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const transfers = await app
    .selectFrom('payout_attempts')
    .select((eb) => ['withdrawal_id', eb.fn.min('at').as('first_at')])
    .where('app_id', '=', appId)
    .where('withdrawal_id', 'in', ids)
    .where('kind', '=', 'transfer')
    .groupBy('withdrawal_id')
    .execute();
  const firstTransfer = new Map(transfers.map((row) => [row.withdrawal_id, row.first_at as Date]));
  for (const row of newest) {
    result.set(row.withdrawal_id, {
      firstTransferAt: firstTransfer.get(row.withdrawal_id) ?? null,
      last: { kind: row.kind, result: row.result, at: row.at },
    });
  }
  return result;
}
