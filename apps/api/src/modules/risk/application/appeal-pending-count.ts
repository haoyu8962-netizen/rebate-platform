import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/**
 * B1-03zo / BR-ID-36: this app's processing appeals, equal to the console list's
 * status=processing total. The dashboard caller checks risk.appeal.
 * Implementation must share the app/status predicate with list and counts.processing;
 * no target-type or deadline restriction. Use appeals_processing_deadline_idx.
 */
export function countProcessingAppeals(db: Kysely<DB>, appId: string): Promise<number> {
  void db;
  void appId;
  throw new Error('NotImplemented: countProcessingAppeals');
}
