// B2-02x: the reads of the balance cache recalculation (recalcBalanceAdminReconDiff) on the ledger
// tables. Every function runs on the handle it is given; none opens a transaction or takes a lock
// (the users row and the account_balances row are locked by the use case, in that order).
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { USER_SUBJECT } from './store.ts';

/** The owner (users.id) of the app's USER_BALANCE account `accountId`, or undefined. */
export async function userBalanceAccountOwner(
  trx: Transaction<DB>,
  appId: string,
  accountId: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('ledger_accounts')
    .select('owner_id')
    .where('app_id', '=', appId)
    .where('id', '=', accountId)
    .where('owner_type', '=', 'user')
    .where('subject', '=', USER_SUBJECT)
    .executeTakeFirst();
  return row?.owner_id;
}

/** The member-sign sums of one account's entries per sub-account (exact, possibly beyond bigint). */
export interface MemberEntrySums {
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
}

/**
 * 0 − Σ amount_fen of the account's entries, per sub-account (entries are stored debit positive,
 * credit negative; BR-FUND-16, the cache check of BR-FUND-19 ①). SUM over bigint is numeric in
 * PostgreSQL and the negation is numeric too, so nothing is rounded or wrapped; the result is
 * read as decimal text and parsed exactly.
 */
export async function memberEntrySums(
  trx: Transaction<DB>,
  appId: string,
  accountId: string,
): Promise<MemberEntrySums> {
  const result = await sql<{ available: string; frozen: string }>`
    SELECT
      (0 - COALESCE(SUM(amount_fen) FILTER (WHERE sub_account = 'available'), 0))::text
        AS available,
      (0 - COALESCE(SUM(amount_fen) FILTER (WHERE sub_account = 'frozen'), 0))::text AS frozen
    FROM app.ledger_entries
    WHERE app_id = ${appId} AND account_id = ${accountId}`.execute(trx);
  const row = result.rows[0];
  if (row === undefined) throw new Error('ledger: the entry sums returned no row');
  return { available_fen: decimal(row.available), frozen_fen: decimal(row.frozen) };
}

const INTEGER = /^-?[0-9]+$/;

function decimal(text: string): bigint {
  // A sum of bigint values is an integer; anything else is a broken read, never rounded here.
  if (!INTEGER.test(text)) throw new Error(`ledger: entry sum ${text} is not an integer`);
  return BigInt(text);
}
