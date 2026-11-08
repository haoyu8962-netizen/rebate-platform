// B1-09g: rights_imports / rights_import_failures (orders is their only writer; 规划/02 §4.1).
// - the task row is inserted queued by the upload, then moved by the rights_import job only:
//   queued → running (CAS on status), one checkpoint per row (CAS on status running and the
//   committed total_rows), running → done / failed with finished_at;
// - rights_import_failures is insert-only (trigger), one row per (import_id, row_no).
// - reason_sub (B1-09v, migration 0131): the punish import's manual sub-reason as sent (`none`
//   included), written once with the row and never changed; NULL when not sent.
// The list / detail read admin_users.display_name / login_name for created_by_name: the use case's
// deps are the database only (the rule tests' signature), the read is display-only and writes
// nothing of admin's.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { RightsImportCounts, RightsImportFailureReason } from '../domain/rights-import.ts';

export type RightsImportRecord = Selectable<DB['rights_imports']>;

export interface NewRightsImport {
  readonly id: string;
  readonly app_id: string;
  readonly kind: string;
  readonly platform: string;
  readonly union_account_id: string | null;
  readonly time_basis: string | null;
  readonly from: string | null;
  readonly to: string | null;
  /** B1-09v: one of the 12 PUNISH sub-reasons or `none`; null when the part was not sent. */
  readonly reason_sub: string | null;
  readonly file_path: string;
  readonly created_by: string;
  readonly created_at: Date;
}

export async function insertRightsImport(
  trx: Transaction<DB>,
  row: NewRightsImport,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('rights_imports')
    .values({ ...row, status: 'queued' })
    .execute();
}

export async function findRightsImport(
  db: Kysely<DB>,
  appId: string,
  importId: string,
): Promise<RightsImportRecord | undefined> {
  return await db
    .withSchema('app')
    .selectFrom('rights_imports')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', importId)
    .executeTakeFirst();
}

/**
 * B1-09v: the manual sub-reason the task was created with (rights_imports.reason_sub, `none` as
 * sent), on the row's transaction; null when none was sent or the task is not stored.
 */
export async function readRightsImportReasonSub(
  trx: Transaction<DB>,
  appId: string,
  importId: string,
): Promise<string | null> {
  const row = await trx
    .withSchema('app')
    .selectFrom('rights_imports')
    .select('reason_sub')
    .where('app_id', '=', appId)
    .where('id', '=', importId)
    .executeTakeFirst();
  return row?.reason_sub ?? null;
}

/** queued → running; false when the row was not queued any more. */
export async function markRightsImportRunning(
  db: Kysely<DB>,
  appId: string,
  importId: string,
): Promise<boolean> {
  const result = await db
    .withSchema('app')
    .updateTable('rights_imports')
    .set({ status: 'running' })
    .where('app_id', '=', appId)
    .where('id', '=', importId)
    .where('status', '=', 'queued')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** running → done / failed with finished_at; false when the row was not running any more. */
export async function finishRightsImport(
  db: Kysely<DB>,
  appId: string,
  importId: string,
  status: 'done' | 'failed',
  finishedAt: Date,
): Promise<boolean> {
  const result = await db
    .withSchema('app')
    .updateTable('rights_imports')
    .set({ status, finished_at: finishedAt })
    .where('app_id', '=', appId)
    .where('id', '=', importId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Locks the task row for one row's transaction (FOR UPDATE) while it is still running at the
 * caller's checkpoint; false when another attempt moved it (or it ended) meanwhile.
 */
export async function lockRightsImportCheckpoint(
  trx: Transaction<DB>,
  appId: string,
  importId: string,
  committed: number,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('rights_imports')
    .select('id')
    .where('app_id', '=', appId)
    .where('id', '=', importId)
    .where('status', '=', 'running')
    .where('total_rows', '=', committed)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * One row's checkpoint, on the row's transaction (the one its processor wrote on; the caller
 * commits it): its failure (if any) and its tallies. `committed` is the total_rows the caller
 * resumed from; a row that moved meanwhile (another attempt) is refused.
 */
export async function commitRightsImportRow(
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly importId: string;
    readonly committed: number;
    readonly rowNo: number;
    readonly failure: RightsImportFailureReason | null;
    readonly add: RightsImportCounts;
  },
): Promise<void> {
  const { add } = input;
  const result = await trx
    .withSchema('app')
    .updateTable('rights_imports')
    .set({
      total_rows: sql<number>`total_rows + ${add.total_rows}`,
      succeeded_rows: sql<number>`succeeded_rows + ${add.succeeded_rows}`,
      failed_rows: sql<number>`failed_rows + ${add.failed_rows}`,
      skipped_rows: sql<number>`skipped_rows + ${add.skipped_rows}`,
      duplicate_rows: sql<number>`duplicate_rows + ${add.duplicate_rows}`,
    })
    .where('app_id', '=', input.appId)
    .where('id', '=', input.importId)
    .where('status', '=', 'running')
    .where('total_rows', '=', input.committed)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    throw new Error('orders: rights import checkpoint moved; this attempt stops');
  }
  if (input.failure !== null) {
    await trx
      .withSchema('app')
      .insertInto('rights_import_failures')
      .values({
        app_id: input.appId,
        import_id: input.importId,
        row_no: input.rowNo,
        reason: input.failure,
      })
      .execute();
  }
}

export interface RightsImportListRow extends RightsImportRecord {
  readonly created_by_name: string | null;
}

function withNames(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('rights_imports as r')
    .leftJoin('admin_users as a', (join) =>
      join.onRef('a.app_id', '=', 'r.app_id').onRef('a.id', '=', 'r.created_by'),
    )
    .selectAll('r')
    .select(sql<string | null>`coalesce(a.display_name, a.login_name)`.as('created_by_name'))
    .where('r.app_id', '=', appId);
}

export async function listRightsImportRows(
  db: Kysely<DB>,
  appId: string,
  limit: number,
  offset: number,
): Promise<{ readonly rows: readonly RightsImportListRow[]; readonly total: number }> {
  const rows = await withNames(db, appId)
    .orderBy('r.created_at', 'desc')
    .orderBy('r.id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
  const count = await db
    .withSchema('app')
    .selectFrom('rights_imports')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('app_id', '=', appId)
    .executeTakeFirstOrThrow();
  return { rows, total: Number(count.n) };
}

export async function findRightsImportWithName(
  db: Kysely<DB>,
  appId: string,
  importId: string,
): Promise<RightsImportListRow | undefined> {
  return await withNames(db, appId).where('r.id', '=', importId).executeTakeFirst();
}

export async function listRightsImportFailures(
  db: Kysely<DB>,
  appId: string,
  importId: string,
): Promise<readonly { readonly row_no: number; readonly reason: string }[]> {
  return await db
    .withSchema('app')
    .selectFrom('rights_import_failures')
    .select(['row_no', 'reason'])
    .where('app_id', '=', appId)
    .where('import_id', '=', importId)
    .orderBy('row_no')
    .execute();
}
