// B2-09g: the recon diff side of POST /admin/v1/recon-diffs/{recon_diff_id}/restore (contracts/
// openapi.yaml restoreAdminReconDiff; 08 BR-FUND-22 ③). settlement orchestrates the restore on its
// own idempotent transaction; ledger stays the single writer of recon_diffs. The first read names
// the order key the restore locks first, and takes no lock; the row is locked after that lock.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  findAdminReconDiff,
  lockAdminReconDiff,
  restoreAdminReconDiffRow,
} from '../infra/recon-diffs-store.ts';
import { UUID, detailView } from './admin-recon-diffs.ts';

/** What the restore judges a difference by. */
export interface ReconDiffRestoreRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  /** B2-09gb: a platform_restore difference names its order through ref_type order and ref_id. */
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly resolution: unknown;
  /**
   * B2-04zzr (BR-FUND-22 处理时再核): the registration instant; a successful INVALID_AFTER_SETTLE
   * record at or after it means the platform invalidated the order again.
   */
  readonly created_at: Date;
}

export interface ReconDiffRestoreInput {
  readonly appId: string;
  readonly id: string;
  readonly handlerId: string;
  readonly at: Date;
  /** The stored keys plus restore and the trimmed note. */
  readonly resolution: object;
}

/** The app's R1–R3 difference of this id, not locked (undefined for any other, or not a uuid). */
export async function readReconDiffForRestore(
  trx: Transaction<DB>,
  appId: string,
  reconDiffId: string,
): Promise<ReconDiffRestoreRow | undefined> {
  if (!UUID.test(reconDiffId)) return undefined;
  return findAdminReconDiff(trx, appId, reconDiffId.toLowerCase());
}

/** The same row FOR UPDATE on `trx`. */
export function lockReconDiffForRestore(
  trx: Transaction<DB>,
  appId: string,
  id: string,
): Promise<ReconDiffRestoreRow | undefined> {
  return lockAdminReconDiff(trx, appId, id);
}

/**
 * open / processing → adjusted (handler_id the operator, closed_at = updated_at = `at`; the three
 * amounts stay as registered). The detail as GET returns it, undefined when the row left those
 * statuses.
 */
export async function adjustRestoredReconDiff(
  trx: Transaction<DB>,
  input: ReconDiffRestoreInput,
): Promise<Schema<'AdminReconDiffDetail'> | undefined> {
  const row = await restoreAdminReconDiffRow(trx, input);
  return row === undefined ? undefined : detailView(row);
}
