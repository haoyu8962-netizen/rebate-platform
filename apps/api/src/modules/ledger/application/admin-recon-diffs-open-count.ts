// B2-02w (D10-1401): the dashboard card recon_diff_open's per-app count, read only. It is the total
// of listAdminReconDiffs filtered by status=open and nothing else: the same filter builder and the
// same store count, so the card cannot disagree with its list page (R1–R3 only, open only —
// processing and the closed statuses excluded —, never another app's rows, no paging limit).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { countAdminReconDiffs } from '../infra/recon-diffs-store.ts';
import { reconDiffListFilter } from './admin-recon-diffs.ts';

/** The app's open R1–R3 recon diffs: the total of listAdminReconDiffs filtered by status=open. */
export function countReconDiffOpen(db: Kysely<DB>, appId: string): Promise<number> {
  return countAdminReconDiffs(db, reconDiffListFilter(appId, { status: 'open' }));
}
