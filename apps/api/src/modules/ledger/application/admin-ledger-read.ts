// B2-02u: GET /admin/v1/users/{user_id}/fund-summary (adminGetUserFundSummary) and
// GET /admin/v1/ledger (adminListLedgerEntries); CT-24zzc; 08 BR-FUND-13, 15, 16, 18; D10-1057.
// Read only, fund.view or user.lookup, the same shape and values for both points, no internal notes.
//
// - Balance card: available_fen / frozen_fen / negative_since from the account_balances row (0 / 0 /
//   null without an account); withdrawn_fen and the holds in effect through payout's ports; the
//   user must be a user of the console's app (identity's port), else 20001 [user_id].
// - Ledger: the entries of the user's USER_BALANCE account (both sub-accounts) ⋈ ledger_vouchers,
//   booked_at then entry_id descending, amount_fen negated to the user's view, link by biz_type,
//   filters and page / page_size (≤ 200) / total.
// Everything of one answer is read on one read-only REPEATABLE READ transaction; nothing is written.
// CT-24zzm (D10-1740 / D10-1742): readAdminLedgerExportPage is the admin export's read of the same
// list — the same filters, checks, order and item values (entryView), walked by keyset instead of
// offset so that pages of entries sharing one booked_at neither repeat nor skip an entry.
import { ledger_type, withdraw_hold_kind, type Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import {
  countAdminEntries,
  readAdminBalance,
  readAdminEntries,
  readAdminEntriesAfter,
  type AdminEntryFilter,
  type AdminEntryKeyset,
  type AdminEntryRow,
} from '../infra/admin-ledger-read-store.ts';

export type AdminLedgerHoldKind = Schema<'AdminWithdrawHoldKind'>;

/** Foreign data comes through owner-module ports (app.module wires them), never by table access. */
export interface AdminLedgerReadPorts {
  /** identity: whether the user is a user of this app. */
  userExists(
    handle: Kysely<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<boolean>;
  /** payout: Σ amount_fen of the user's PAID_API / PAID_MANUAL withdrawals (BR-FUND-18). */
  withdrawnFen(
    handle: Kysely<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<bigint>;
  /** payout: the kinds of the user's holds in effect at `now` (not released, not expired). */
  holdKindsInEffect(
    handle: Kysely<DB>,
    input: { readonly appId: string; readonly userId: string; readonly now: Date },
  ): Promise<readonly AdminLedgerHoldKind[]>;
}

export interface AdminLedgerReadDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly ports: AdminLedgerReadPorts;
}

export interface AdminLedgerEntriesQuery {
  readonly appId: string;
  readonly userId: string;
  readonly ledgerType?: Schema<'AdminLedgerType'>;
  readonly subType?: string;
  readonly subAccount?: Schema<'AdminLedgerSubAccount'>;
  /** YYYY-MM-DD, inclusive, on the voucher's accounting date. */
  readonly accountingDateFrom?: string;
  readonly accountingDateTo?: string;
  /** Exact voucher biz_id. */
  readonly ref?: string;
  readonly page: number;
  readonly pageSize: number;
}

/** A refusal: 20001 with data.fields (thrown for the controller's error envelope). */
export class AdminLedgerReadFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`admin ledger read refused: ${fields.join(',')}`);
    this.name = 'AdminLedgerReadFieldsError';
    this.fields = fields;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const SUB_ACCOUNTS: readonly string[] = ['available', 'frozen'];
const LEDGER_TYPES: readonly string[] = ledger_type;

/** Runs on one read-only REPEATABLE READ transaction (or the caller's transaction). */
function readOnly<T>(db: Kysely<DB>, run: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return run(db);
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute((trx: Transaction<DB>) => run(trx));
}

/** The canonical (lower-case) user id, or 20001 [user_id] when it is not a UUID. */
function userIdOf(raw: string): string {
  if (!UUID.test(raw)) throw new AdminLedgerReadFieldsError(['user_id']);
  return raw.toLowerCase();
}

async function requireUser(
  deps: AdminLedgerReadDeps,
  trx: Kysely<DB>,
  who: { readonly appId: string; readonly userId: string },
): Promise<void> {
  if (!(await deps.ports.userExists(trx, who))) {
    throw new AdminLedgerReadFieldsError(['user_id']);
  }
}

/** The distinct kinds, in withdraw_hold_kind enum order. */
function orderedKinds(kinds: readonly AdminLedgerHoldKind[]): AdminLedgerHoldKind[] {
  const present = new Set<string>(kinds);
  return withdraw_hold_kind.filter((kind) => present.has(kind));
}

/** The balance card of one user of the console's app. */
export async function getAdminUserFundSummary(
  deps: AdminLedgerReadDeps,
  input: { readonly appId: string; readonly userId: string },
): Promise<Schema<'AdminUserFundSummary'>> {
  const who = { appId: input.appId, userId: userIdOf(input.userId) };
  const now = deps.clock.now();
  const read = await readOnly(deps.db, async (trx) => {
    await requireUser(deps, trx, who);
    const balance = await readAdminBalance(trx, who);
    const withdrawn = await deps.ports.withdrawnFen(trx, who);
    const kinds = await deps.ports.holdKindsInEffect(trx, { ...who, now });
    return { balance, withdrawn, kinds };
  });
  // A user without a ledger account has the zero balance every account starts with (BR-FUND-13).
  const holdKinds = orderedKinds(read.kinds);
  return {
    user_id: who.userId,
    available_fen: fenToJsonNumber(read.balance?.availableFen ?? 0n),
    frozen_fen: fenToJsonNumber(read.balance?.frozenFen ?? 0n),
    negative_since: read.balance?.negativeSince ?? null,
    withdrawn_fen: fenToJsonNumber(read.withdrawn),
    withdraw_block: { blocked: holdKinds.length > 0, hold_kinds: holdKinds },
  };
}

/** The query of the controller's validated parameters (absent page / page_size: 1 / 20). */
export function adminLedgerQueryOf(
  appId: string,
  raw: {
    readonly user_id?: string;
    readonly ledger_type?: string;
    readonly sub_type?: string;
    readonly sub_account?: string;
    readonly accounting_date_from?: string;
    readonly accounting_date_to?: string;
    readonly ref?: string;
    readonly page?: number;
    readonly page_size?: number;
  },
): AdminLedgerEntriesQuery {
  if (raw.ledger_type !== undefined && !LEDGER_TYPES.includes(raw.ledger_type)) {
    throw new AdminLedgerReadFieldsError(['ledger_type']);
  }
  if (raw.sub_account !== undefined && !SUB_ACCOUNTS.includes(raw.sub_account)) {
    throw new AdminLedgerReadFieldsError(['sub_account']);
  }
  return {
    appId,
    userId: raw.user_id ?? '',
    ...(raw.ledger_type === undefined
      ? {}
      : { ledgerType: raw.ledger_type as Schema<'AdminLedgerType'> }),
    ...(raw.sub_type === undefined ? {} : { subType: raw.sub_type }),
    ...(raw.sub_account === undefined
      ? {}
      : { subAccount: raw.sub_account as Schema<'AdminLedgerSubAccount'> }),
    ...(raw.accounting_date_from === undefined
      ? {}
      : { accountingDateFrom: raw.accounting_date_from }),
    ...(raw.accounting_date_to === undefined ? {} : { accountingDateTo: raw.accounting_date_to }),
    ...(raw.ref === undefined ? {} : { ref: raw.ref }),
    page: raw.page ?? DEFAULT_PAGE,
    pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
  };
}

function checkedFilter(query: AdminLedgerEntriesQuery): AdminEntryFilter {
  const userId = userIdOf(query.userId);
  if (!Number.isSafeInteger(query.pageSize) || query.pageSize < 1) {
    throw new AdminLedgerReadFieldsError(['page_size']);
  }
  if (query.pageSize > MAX_PAGE_SIZE) throw new AdminLedgerReadFieldsError(['page_size']);
  if (!Number.isSafeInteger(query.page) || query.page < 1) {
    throw new AdminLedgerReadFieldsError(['page']);
  }
  const from = query.accountingDateFrom;
  const to = query.accountingDateTo;
  if (from !== undefined && !DAY.test(from)) {
    throw new AdminLedgerReadFieldsError(['accounting_date_from']);
  }
  if (to !== undefined && !DAY.test(to)) {
    throw new AdminLedgerReadFieldsError(['accounting_date_to']);
  }
  // Both are YYYY-MM-DD, so the text order is the date order.
  if (from !== undefined && to !== undefined && from > to) {
    throw new AdminLedgerReadFieldsError(['accounting_date_from', 'accounting_date_to']);
  }
  return {
    appId: query.appId,
    userId,
    ...(query.ledgerType === undefined ? {} : { ledgerType: query.ledgerType }),
    ...(query.subType === undefined ? {} : { subType: query.subType }),
    ...(query.subAccount === undefined ? {} : { subAccount: query.subAccount }),
    ...(from === undefined ? {} : { accountingDateFrom: from }),
    ...(to === undefined ? {} : { accountingDateTo: to }),
    ...(query.ref === undefined ? {} : { ref: query.ref }),
  };
}

function entryView(row: AdminEntryRow): Schema<'AdminLedgerEntry'> {
  return {
    entry_id: row.entryId,
    booked_at: row.bookedAt.toISOString(),
    accounting_date: row.accountingDate,
    ledger_type: row.ledgerType as Schema<'AdminLedgerType'>,
    sub_type: row.subType,
    sub_account: row.subAccount,
    // The user's balance is a liability: a stored credit (negative) is income to the user, so the
    // user's view is the negated amount — the same sign as GET /v1/wallet/ledger gives.
    amount_fen: fenToJsonNumber(subFen(0n, row.amountFen)),
    balance_after_fen: row.balanceAfterFen === null ? null : fenToJsonNumber(row.balanceAfterFen),
    voucher: {
      voucher_id: row.voucherId,
      uniq_key: row.uniqKey,
      biz_type: row.bizType,
      biz_id: row.bizId,
    },
    link: adminLedgerLinkOf({ bizType: row.bizType, bizId: row.bizId }),
  };
}

/** One page of the user's ledger entries, latest first. */
export async function listAdminLedgerEntries(
  deps: AdminLedgerReadDeps,
  query: AdminLedgerEntriesQuery,
): Promise<Schema<'AdminLedgerEntryPage'>> {
  const filter = checkedFilter(query);
  const offset = (query.page - 1) * query.pageSize;
  const read = await readOnly(deps.db, async (trx) => {
    await requireUser(deps, trx, { appId: filter.appId, userId: filter.userId });
    const total = await countAdminEntries(trx, filter);
    const rows =
      offset >= total ? [] : await readAdminEntries(trx, filter, { offset, limit: query.pageSize });
    return { total, rows };
  });
  return {
    items: read.rows.map(entryView),
    page: query.page,
    page_size: query.pageSize,
    total: read.total,
  };
}

/** biz_type of the ledger's writers → the kind of the related document (id = voucher biz_id). */
const LINK_TYPES: ReadonlyMap<string, Schema<'AdminLedgerLinkType'>> = new Map([
  ['ORDER_CREDIT', 'order'],
  ['ORDER_CLAWBACK', 'order'],
  ['ORDER_SETTLE_ADJUST', 'order'],
  ['withdrawal', 'withdrawal'],
  ['admin_adjustment', 'adjustment'],
  ['bad_debt_writeoff', 'writeoff'],
]);

/** The related document of a voucher by its biz_type (null when there is none). */
export function adminLedgerLinkOf(voucher: {
  readonly bizType: string;
  readonly bizId: string;
}): Schema<'AdminLedgerLink'> | null {
  const type = LINK_TYPES.get(voucher.bizType);
  if (type === undefined || voucher.bizId === '') return null;
  return { type, id: voucher.bizId };
}

/** The export's filters: the list's query parameters without paging (contract AdminExportLedgerFilters). */
const EXPORT_FILTER_KEYS: ReadonlySet<string> = new Set([
  'user_id',
  'ledger_type',
  'sub_type',
  'sub_account',
  'accounting_date_from',
  'accounting_date_to',
  'ref',
]);
const EXPORT_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(\d{1,19})$/;

export interface AdminLedgerExportPageInput {
  readonly appId: string;
  /** The export task's stored filters (string values; any other key or value is refused). */
  readonly filters: Readonly<Record<string, unknown>>;
  /** The previous page's `next`; null for the first page. */
  readonly after: string | null;
  /** 1..200 (the list's page_size maximum). */
  readonly limit: number;
}

export interface AdminLedgerExportPage {
  /** In the list's order, each item exactly as GET /admin/v1/ledger answers it. */
  readonly items: readonly Schema<'AdminLedgerEntry'>[];
  /** Opaque keyset position of the last item; null when this page is the last one. */
  readonly next: string | null;
}

function exportQueryOf(appId: string, filters: Readonly<Record<string, unknown>>) {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!EXPORT_FILTER_KEYS.has(key) || typeof value !== 'string') {
      throw new AdminLedgerReadFieldsError([key]);
    }
    raw[key] = value;
  }
  if (raw['user_id'] === undefined) throw new AdminLedgerReadFieldsError(['user_id']);
  return adminLedgerQueryOf(appId, raw);
}

function keysetOf(after: string | null): AdminEntryKeyset | null {
  if (after === null) return null;
  const match = EXPORT_CURSOR.exec(after);
  if (match === null) throw new Error('ledger: admin ledger export cursor malformed');
  return { bookedAtKey: match[1]!, entryId: match[2]! };
}

/**
 * One page of the user's ledger for an admin export: the filters and checks of
 * listAdminLedgerEntries (20001 AdminLedgerReadFieldsError for the same reasons, the user of the
 * console's app included), the same order and the same item values, `limit` entries after `after`.
 */
export async function readAdminLedgerExportPage(
  deps: Pick<AdminLedgerReadDeps, 'db'> & {
    readonly ports: Pick<AdminLedgerReadPorts, 'userExists'>;
  },
  input: AdminLedgerExportPageInput,
): Promise<AdminLedgerExportPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
    throw new RangeError('ledger: admin ledger export page size out of range');
  }
  const query = exportQueryOf(input.appId, input.filters);
  const filter = checkedFilter({ ...query, page: DEFAULT_PAGE, pageSize: input.limit });
  const after = keysetOf(input.after);
  const rows = await readOnly(deps.db, async (trx) => {
    if (!(await deps.ports.userExists(trx, { appId: filter.appId, userId: filter.userId }))) {
      throw new AdminLedgerReadFieldsError(['user_id']);
    }
    return readAdminEntriesAfter(trx, filter, { after, limit: input.limit });
  });
  const last = rows.at(-1);
  return {
    items: rows.map(entryView),
    next:
      rows.length < input.limit || last === undefined
        ? null
        : `${last.bookedAtKey}|${last.entryId}`,
  };
}
