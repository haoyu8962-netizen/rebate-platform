// B2-12f: ledger's reads and writes of app.bad_debt_writeoffs (04 §3.2; ledger is its single writer;
// BR-FUND-12) and the reads of its own account_balances / ledger_accounts the generation and the
// list need. Every query is scoped by app_id and runs on the handle it is given; none opens a
// transaction. Dates are YYYY-MM-DD text (to_char, DateStyle-independent), never a JS Date.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

type Executor = Kysely<DB> | Transaction<DB>;

/** A candidate row with its member (the user account's owner) and the balance as it is now. */
export interface BadDebtWriteoffRow {
  readonly id: string;
  readonly app_id: string;
  readonly account_id: string;
  readonly user_id: string;
  readonly negative_since: string;
  readonly candidate_fen: bigint;
  readonly status: string;
  readonly initiator_id: string | null;
  readonly approver_id: string | null;
  readonly approved_at: Date | null;
  readonly voucher_id: string | null;
  readonly created_at: Date;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
}

export interface BadDebtWriteoffFilter {
  readonly appId: string;
  readonly status: string | null;
  readonly userId: string | null;
}

function joined(db: Executor, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('bad_debt_writeoffs as w')
    .innerJoin('ledger_accounts as la', (join) =>
      join.onRef('la.app_id', '=', 'w.app_id').onRef('la.id', '=', 'w.account_id'),
    )
    .leftJoin('account_balances as ab', (join) =>
      join.onRef('ab.app_id', '=', 'w.app_id').onRef('ab.account_id', '=', 'w.account_id'),
    )
    .where('w.app_id', '=', appId);
}

function filtered(db: Executor, filter: BadDebtWriteoffFilter) {
  let query = joined(db, filter.appId);
  if (filter.status !== null) query = query.where('w.status', '=', filter.status);
  if (filter.userId !== null) query = query.where('la.owner_id', '=', filter.userId);
  return query;
}

function withColumns(query: ReturnType<typeof joined>) {
  return query
    .select([
      'w.id',
      'w.app_id',
      'w.account_id',
      'la.owner_id as user_id',
      'w.candidate_fen',
      'w.status',
      'w.initiator_id',
      'w.approver_id',
      'w.approved_at',
      'w.voucher_id',
      'w.created_at',
    ])
    .select(sql<string>`to_char(w.negative_since, 'YYYY-MM-DD')`.as('negative_since'))
    .select(sql<bigint>`COALESCE(ab.available_fen, 0::bigint)`.as('available_fen'))
    .select(sql<bigint>`COALESCE(ab.frozen_fen, 0::bigint)`.as('frozen_fen'));
}

/** The count of the filter set. */
export async function countBadDebtWriteoffs(
  db: Executor,
  filter: BadDebtWriteoffFilter,
): Promise<number> {
  const row = await filtered(db, filter)
    .select(sql<string>`count(*)::text`.as('n'))
    .executeTakeFirst();
  return Number(row?.n ?? '0');
}

/** One page, created_at then id descending (bad_debt_writeoffs_list_idx). */
export async function pageBadDebtWriteoffs(
  db: Executor,
  filter: BadDebtWriteoffFilter,
  offset: number,
  limit: number,
): Promise<BadDebtWriteoffRow[]> {
  const rows = await withColumns(filtered(db, filter))
    .orderBy('w.created_at', 'desc')
    .orderBy('w.id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
  return rows as BadDebtWriteoffRow[];
}

/** One candidate of the app with its member and balance (plain read), or undefined. */
export async function findBadDebtWriteoff(
  db: Executor,
  appId: string,
  id: string,
): Promise<BadDebtWriteoffRow | undefined> {
  const row = await withColumns(joined(db, appId)).where('w.id', '=', id).executeTakeFirst();
  return row as BadDebtWriteoffRow | undefined;
}

/** The candidate's own row FOR UPDATE (after the member's users and balance rows). */
export async function lockBadDebtWriteoffStatus(
  trx: Transaction<DB>,
  appId: string,
  id: string,
): Promise<string | undefined> {
  const row = await trx
    .withSchema('app')
    .selectFrom('bad_debt_writeoffs')
    .select('status')
    .where('app_id', '=', appId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  return row?.status;
}

/** BD3: PENDING → CANCELLED (no voucher, approver and approved_at stay null). */
export async function cancelBadDebtWriteoff(
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly id: string; readonly to: string },
): Promise<number> {
  const result = await trx
    .withSchema('app')
    .updateTable('bad_debt_writeoffs')
    .set((eb) => ({ status: input.to, row_version: eb('row_version', '+', 1) }))
    .where('app_id', '=', input.appId)
    .where('id', '=', input.id)
    .where('status', '=', 'PENDING')
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** BD2: PENDING → APPROVED with its approver, instant and BAD_DEBT_WRITEOFF voucher. */
export async function approveBadDebtWriteoffRow(
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly id: string;
    readonly to: string;
    readonly approverId: string;
    readonly at: Date;
    readonly voucherId: string;
  },
): Promise<number> {
  const result = await trx
    .withSchema('app')
    .updateTable('bad_debt_writeoffs')
    .set((eb) => ({
      status: input.to,
      approver_id: input.approverId,
      approved_at: input.at,
      voucher_id: input.voucherId,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', input.appId)
    .where('id', '=', input.id)
    .where('status', '=', 'PENDING')
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

// ---------------------------------------------------------------------------------------------
// The generation.

/** The apps that have at least one user ledger account. */
export async function appsWithUserAccounts(db: Kysely<DB>): Promise<string[]> {
  const rows = await db
    .withSchema('app')
    .selectFrom('ledger_accounts')
    .select('app_id')
    .distinct()
    .where('owner_type', '=', 'user')
    .orderBy('app_id')
    .execute();
  return rows.map((row) => row.app_id);
}

/** True when processed_events holds (consumer, eventId). */
export async function hasProcessedEvent(
  db: Kysely<DB>,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM app.processed_events
      WHERE consumer = ${consumer} AND event_id = ${eventId}::uuid
    ) AS found`.execute(db);
  return rows[0]?.found === true;
}

export interface NegativeBalanceRow {
  readonly account_id: string;
  readonly user_id: string;
  readonly available_fen: bigint;
  readonly negative_since: string;
}

/**
 * The app's user balances with available below 0, `day` − negative_since at least `days` (plain
 * date arithmetic on the given +08:00 accounting day, never the SQL clock),
 * available at most `availableAtMost` (−ledger.bad_debt_min_fen, computed by the caller with
 * @couli/money), and no PENDING candidate; by account_id.
 */
export async function negativeBalancesDue(
  db: Kysely<DB>,
  input: {
    readonly appId: string;
    readonly day: string;
    readonly days: number;
    readonly availableAtMost: bigint;
  },
): Promise<NegativeBalanceRow[]> {
  const { rows } = await sql<NegativeBalanceRow>`
    SELECT ab.account_id, la.owner_id AS user_id, ab.available_fen,
      to_char(ab.negative_since, 'YYYY-MM-DD') AS negative_since
    FROM app.account_balances ab
    JOIN app.ledger_accounts la ON la.app_id = ab.app_id AND la.id = ab.account_id
    WHERE ab.app_id = ${input.appId}
      AND la.owner_type = 'user' AND la.subject = 'USER_BALANCE'
      AND ab.available_fen < 0
      AND ab.negative_since IS NOT NULL
      AND (${input.day}::date - ab.negative_since) >= ${input.days}::int
      AND ab.available_fen <= ${input.availableAtMost}::bigint
      AND NOT EXISTS (
        SELECT 1 FROM app.bad_debt_writeoffs w
        WHERE w.app_id = ab.app_id AND w.account_id = ab.account_id AND w.status = 'PENDING'
      )
    ORDER BY ab.account_id`.execute(db);
  return rows;
}

/**
 * BD1: one PENDING candidate; false when the account already has one (the partial unique index
 * bad_debt_writeoffs_account_pending_key, ON CONFLICT DO NOTHING).
 */
export async function insertPendingWriteoff(
  db: Kysely<DB>,
  input: {
    readonly id: string;
    readonly appId: string;
    readonly accountId: string;
    readonly negativeSince: string;
    readonly candidateFen: bigint;
    readonly status: string;
    readonly at: Date;
  },
): Promise<boolean> {
  const result = await sql`
    INSERT INTO app.bad_debt_writeoffs
      (id, app_id, account_id, negative_since, candidate_fen, status, initiator_id, created_at)
    VALUES (${input.id}, ${input.appId}, ${input.accountId}, ${input.negativeSince}::date,
      ${input.candidateFen}::bigint, ${input.status}, NULL, ${input.at})
    ON CONFLICT (app_id, account_id) WHERE status = 'PENDING' DO NOTHING`.execute(db);
  return Number(result.numAffectedRows ?? 0n) === 1;
}
