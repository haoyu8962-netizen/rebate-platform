// SQL of app.recon_diffs for the ledger (its single writer, 04 §3.2). Every statement runs on the
// handle or transaction it is given; reads never lock.
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Selectable, type Transaction } from 'kysely';

type ReconDiffRow = Selectable<DB['recon_diffs']>;

export interface ReconDiffInsert extends Omit<Insertable<DB['recon_diffs']>, 'resolution'> {
  readonly resolution: object | null;
}

/**
 * INSERT … ON CONFLICT DO NOTHING without a conflict target: every unique index of the table is an
 * arbiter (recon_diffs_business_key, recon_diffs_dedupe_key_key, recon_diffs_month_end_key,
 * recon_diffs_unresolved_internal_key), and a
 * conflicting row of a concurrent open transaction is waited for, never raised as 23505.
 * The inserted row, or undefined when a unique key already holds one.
 */
export async function insertReconDiffIfAbsent(
  trx: Transaction<DB>,
  row: ReconDiffInsert,
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .insertInto('recon_diffs')
    .values({ ...row, resolution: row.resolution as Insertable<DB['recon_diffs']>['resolution'] })
    .onConflict((conflict) => conflict.doNothing())
    .returningAll()
    .executeTakeFirst();
}

export async function findReconDiffByDedupeKey(
  trx: Transaction<DB>,
  appId: string,
  dedupeKey: string,
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('dedupe_key', '=', dedupeKey)
    .executeTakeFirst();
}

export async function findReconDiffByBusinessKey(
  trx: Transaction<DB>,
  key: {
    readonly appId: string;
    readonly type: string;
    readonly period: string;
    readonly refId: string;
  },
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', key.appId)
    .where('type', '=', key.type)
    .where('period', '=', key.period)
    .where('ref_id', '=', key.refId)
    .executeTakeFirst();
}

/**
 * B2-02zc: the unresolved (open / processing) ticket of an internal self-check type under
 * recon_diffs_unresolved_internal_key (app_id, type, ref_id), whatever its period; like the index,
 * never an order-level ticket (ref_type order keeps one per accounting day, D10-2295).
 */
export async function findUnresolvedReconDiff(
  trx: Transaction<DB>,
  key: { readonly appId: string; readonly type: string; readonly refId: string },
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', key.appId)
    .where('type', '=', key.type)
    .where('ref_id', '=', key.refId)
    .where('status', 'in', ['open', 'processing'])
    .where('ref_type', '<>', 'order')
    .executeTakeFirst();
}

export async function findReconDiffByMonthEnd(
  trx: Transaction<DB>,
  appId: string,
  period: string,
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('type', '=', 'month_end_unbalanced')
    .where('period', '=', period)
    .executeTakeFirst();
}

/** One plain SELECT on the given handle (its snapshot, no lock), oldest first. */
export async function selectReconDiffs(
  db: Kysely<DB>,
  filter: {
    readonly appId: string;
    readonly status: string | undefined;
    readonly orderKey: string | undefined;
  },
): Promise<ReconDiffRow[]> {
  let query = db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', filter.appId);
  if (filter.status !== undefined) query = query.where('status', '=', filter.status);
  if (filter.orderKey !== undefined) {
    query = query.where('ref_type', '=', 'order').where('ref_id', '=', filter.orderKey);
  }
  return query.orderBy('created_at').orderBy('id').execute();
}

/** B2-09a: the console filter of the R1–R3 recon diffs (every field ANDed; absent = all). */
export interface AdminReconDiffFilter {
  readonly appId: string;
  readonly type: string | undefined;
  readonly source: string | undefined;
  readonly status: string | undefined;
  readonly periodFrom: string | undefined;
  readonly periodTo: string | undefined;
  readonly refId: string | undefined;
}

/** The console's sources: R4 (收款对账) is payment's listAdminPayReconDiffs. */
const ADMIN_SOURCES = ['R1', 'R2', 'R3'];
const PERIOD_C = sql<string>`period collate "C"`;

function adminReconDiffQuery(db: Kysely<DB>, filter: AdminReconDiffFilter) {
  let query = db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .where('app_id', '=', filter.appId)
    .where('source', 'in', ADMIN_SOURCES);
  if (filter.type !== undefined) query = query.where('type', '=', filter.type);
  if (filter.source !== undefined) query = query.where('source', '=', filter.source);
  if (filter.status !== undefined) query = query.where('status', '=', filter.status);
  // Plain string order (a YYYY-MM period before the days of its month), whatever the collation.
  if (filter.periodFrom !== undefined) query = query.where(PERIOD_C, '>=', filter.periodFrom);
  if (filter.periodTo !== undefined) query = query.where(PERIOD_C, '<=', filter.periodTo);
  if (filter.refId !== undefined) query = query.where('ref_id', '=', filter.refId);
  return query;
}

export async function countAdminReconDiffs(
  db: Kysely<DB>,
  filter: AdminReconDiffFilter,
): Promise<number> {
  const row = await adminReconDiffQuery(db, filter)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

/** One page of the filter set, created_at then id descending. */
export async function pageAdminReconDiffs(
  db: Kysely<DB>,
  filter: AdminReconDiffFilter,
  offset: number,
  limit: number,
): Promise<ReconDiffRow[]> {
  return adminReconDiffQuery(db, filter)
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
}

/** The app's R1–R3 recon diff of this id (undefined for any other). */
export async function findAdminReconDiff(
  db: Kysely<DB>,
  appId: string,
  id: string,
): Promise<ReconDiffRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('source', 'in', ADMIN_SOURCES)
    .where('id', '=', id)
    .executeTakeFirst();
}

/** B2-09b: the app's R1–R3 recon diff of this id, its row locked (FOR UPDATE) on `trx`. */
export async function lockAdminReconDiff(
  trx: Transaction<DB>,
  appId: string,
  id: string,
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('source', 'in', ADMIN_SOURCES)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * B2-09h, D10-506: per order and amount state, the closed settle_amount_mismatch R1 diff that speaks
 * (the last closed with an outcome, closed_at then id descending), kept when it says 'union'.
 * A row's order_key is its whole ref_id, or the part before an anchored #AMT#{base}:{b_settle}; the
 * keys are compared as text (no LIKE, so _ % \ in a key are literal and no key matches by prefix).
 * One array parameter: the bill source passes every order key of a platform, which can exceed the
 * 65535 parameters of a statement. One plain SELECT on the given handle.
 */
export async function selectUnionConclusions(
  db: Kysely<DB>,
  selection: { readonly appId: string; readonly orderKeys: readonly string[] },
): Promise<
  { readonly order_key: string; readonly expected_fen: bigint; readonly actual_fen: bigint }[]
> {
  const { rows } = await sql<{ order_key: string; expected_fen: bigint; actual_fen: bigint }>`
    SELECT latest.order_key, latest.expected_fen, latest.actual_fen
    FROM (
      SELECT DISTINCT ON (asked.order_key, d.expected_fen, d.actual_fen)
        asked.order_key, d.expected_fen, d.actual_fen, d.resolution->>'outcome' AS outcome
      FROM app.recon_diffs AS d
      CROSS JOIN LATERAL (
        VALUES (d.ref_id), (substring(d.ref_id FROM '^(.*)#AMT#-?[0-9]+:-?[0-9]+$'))
      ) AS owner(order_key)
      INNER JOIN (
        SELECT DISTINCT given.order_key
        FROM unnest(${selection.orderKeys}::text[]) AS given(order_key)
      ) AS asked ON asked.order_key = owner.order_key
      WHERE d.app_id = ${selection.appId}
        AND d.source = 'R1'
        AND d.type = 'settle_amount_mismatch'
        AND d.ref_type = 'order'
        AND d.status = 'closed'
        AND d.resolution->>'outcome' IN ('union', 'ours')
      ORDER BY asked.order_key, d.expected_fen, d.actual_fen, d.closed_at DESC NULLS LAST, d.id DESC
    ) AS latest
    WHERE latest.outcome = 'union'
  `.execute(db);
  return rows;
}

/** The statuses a console close starts from (contract closeAdminReconDiff). */
const CLOSABLE = ['open', 'processing'];

/**
 * B2-09b: open / processing → closed, compare-and-set on the status (undefined when the row is no
 * longer closable or not the app's R1–R3 diff). handler_id the operator, closed_at = updated_at.
 */
export async function closeAdminReconDiffRow(
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly id: string;
    readonly handlerId: string;
    readonly at: Date;
    readonly resolution: object;
  },
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .updateTable('recon_diffs')
    .set({
      status: 'closed',
      handler_id: input.handlerId,
      closed_at: input.at,
      updated_at: input.at,
      resolution: sql`${JSON.stringify(input.resolution)}::jsonb`,
    })
    .where('app_id', '=', input.appId)
    .where('id', '=', input.id)
    .where('source', 'in', ADMIN_SOURCES)
    .where('status', 'in', CLOSABLE)
    .returningAll()
    .executeTakeFirst();
}

/**
 * B2-07e: open / processing → written_off, compare-and-set on the status (undefined when the row
 * is no longer open / processing or not the app's R1–R3 diff). handler_id the operator,
 * closed_at = updated_at; resolution as given (the stored keys plus w11 and the note).
 */
export async function writeOffAdminReconDiffRow(
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly id: string;
    readonly handlerId: string;
    readonly at: Date;
    readonly resolution: object;
  },
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .updateTable('recon_diffs')
    .set({
      status: 'written_off',
      handler_id: input.handlerId,
      closed_at: input.at,
      updated_at: input.at,
      resolution: sql`${JSON.stringify(input.resolution)}::jsonb`,
    })
    .where('app_id', '=', input.appId)
    .where('id', '=', input.id)
    .where('source', 'in', ADMIN_SOURCES)
    .where('status', 'in', CLOSABLE)
    .returningAll()
    .executeTakeFirst();
}

/**
 * B2-09g: open / processing → adjusted, compare-and-set on the status (undefined when the row is
 * no longer open / processing or not the app's R1–R3 diff). handler_id the operator,
 * closed_at = updated_at; resolution as given (the stored keys plus restore and the note).
 */
export async function restoreAdminReconDiffRow(
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly id: string;
    readonly handlerId: string;
    readonly at: Date;
    readonly resolution: object;
  },
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .updateTable('recon_diffs')
    .set({
      status: 'adjusted',
      handler_id: input.handlerId,
      closed_at: input.at,
      updated_at: input.at,
      resolution: sql`${JSON.stringify(input.resolution)}::jsonb`,
    })
    .where('app_id', '=', input.appId)
    .where('id', '=', input.id)
    .where('source', 'in', ADMIN_SOURCES)
    .where('status', 'in', CLOSABLE)
    .returningAll()
    .executeTakeFirst();
}
