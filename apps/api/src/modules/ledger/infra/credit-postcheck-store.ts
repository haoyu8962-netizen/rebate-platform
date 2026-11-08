// B2-02t: the read of the post-credit confirmation, from the ledger's own tables only. It runs on the
// transaction it is given and locks nothing (entries are insert only).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface CreditPostcheckEntryRow {
  readonly order_key: string | null;
  readonly amount_fen: bigint;
}

/** The entries of one voucher of the app on accounts of this subject, with the voucher's order. */
export async function readCreditPostcheckEntries(
  trx: Transaction<DB>,
  appId: string,
  voucherId: string,
  subject: string,
): Promise<readonly CreditPostcheckEntryRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_vouchers as v', 'v.id', 'e.voucher_id')
    .innerJoin('ledger_accounts as a', 'a.id', 'e.account_id')
    .select(['v.order_key', 'e.amount_fen'])
    .where('e.app_id', '=', appId)
    .where('v.app_id', '=', appId)
    .where('a.app_id', '=', appId)
    .where('e.voucher_id', '=', voucherId)
    .where('a.subject', '=', subject)
    .execute();
}
