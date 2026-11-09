// B2-02v (BR-FUND-19 末句; D10-1038, D10-1180, D10-1185): ledger's read-only port behind the worker's
// couli_credit_postcheck_mismatch_open gauge. Counts, per app_id, the recon_diffs rows the post-credit
// confirmation registered (B2-02t) that are not resolved yet: type ledger_mismatch, status open or
// processing, ref_type voucher and a ref_id starting with `credit_postcheck:`. The daily check's
// ledger_mismatch rows have other ref_ids and do not count. An app without such a row has no key
// (never 0).
//
// The prefix is compared with starts_with, not LIKE: the `_` in it would be a wildcard. Reads on the
// handle it is given. No cache here and no transaction of its own. A failed read rejects with its
// own error, it is never turned into 0 (the scrape fails visibly).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

const REF_ID_PREFIX = 'credit_postcheck:';

export interface CreditPostcheckOpen {
  /** app_id → unresolved (open or processing) post-credit confirmation diffs; an app without any has no key. */
  readonly open: Readonly<Record<string, number>>;
}

export async function readCreditPostcheckOpen(db: Kysely<DB>): Promise<CreditPostcheckOpen> {
  const rows = await db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .select(['app_id', sql<number>`count(*)::integer`.as('open')])
    .where('type', '=', 'ledger_mismatch')
    .where('status', 'in', ['open', 'processing'])
    .where('ref_type', '=', 'voucher')
    .where(sql<boolean>`starts_with(ref_id, ${REF_ID_PREFIX})`)
    .groupBy('app_id')
    .execute();
  const open: Record<string, number> = {};
  for (const row of rows) open[row.app_id] = Number(row.open);
  return { open };
}
