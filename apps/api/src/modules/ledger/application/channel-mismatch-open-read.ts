// B2-09zn (D10-3308, D10-3360): ledger's read-only port behind the worker's
// couli_payout_recon_diff_open gauge. Counts, per app_id, the recon_diffs rows of type
// channel_mismatch (the payout channel reconciliation's diffs) that are not resolved yet: status open
// or processing. source, ref_type and ref_id are not looked at. The type is compared for equality
// with channel_mismatch only: the collection side's pay_mismatch and pay_anomaly, and every other
// type, never count. An app without such a row has no key (never 0).
//
// Only a SELECT on the handle it is given: no transaction of its own, no lock, no database clock, no
// cache here. A failed read rejects with its own error, it is never turned into 0 (the scrape fails
// visibly).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

/** The one recon_diffs type this gauge counts. */
const CHANNEL_MISMATCH = 'channel_mismatch';

export interface ChannelMismatchOpen {
  /** app_id → unresolved (open or processing) channel_mismatch diffs; an app without any has no key. */
  readonly open: Readonly<Record<string, number>>;
}

export async function readChannelMismatchOpen(db: Kysely<DB>): Promise<ChannelMismatchOpen> {
  const rows = await db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .select(['app_id', sql<number>`count(*)::integer`.as('open')])
    .where('type', '=', CHANNEL_MISMATCH)
    .where('status', 'in', ['open', 'processing'])
    .groupBy('app_id')
    .execute();
  const open: Record<string, number> = {};
  for (const row of rows) open[row.app_id] = Number(row.open);
  return { open };
}
