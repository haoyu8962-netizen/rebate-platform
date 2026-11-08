// B1-10b: the SQL of claim acceptance and the claim records (tables claims, claim_items, read of
// orders). Every query runs on the handle it is given (the acceptance transaction, or the pool for
// the record list) and names schema app explicitly.
import type { DB } from '@couli/db';
import { chinaDayRange } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { OrderSubject } from '../application/order-queries.ts';
import { findPlatformRules } from '../domain/platform-rules/index.ts';
import { orderKeyMatch } from './pipeline-store.ts';

/** What acceptance reads of a matched orders row. */
export interface ClaimOrderRow {
  readonly order_id: string;
  readonly sub_order_id: string;
  readonly buy_type: string | null;
  readonly user_id: string | null;
  readonly rebate_status: string;
  readonly locked: boolean;
  readonly attr_at: Date;
  /** B1-10c: the order's product key, shop and platform item id (claim evidence). */
  readonly product_key: string | null;
  readonly shop_id: string | null;
  readonly raw_item_id: string;
}

/**
 * Orders of (app_id, platform) whose child (`sub`) or parent (`parent`) number equals `value`.
 * pdd compares with every hyphen removed from the stored number (the caller removes them from the
 * input); other platforms compare exactly (rule table orderNoStripHyphens), by `sub` through
 * order_keys. A null parent number never matches.
 */
export async function findClaimOrders(
  trx: Transaction<DB>,
  appId: string,
  platform: string,
  value: string,
  by: 'sub' | 'parent',
): Promise<ClaimOrderRow[]> {
  const column = by === 'sub' ? 'sub_order_id' : 'parent_order_id';
  const strip = findPlatformRules(platform)?.orderNoStripHyphens === true;
  const stored = strip ? sql<string>`replace(${sql.ref(column)}, '-', '')` : sql.ref(column);
  const query = trx
    .withSchema('app')
    .selectFrom('orders')
    .select([
      'order_id',
      'sub_order_id',
      'buy_type',
      'user_id',
      'rebate_status',
      'locked',
      'attr_at',
      'product_key',
      'shop_id',
      'raw_item_id',
    ])
    .where('app_id', '=', appId)
    .where('platform', '=', platform)
    .where(sql<boolean>`${sql.ref(column)} is not null`);
  // B1-09x (D10-853): an exact sub number goes through order_keys and reads orders by its PK (same
  // rows as comparing orders.sub_order_id); an exact parent number uses orders_parent_order_idx.
  // The pdd hyphen-stripped comparison keeps its scan (FU-PDD-ORDERNO-NORMALIZED-INDEX).
  if (!strip && by === 'sub') {
    return query
      .where((eb) => orderKeyMatch(eb, { app_id: appId, platform, sub_order_ids: value }))
      .execute();
  }
  return query.where(sql<boolean>`${stored} = ${value}`).execute();
}

/** Claims of the subject created on the +08:00 day `day` (YYYY-MM-DD), whatever their status. */
export async function countClaimsOn(
  trx: Transaction<DB>,
  subject: OrderSubject,
  day: string,
): Promise<number> {
  const { start, end } = chinaDayRange(day);
  const row = await trx
    .withSchema('app')
    .selectFrom('claims')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where(sql<boolean>`${sql.ref('created_at')} >= ${start}::timestamptz`)
    .where(sql<boolean>`${sql.ref('created_at')} < ${end}::timestamptz`)
    .executeTakeFirstOrThrow();
  return row.n;
}

/** The sub_order_ids among `subOrderIds` the applicant already has in claim_items (any decision). */
export async function claimedSubOrders(
  trx: Transaction<DB>,
  subject: OrderSubject,
  platform: string,
  subOrderIds: readonly string[],
): Promise<Set<string>> {
  if (subOrderIds.length === 0) return new Set();
  const rows = await trx
    .withSchema('app')
    .selectFrom('claim_items')
    .select('sub_order_id')
    .where('app_id', '=', subject.app_id)
    .where('applicant_user_id', '=', subject.user_id)
    .where('platform', '=', platform)
    .where('sub_order_id', 'in', [...subOrderIds])
    .execute();
  return new Set(rows.map((row) => row.sub_order_id));
}

export interface NewClaim {
  readonly id: string;
  readonly subject: OrderSubject;
  readonly platform: string;
  readonly order_no: string;
  readonly order_no_type: 'sub' | 'parent';
  readonly paid_date: string;
  readonly status: string;
  readonly now: Date;
  readonly items: readonly {
    readonly id: string;
    readonly sub_order_id: string;
    readonly order_id: string;
  }[];
}

/** The savepoint of insertClaim (never nested: one insert per acceptance). */
const INSERT_SAVEPOINT = sql.raw('orders_claim_insert');

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

/**
 * Inserts the claim and its items under a savepoint of `trx`; resolves with the status as stored,
 * or null when a unique key refused a row: the inserts are then rolled back to the savepoint and
 * `trx` stays usable (it may be the caller's, e.g. platform idempotency's, which still commits its
 * record). Any other error rejects unchanged and leaves the transaction to roll back.
 */
export async function insertClaim(trx: Transaction<DB>, claim: NewClaim): Promise<string | null> {
  await sql`SAVEPOINT ${INSERT_SAVEPOINT}`.execute(trx);
  let status: string;
  try {
    status = await insertClaimRows(trx, claim);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await sql`ROLLBACK TO SAVEPOINT ${INSERT_SAVEPOINT}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${INSERT_SAVEPOINT}`.execute(trx);
    return null;
  }
  await sql`RELEASE SAVEPOINT ${INSERT_SAVEPOINT}`.execute(trx);
  return status;
}

async function insertClaimRows(trx: Transaction<DB>, claim: NewClaim): Promise<string> {
  const { subject, now } = claim;
  const saved = await trx
    .withSchema('app')
    .insertInto('claims')
    .values({
      id: claim.id,
      app_id: subject.app_id,
      user_id: subject.user_id,
      platform: claim.platform,
      order_no: claim.order_no,
      order_no_type: claim.order_no_type,
      paid_date: claim.paid_date,
      evidence_level: null,
      status: claim.status,
      created_at: now,
      updated_at: now,
    })
    .returning('status')
    .executeTakeFirstOrThrow();
  await trx
    .withSchema('app')
    .insertInto('claim_items')
    .values(
      claim.items.map((item) => ({
        id: item.id,
        app_id: subject.app_id,
        claim_id: claim.id,
        applicant_user_id: subject.user_id,
        platform: claim.platform,
        sub_order_id: item.sub_order_id,
        order_id: item.order_id,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  return saved.status;
}

/** The savepoint of underClaimSavepoint (around insertClaim's own, never nested in itself). */
const SETTLE_SAVEPOINT = sql.raw('orders_claim_settle');

/**
 * B1-10c: runs `work` under a savepoint of `trx`. A rejection of `work` rolls `trx` back to the
 * savepoint (undoing whatever `work` wrote; `trx` stays usable) and resolves { ok: false }.
 */
export async function underClaimSavepoint<T>(
  trx: Transaction<DB>,
  work: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  await sql`SAVEPOINT ${SETTLE_SAVEPOINT}`.execute(trx);
  let value: T;
  try {
    value = await work();
  } catch {
    await sql`ROLLBACK TO SAVEPOINT ${SETTLE_SAVEPOINT}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${SETTLE_SAVEPOINT}`.execute(trx);
    return { ok: false };
  }
  await sql`RELEASE SAVEPOINT ${SETTLE_SAVEPOINT}`.execute(trx);
  return { ok: true, value };
}

export interface ClaimEvidenceWrite {
  readonly claimId: string;
  readonly subject: OrderSubject;
  /** The status transitionClaim() gave for the evidence event (from submitted). */
  readonly status: string;
  readonly evidenceLevel: string;
  readonly now: Date;
  readonly items: readonly {
    readonly id: string;
    readonly evidence: string;
    readonly linkLogIds: readonly bigint[];
  }[];
}

/**
 * B1-10c: writes the evidence of each item and moves the claim from submitted (compare-and-set on
 * the status) to `status` with its evidence_level; updated_at = now and row_version + 1 on every
 * row. Resolves with the status as stored; a claim no longer submitted (not expected: the rows
 * were written by this transaction) rejects, rolling the acceptance back.
 */
export async function writeClaimEvidence(
  trx: Transaction<DB>,
  write: ClaimEvidenceWrite,
): Promise<string> {
  const { subject, now } = write;
  for (const item of write.items) {
    const ids = item.linkLogIds.map(String);
    const updated = await trx
      .withSchema('app')
      .updateTable('claim_items')
      .set({
        evidence: item.evidence,
        evidence_link_log_ids: sql<bigint[]>`${ids}::bigint[]`,
        updated_at: now,
        row_version: sql<number>`${sql.ref('row_version')} + 1`,
      })
      .where('id', '=', item.id)
      .where('app_id', '=', subject.app_id)
      .where('claim_id', '=', write.claimId)
      .where('evidence', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error('orders: claim item evidence not written');
  }
  const saved = await trx
    .withSchema('app')
    .updateTable('claims')
    .set({
      status: write.status,
      evidence_level: write.evidenceLevel,
      updated_at: now,
      row_version: sql<number>`${sql.ref('row_version')} + 1`,
    })
    .where('id', '=', write.claimId)
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('status', '=', 'submitted')
    .returning('status')
    .executeTakeFirst();
  if (saved === undefined) throw new Error('orders: claim not in submitted for its evidence');
  return saved.status;
}

/** A claims row as the record list reads it. */
export interface ClaimRecordRow {
  readonly id: string;
  readonly platform: string;
  readonly order_no: string;
  readonly paid_day: string;
  readonly status: string;
  readonly created_at: Date;
  /** created_at as UTC text with microseconds (cursor precision). */
  readonly created_key: string;
}

export interface ClaimItemRow {
  readonly claim_id: string;
  readonly sub_order_id: string;
  readonly decision: string | null;
  readonly reject_reason: string | null;
}

/** The subject's claims, created_at then id descending, strictly after `after` when given. */
export async function listClaimRecords(
  db: Kysely<DB>,
  subject: OrderSubject,
  after: { readonly at: string; readonly id: string } | undefined,
  take: number,
): Promise<ClaimRecordRow[]> {
  let query = db
    .withSchema('app')
    .selectFrom('claims')
    .select([
      'id',
      'platform',
      'order_no',
      'status',
      'created_at',
      sql<string>`to_char(${sql.ref('paid_date')}, 'YYYY-MM-DD')`.as('paid_day'),
      sql<string>`to_char(${sql.ref('created_at')} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'created_key',
      ),
    ])
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id);
  if (after !== undefined) {
    query = query.where(
      sql<boolean>`(${sql.ref('created_at')}, ${sql.ref('id')}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(take).execute();
}

/** Items of the given claims of the subject. */
export async function listClaimItems(
  db: Kysely<DB>,
  subject: OrderSubject,
  claimIds: readonly string[],
): Promise<ClaimItemRow[]> {
  if (claimIds.length === 0) return [];
  return db
    .withSchema('app')
    .selectFrom('claim_items')
    .select(['claim_id', 'sub_order_id', 'decision', 'reject_reason'])
    .where('app_id', '=', subject.app_id)
    .where('applicant_user_id', '=', subject.user_id)
    .where('claim_id', 'in', [...claimIds])
    .execute();
}
