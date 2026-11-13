import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The app's open R1–R3 recon diffs: the total of listAdminReconDiffs filtered by status=open. */
export function countReconDiffOpen(db: Kysely<DB>, appId: string): Promise<number> {
  void db;
  void appId;
  throw new Error('NotImplemented: countReconDiffOpen');
}
