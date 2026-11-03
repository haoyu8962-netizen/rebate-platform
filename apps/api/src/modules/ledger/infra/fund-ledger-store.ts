// B2-04zs: the fund ledger overview's sums over all the entries posted so far, with no accounting-
// day cut (the asset snapshot's sums in asset-snapshot-store.ts cut at D, so they cannot serve this).
// Entries are debit-positive: a receivable's balance is Σ amount_fen, and a member's available
// balance is −Σ amount_fen, so a positive Σ is a negative balance.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

const RECEIVABLE_PREFIX = 'UNION_RECEIVABLE:';

export interface FundLedgerReceivable {
  readonly platform: string;
  readonly union_receivable_fen: bigint;
}

export interface FundLedgerNegative {
  readonly negative_total_fen: bigint;
  readonly negative_user_count: number;
}

/** One row per platform with at least one entry, in platform order; an over-collected net stays. */
export async function sumAllReceivables(
  trx: Transaction<DB>,
  appId: string,
): Promise<FundLedgerReceivable[]> {
  const result = await sql<{ platform: string; union_receivable_fen: string | bigint }>`
    SELECT
      substr(a.subject, ${RECEIVABLE_PREFIX.length + 1}) AS platform,
      sum(e.amount_fen)::bigint AS union_receivable_fen
    FROM app.ledger_entries e
    JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
    WHERE e.app_id = ${appId}
      AND a.owner_type = 'platform'
      AND starts_with(a.subject, ${RECEIVABLE_PREFIX})
    GROUP BY a.subject
    ORDER BY platform
  `.execute(trx);
  return result.rows.map((row) => ({
    platform: row.platform,
    union_receivable_fen: BigInt(row.union_receivable_fen),
  }));
}

/** The magnitudes of the negative available balances and how many accounts are behind them. */
export async function sumAllNegativeBalances(
  trx: Transaction<DB>,
  appId: string,
): Promise<FundLedgerNegative> {
  const result = await sql<{ total: string | bigint; accounts: number }>`
    WITH per_account AS (
      SELECT e.account_id, sum(e.amount_fen) AS available_net
      FROM app.ledger_entries e
      JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
      WHERE e.app_id = ${appId}
        AND a.owner_type = 'user'
        AND a.subject = 'USER_BALANCE'
        AND e.sub_account = 'available'
      GROUP BY e.account_id
    )
    SELECT
      COALESCE(sum(available_net) FILTER (WHERE available_net > 0), 0)::bigint AS total,
      (count(*) FILTER (WHERE available_net > 0))::int AS accounts
    FROM per_account
  `.execute(trx);
  const row = result.rows[0];
  if (row === undefined) throw new Error('fund ledger negative balance query returned no row');
  return { negative_total_fen: BigInt(row.total), negative_user_count: row.accounts };
}
