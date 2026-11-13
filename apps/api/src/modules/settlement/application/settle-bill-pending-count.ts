import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** B2-09zm: same-app awaiting_confirm=true list total, read only and independent of time. */
export async function countSettleBillPending(db: Kysely<DB>, appId: string): Promise<number> {
  void db;
  void appId;
  throw new Error('NotImplemented: countSettleBillPending');
}
