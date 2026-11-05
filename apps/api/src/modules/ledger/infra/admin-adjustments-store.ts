// B2-12c: ledger's reads and writes of app.admin_adjustments (04 §3.2; ledger is its single writer)
// and the read of its own app.recon_diffs for the linked differences of a manual adjustment.
// Every query is scoped by app_id. `reversed_by` is derived from the reversal row (unique on
// (app_id, reverses_adjust_id)); the original row is never updated by a reversal.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

export type AdminAdjustmentRow = Selectable<DB['admin_adjustments']>;
export type AdminAdjustmentRowWithReversal = AdminAdjustmentRow & {
  readonly reversed_by: string | null;
};

type Executor = Kysely<DB> | Transaction<DB>;

export interface AdminAdjustmentFilter {
  readonly appId: string;
  readonly reasonCode: string | null;
  readonly status: string | null;
  readonly userId: string | null;
}

function filtered(db: Executor, filter: AdminAdjustmentFilter) {
  let query = db
    .withSchema('app')
    .selectFrom('admin_adjustments as a')
    .where('a.app_id', '=', filter.appId);
  if (filter.reasonCode !== null) query = query.where('a.reason_code', '=', filter.reasonCode);
  if (filter.status !== null) query = query.where('a.status', '=', filter.status);
  if (filter.userId !== null) query = query.where('a.user_id', '=', filter.userId);
  return query;
}

/** The reversal of each row (null when none), as a correlated subquery. */
function withReversal(db: Executor, filter: AdminAdjustmentFilter) {
  return filtered(db, filter)
    .selectAll('a')
    .select((eb) =>
      eb
        .selectFrom('admin_adjustments as r')
        .select('r.adjust_id')
        .whereRef('r.app_id', '=', 'a.app_id')
        .whereRef('r.reverses_adjust_id', '=', 'a.adjust_id')
        .limit(1)
        .as('reversed_by'),
    );
}

export async function countAdminAdjustments(
  db: Executor,
  filter: AdminAdjustmentFilter,
): Promise<number> {
  const row = await filtered(db, filter)
    .select(sql<string>`count(*)::text`.as('n'))
    .executeTakeFirst();
  return Number(row?.n ?? '0');
}

/** One page, created_at then adjust_id descending (admin_adjustments_list_idx). */
export async function pageAdminAdjustments(
  db: Executor,
  filter: AdminAdjustmentFilter,
  offset: number,
  limit: number,
): Promise<AdminAdjustmentRowWithReversal[]> {
  const rows = await withReversal(db, filter)
    .orderBy('a.created_at', 'desc')
    .orderBy('a.adjust_id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
  return rows as AdminAdjustmentRowWithReversal[];
}

/** One form of the app with its reversal (undefined when none). */
export async function findAdminAdjustment(
  db: Executor,
  appId: string,
  adjustId: string,
): Promise<AdminAdjustmentRowWithReversal | undefined> {
  const row = await withReversal(db, { appId, reasonCode: null, status: null, userId: null })
    .where('a.adjust_id', '=', adjustId)
    .executeTakeFirst();
  return row as AdminAdjustmentRowWithReversal | undefined;
}

/** The reversal of `adjustId` already written (read on the caller's transaction). */
export async function findReversalOf(
  trx: Executor,
  appId: string,
  adjustId: string,
): Promise<string | undefined> {
  const row = await trx
    .withSchema('app')
    .selectFrom('admin_adjustments')
    .select('adjust_id')
    .where('app_id', '=', appId)
    .where('reverses_adjust_id', '=', adjustId)
    .executeTakeFirst();
  return row?.adjust_id;
}

export interface AdminAdjustmentInsert {
  readonly adjustId: string;
  readonly appId: string;
  readonly userId: string;
  readonly direction: 'increase' | 'decrease';
  readonly amountFen: bigint;
  readonly reasonCode: string;
  readonly refs: readonly { readonly ref_type: string; readonly ref_id: string }[];
  readonly contraSubject: string;
  readonly contraPlatform: string | null;
  readonly note: string | null;
  readonly reversesAdjustId: string | null;
  readonly adminId: string;
  readonly at: Date;
  readonly voucherId: string;
}

/** The executed form, born APPROVED with the caller as filer and reviewer. */
export async function insertApprovedAdjustment(
  trx: Transaction<DB>,
  input: AdminAdjustmentInsert,
): Promise<AdminAdjustmentRow> {
  return trx
    .withSchema('app')
    .insertInto('admin_adjustments')
    .values({
      adjust_id: input.adjustId,
      app_id: input.appId,
      user_id: input.userId,
      direction: input.direction,
      amount_fen: input.amountFen,
      reason_code: input.reasonCode,
      refs: JSON.stringify(
        input.refs.map((ref) => ({ ref_type: ref.ref_type, ref_id: ref.ref_id })),
      ),
      contra_subject: input.contraSubject,
      contra_platform: input.contraPlatform,
      note: input.note,
      status: 'APPROVED',
      reverses_adjust_id: input.reversesAdjustId,
      created_by: input.adminId,
      created_at: input.at,
      reviewed_by: input.adminId,
      reviewed_at: input.at,
      reject_note: null,
      voucher_id: input.voucherId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The app's recon differences among `ids` with their source (non-uuid IDs are skipped). */
export async function readReconDiffSources(
  trx: Executor,
  appId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const rows = await trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .select(['id', 'source'])
    .where('app_id', '=', appId)
    .where('id', '=', sql<string>`ANY(${ids}::uuid[])`)
    .execute();
  for (const row of rows) result.set(row.id, row.source);
  return result;
}
