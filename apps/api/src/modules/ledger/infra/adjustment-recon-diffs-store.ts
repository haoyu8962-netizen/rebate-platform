// B2-17 (08 BR-FUND-24 ⑨, 细则「对外差错单的调账」; migration 0156): ledger's SQL of
// app.adjustment_recon_diffs — one row per (executed manual adjustment, linked recon diff), the
// member of the form, reversed_by_adjust_id empty while the form stands — and the recon_diffs locks
// and status writes a manual adjustment and its reversal take. ledger is the single writer of both
// tables. Every statement is scoped by app_id and runs on the transaction it is given; the writes
// are plain INSERT / UPDATE statements (Kysely insertInto / updateTable).
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import {
  adjustReconDiffForAdjustment,
  lockReconDiffsForAdjustment,
  processReconDiffForAdjustment,
  sendBackReconDiffForReversal,
  type LockedReconDiff,
} from './recon-diffs-store.ts';

export type { LockedReconDiff } from './recon-diffs-store.ts';

export interface AdjustmentReconLinkInsert {
  readonly appId: string;
  readonly adjustId: string;
  readonly reconDiffId: string;
  readonly userId: string;
  readonly at: Date;
}

/**
 * What the submission of a manual adjustment needs of the two tables (B2-17). An interface so the
 * unit tests can stand in for the database; production uses `adjustmentReconStore`.
 */
export interface AdjustmentReconStore {
  /** The app's recon diffs among `ids`, each row locked FOR UPDATE in ascending id order. */
  lockDiffs(
    trx: Transaction<DB>,
    appId: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, LockedReconDiff>>;
  /** Per diff among `diffIds`: the members with an unreversed link row. */
  activeLinks(
    trx: Transaction<DB>,
    appId: string,
    diffIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /** The diffs the form has unreversed link rows to (plain read, no lock), ascending. */
  linkedDiffIds(trx: Transaction<DB>, appId: string, adjustId: string): Promise<string[]>;
  insertLink(trx: Transaction<DB>, row: AdjustmentReconLinkInsert): Promise<void>;
  /** open / processing → adjusted; false when the row was in neither. */
  markAdjusted(
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly id: string;
      readonly handlerId: string;
      readonly at: Date;
    },
  ): Promise<boolean>;
  /** open → processing; false when the row was not open. */
  markProcessing(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly id: string; readonly at: Date },
  ): Promise<boolean>;
  /** Writes reversed_by_adjust_id on the form's unreversed link rows; their diff ids, ascending. */
  markLinksReversed(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly adjustId: string; readonly reversalId: string },
  ): Promise<string[]>;
  /** adjusted → processing unless ⑯ keeps it adjusted; false when nothing was written. */
  sendBack(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly id: string; readonly at: Date },
  ): Promise<boolean>;
}

export async function selectActiveLinks(
  trx: Transaction<DB>,
  appId: string,
  diffIds: readonly string[],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const result = new Map<string, Set<string>>();
  if (diffIds.length === 0) return result;
  const rows = await trx
    .withSchema('app')
    .selectFrom('adjustment_recon_diffs')
    .select(['recon_diff_id', 'user_id'])
    .where('app_id', '=', appId)
    .where('recon_diff_id', '=', sql<string>`ANY(${diffIds}::uuid[])`)
    .where('reversed_by_adjust_id', 'is', null)
    .execute();
  for (const row of rows) {
    const id = row.recon_diff_id.toLowerCase();
    let users = result.get(id);
    if (users === undefined) {
      users = new Set<string>();
      result.set(id, users);
    }
    users.add(row.user_id.toLowerCase());
  }
  return result;
}

export async function selectLinkedDiffIds(
  trx: Transaction<DB>,
  appId: string,
  adjustId: string,
): Promise<string[]> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('adjustment_recon_diffs')
    .select('recon_diff_id')
    .where('app_id', '=', appId)
    .where('adjust_id', '=', adjustId)
    .where('reversed_by_adjust_id', 'is', null)
    .orderBy('recon_diff_id')
    .execute();
  return rows.map((row) => row.recon_diff_id.toLowerCase());
}

export async function insertAdjustmentReconLink(
  trx: Transaction<DB>,
  row: AdjustmentReconLinkInsert,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('adjustment_recon_diffs')
    .values({
      app_id: row.appId,
      adjust_id: row.adjustId,
      recon_diff_id: row.reconDiffId,
      user_id: row.userId,
      reversed_by_adjust_id: null,
      created_at: row.at,
    })
    .execute();
}

export async function markAdjustmentLinksReversed(
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly adjustId: string; readonly reversalId: string },
): Promise<string[]> {
  const rows = await trx
    .withSchema('app')
    .updateTable('adjustment_recon_diffs')
    .set({ reversed_by_adjust_id: input.reversalId })
    .where('app_id', '=', input.appId)
    .where('adjust_id', '=', input.adjustId)
    .where('reversed_by_adjust_id', 'is', null)
    .returning('recon_diff_id')
    .execute();
  return rows.map((row) => row.recon_diff_id.toLowerCase()).sort();
}

export const adjustmentReconStore: AdjustmentReconStore = {
  lockDiffs: lockReconDiffsForAdjustment,
  activeLinks: selectActiveLinks,
  linkedDiffIds: selectLinkedDiffIds,
  insertLink: insertAdjustmentReconLink,
  markAdjusted: async (trx, input) => (await adjustReconDiffForAdjustment(trx, input)) > 0,
  markProcessing: async (trx, input) => (await processReconDiffForAdjustment(trx, input)) > 0,
  markLinksReversed: markAdjustmentLinksReversed,
  sendBack: async (trx, input) => (await sendBackReconDiffForReversal(trx, input)) > 0,
};
