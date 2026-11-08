// B2-02u: the ledger's own reads behind adminGetUserFundSummary and adminListLedgerEntries
// (account_balances, ledger_accounts, ledger_entries ⋈ ledger_vouchers). Read only on the caller's
// handle: plain SELECTs, no lock, no write, no SQL clock. The voucher's memo and operator are never
// selected, so no internal note can reach an answer.
import type { DB } from '@couli/db';
import { parseFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { USER_SUBJECT } from './store.ts';

/** The user's account_balances row, or null without a ledger account. */
export interface AdminBalanceRow {
  readonly availableFen: bigint;
  readonly frozenFen: bigint;
  /** YYYY-MM-DD or null. */
  readonly negativeSince: string | null;
}

/** One entry of the user's USER_BALANCE account with its voucher (memo and operator never read). */
export interface AdminEntryRow {
  readonly entryId: string;
  readonly bookedAt: Date;
  /** The voucher's accounting date, YYYY-MM-DD. */
  readonly accountingDate: string;
  readonly ledgerType: string;
  readonly subType: string | null;
  readonly subAccount: 'available' | 'frozen';
  /** As stored: debit positive. */
  readonly amountFen: bigint;
  readonly balanceAfterFen: bigint | null;
  readonly voucherId: string;
  readonly uniqKey: string;
  readonly bizType: string;
  readonly bizId: string;
}

export interface AdminEntryFilter {
  readonly appId: string;
  readonly userId: string;
  readonly ledgerType?: string;
  readonly subType?: string;
  readonly subAccount?: 'available' | 'frozen';
  readonly accountingDateFrom?: string;
  readonly accountingDateTo?: string;
  readonly ref?: string;
}

export async function readAdminBalance(
  handle: Kysely<DB>,
  input: { readonly appId: string; readonly userId: string },
): Promise<AdminBalanceRow | null> {
  const row = await handle
    .withSchema('app')
    .selectFrom('account_balances as ab')
    .innerJoin('ledger_accounts as la', (join) =>
      join.onRef('la.app_id', '=', 'ab.app_id').onRef('la.id', '=', 'ab.account_id'),
    )
    .select([
      sql<string>`ab.available_fen::text`.as('available_fen'),
      sql<string>`ab.frozen_fen::text`.as('frozen_fen'),
      // DateStyle-independent YYYY-MM-DD (a +08:00 accounting date, never a JS Date).
      sql<string | null>`to_char(ab.negative_since, 'YYYY-MM-DD')`.as('negative_since'),
    ])
    .where('ab.app_id', '=', input.appId)
    .where('la.app_id', '=', input.appId)
    .where('la.owner_type', '=', 'user')
    .where('la.owner_id', '=', input.userId)
    .where('la.subject', '=', USER_SUBJECT)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    availableFen: parseFen(row.available_fen),
    frozenFen: parseFen(row.frozen_fen),
    negativeSince: row.negative_since,
  };
}

/** The entries of the user's balance account matching the filter (no order, no slice). */
function matching(handle: Kysely<DB>, filter: AdminEntryFilter) {
  let query = handle
    .withSchema('app')
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.app_id', '=', 'e.app_id').onRef('a.id', '=', 'e.account_id'),
    )
    .innerJoin('ledger_vouchers as v', (join) =>
      join.onRef('v.app_id', '=', 'e.app_id').onRef('v.id', '=', 'e.voucher_id'),
    )
    .where('a.app_id', '=', filter.appId)
    .where('a.owner_type', '=', 'user')
    .where('a.owner_id', '=', filter.userId)
    .where('a.subject', '=', USER_SUBJECT)
    .where('e.app_id', '=', filter.appId)
    .where('v.app_id', '=', filter.appId);
  if (filter.ledgerType !== undefined) query = query.where('e.ledger_type', '=', filter.ledgerType);
  if (filter.subType !== undefined) query = query.where('e.sub_type', '=', filter.subType);
  if (filter.subAccount !== undefined) {
    query = query.where('e.sub_account', '=', filter.subAccount);
  }
  if (filter.accountingDateFrom !== undefined) {
    query = query.where(sql<boolean>`v.accounting_date >= ${filter.accountingDateFrom}::date`);
  }
  if (filter.accountingDateTo !== undefined) {
    query = query.where(sql<boolean>`v.accounting_date <= ${filter.accountingDateTo}::date`);
  }
  if (filter.ref !== undefined) query = query.where('v.biz_id', '=', filter.ref);
  return query;
}

function subAccountOf(value: string): 'available' | 'frozen' {
  if (value === 'available' || value === 'frozen') return value;
  throw new Error('ledger: unexpected sub_account in admin ledger read');
}

/** The filtered entries, booked_at then entry id descending, `limit` from `offset`. */
export async function readAdminEntries(
  handle: Kysely<DB>,
  filter: AdminEntryFilter,
  slice: { readonly offset: number; readonly limit: number },
): Promise<readonly AdminEntryRow[]> {
  const rows = await matching(handle, filter)
    .select([
      sql<string>`e.id::text`.as('entry_id'),
      'e.booked_at',
      sql<string>`to_char(v.accounting_date, 'YYYY-MM-DD')`.as('accounting_date'),
      'e.ledger_type',
      'e.sub_type',
      'e.sub_account',
      sql<string>`e.amount_fen::text`.as('amount_fen'),
      sql<string | null>`e.balance_after_fen::text`.as('balance_after_fen'),
      sql<string>`v.id::text`.as('voucher_id'),
      'v.uniq_key',
      'v.biz_type',
      'v.biz_id',
    ])
    .orderBy('e.booked_at', 'desc')
    .orderBy('e.id', 'desc')
    .offset(slice.offset)
    .limit(slice.limit)
    .execute();
  return rows.map((row) => ({
    entryId: row.entry_id,
    bookedAt: row.booked_at,
    accountingDate: row.accounting_date,
    ledgerType: row.ledger_type,
    subType: row.sub_type,
    subAccount: subAccountOf(row.sub_account),
    amountFen: parseFen(row.amount_fen),
    balanceAfterFen: row.balance_after_fen === null ? null : parseFen(row.balance_after_fen),
    voucherId: row.voucher_id,
    uniqKey: row.uniq_key,
    bizType: row.biz_type,
    bizId: row.biz_id,
  }));
}

/** How many entries the filter matches. */
export async function countAdminEntries(
  handle: Kysely<DB>,
  filter: AdminEntryFilter,
): Promise<number> {
  const row = await matching(handle, filter)
    .select(sql<string>`count(*)::text`.as('total'))
    .executeTakeFirstOrThrow();
  const total = Number(row.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('ledger: admin ledger count out of range');
  }
  return total;
}
