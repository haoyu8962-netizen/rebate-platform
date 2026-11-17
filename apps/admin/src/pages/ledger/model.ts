// 余额流水页的数据辅助：后台字典名（BR-TEXT-25，缺键显示编码）、后台金额（BR-TEXT-10，经
// @couli/money，只用整数分、不做客户端运算）、北京时间、筛选预检与查询参数、错误分类。
// 这里不放文案（texts/ledger.ts）。
import { ledger_sub_account, ledger_type, type Schema } from '@couli/contracts-ts';
import { formatYuanAdmin, parseFen } from '@couli/money';
import { AdminApiError } from '../../providers/data/index.ts';
import { ledgerTexts as t } from '../../texts/ledger.ts';

export type LedgerEntry = Schema<'AdminLedgerEntry'>;
export type LedgerEntryPage = Schema<'AdminLedgerEntryPage'>;
export type FundSummary = Schema<'AdminUserFundSummary'>;
export type LedgerType = Schema<'AdminLedgerType'>;
export type LedgerSubAccount = Schema<'AdminLedgerSubAccount'>;

export const LEDGER_URL = '/admin/v1/ledger';

export function summaryUrl(userId: string): string {
  return `/admin/v1/users/${encodeURIComponent(userId)}/fund-summary`;
}

/** page_size of the ledger list (the contract's default; ≤ 200). */
export const PAGE_SIZE = 20;

/** Every ledger_type of the contract enum (BR-FUND-15, all 13, enum order). */
export const LEDGER_TYPES: readonly LedgerType[] = ledger_type;
/** Every ledger_sub_account of the contract enum (BR-FUND-13). */
export const SUB_ACCOUNTS: readonly LedgerSubAccount[] = ledger_sub_account;

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// 随包的后台字典（contracts/texts.admin.default.json，BR-TEXT-25）。Vite glob 让 JSON 留在本包
// TS 工程之外，Vite 与 Vitest 会把它内联。
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

function dictName(key: string, code: string): string {
  const name = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  return typeof name === 'string' && name !== '' ? name : code;
}

/** admin_dict.ledger_type.<code>, else the code. */
export function ledgerTypeName(code: string): string {
  return dictName(`admin_dict.ledger_type.${code}`, code);
}
/** admin_dict.ledger_sub_account.<code>, else the code. */
export function subAccountName(code: string): string {
  return dictName(`admin_dict.ledger_sub_account.${code}`, code);
}
/** admin_dict.withdraw_hold_kind.<code>, else the code. */
export function holdKindName(code: string): string {
  return dictName(`admin_dict.withdraw_hold_kind.${code}`, code);
}

/** A balance (BR-TEXT-10 admin: ¥, thousands, two decimals; minus only when negative). */
export function money(fen: number): string {
  return formatYuanAdmin(parseFen(fen));
}
/** An entry amount from the user's view, signed (+ credit, - debit, none for 0). */
export function signedMoney(fen: number): string {
  return formatYuanAdmin(parseFen(fen), { signed: true });
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm:ss in Beijing time; unreadable input is shown as is. */
export function beijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}

/** Applied filters (what the last 【查询】 of the filter form sent). */
export interface Filters {
  readonly ledgerType?: LedgerType;
  readonly subType?: string;
  readonly subAccount?: LedgerSubAccount;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly ref?: string;
}

/** Draft of the filter form (as typed or picked). */
export interface Draft {
  readonly ledgerType: LedgerType | undefined;
  readonly subType: string;
  readonly subAccount: LedgerSubAccount | undefined;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly ref: string;
}

export const EMPTY_DRAFT: Draft = {
  ledgerType: undefined,
  subType: '',
  subAccount: undefined,
  dateFrom: '',
  dateTo: '',
  ref: '',
};

export interface DraftErrors {
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A real calendar day written YYYY-MM-DD. */
function isDay(value: string): boolean {
  const found = DAY.exec(value);
  if (found === null) return false;
  const real = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])));
  return real.toISOString().slice(0, 10) === value;
}

/**
 * Checks the draft before sending (YYYY-MM-DD, from ≤ to, as the server does). A range error is
 * shown once, next to 会计日止.
 */
export function checkDraft(draft: Draft): { filters: Filters } | { errors: DraftErrors } {
  const from = draft.dateFrom.trim();
  const to = draft.dateTo.trim();
  const errors: { dateFrom?: string; dateTo?: string } = {};
  if (from !== '' && !isDay(from)) errors.dateFrom = t.filter.dateInvalid;
  if (to !== '' && !isDay(to)) errors.dateTo = t.filter.dateInvalid;
  if (errors.dateFrom === undefined && errors.dateTo === undefined && from !== '' && to !== '')
    if (from > to) errors.dateTo = t.filter.dateRange;
  if (errors.dateFrom !== undefined || errors.dateTo !== undefined) return { errors };
  const subType = draft.subType.trim();
  const ref = draft.ref.trim();
  return {
    filters: {
      ...(draft.ledgerType === undefined ? {} : { ledgerType: draft.ledgerType }),
      ...(subType === '' ? {} : { subType }),
      ...(draft.subAccount === undefined ? {} : { subAccount: draft.subAccount }),
      ...(from === '' ? {} : { dateFrom: from }),
      ...(to === '' ? {} : { dateTo: to }),
      ...(ref === '' ? {} : { ref }),
    },
  };
}

/** Query parameters of adminListLedgerEntries (contract names only; empty filters left out). */
export function ledgerQuery(
  userId: string,
  filters: Filters,
  page: number,
): Record<string, string | number> {
  return {
    user_id: userId,
    ...(filters.ledgerType === undefined ? {} : { ledger_type: filters.ledgerType }),
    ...(filters.subType === undefined ? {} : { sub_type: filters.subType }),
    ...(filters.subAccount === undefined ? {} : { sub_account: filters.subAccount }),
    ...(filters.dateFrom === undefined ? {} : { accounting_date_from: filters.dateFrom }),
    ...(filters.dateTo === undefined ? {} : { accounting_date_to: filters.dateTo }),
    ...(filters.ref === undefined ? {} : { ref: filters.ref }),
    page,
    page_size: PAGE_SIZE,
  };
}

export const codeOf = (cause: unknown): number | undefined =>
  cause instanceof AdminApiError ? cause.code : undefined;

/** The rejected fields of a 20001 answer (data.fields), else none. */
export function rejectedFields(cause: unknown): readonly string[] {
  if (!(cause instanceof AdminApiError)) return [];
  const data = cause.data;
  if (typeof data !== 'object' || data === null) return [];
  const fields = (data as { fields?: unknown }).fields;
  return Array.isArray(fields)
    ? fields.filter((one): one is string => typeof one === 'string')
    : [];
}

/** How a failed read is shown. */
export type Failure = 'forbidden' | 'uid' | 'invalid' | 'failed';

export function failureOf(cause: unknown): Failure {
  const code = codeOf(cause);
  if (code === 10403) return 'forbidden';
  if (code !== 20001) return 'failed';
  const fields = rejectedFields(cause);
  // user_id: unknown, malformed or of another app; any other field: the filter conditions.
  return fields.includes('user_id') ? 'uid' : 'invalid';
}

export type ExportTask = Schema<'AdminExport'>;
export type ExportRequest = Schema<'AdminExportCreateLedgerRequest'>;

/** adminCreateExport (no Idempotency-Key: every call creates a new task). */
export const EXPORTS_URL = '/admin/v1/exports';

/**
 * Body of the ledger export: the applied user and filters, with the list's own parameter names;
 * no paging, never unmasked / reason (a ledger export is always masked); unset keys left out.
 */
export function exportRequest(userId: string, filters: Filters): ExportRequest {
  return {
    resource: 'ledger',
    filters: {
      user_id: userId,
      ...(filters.ledgerType === undefined ? {} : { ledger_type: filters.ledgerType }),
      ...(filters.subType === undefined ? {} : { sub_type: filters.subType }),
      ...(filters.subAccount === undefined ? {} : { sub_account: filters.subAccount }),
      ...(filters.dateFrom === undefined ? {} : { accounting_date_from: filters.dateFrom }),
      ...(filters.dateTo === undefined ? {} : { accounting_date_to: filters.dateTo }),
      ...(filters.ref === undefined ? {} : { ref: filters.ref }),
    },
  };
}

/**
 * How one export attempt ended. `unknown`: no answer in the unified envelope (network error,
 * unreadable body, or a success without the task), so the task may exist; never resent.
 */
export type ExportOutcome =
  | { readonly kind: 'created'; readonly id: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'dateRange' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' };

function createdOf(data: unknown): ExportOutcome {
  if (typeof data !== 'object' || data === null) return { kind: 'unknown' };
  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? { kind: 'created', id } : { kind: 'unknown' };
}

/** The answer data of a resolved call (an envelope with code 0 and HTTP 200). */
export function exportResolved(data: unknown): ExportOutcome {
  return createdOf(data);
}

export function exportRejected(cause: unknown): ExportOutcome {
  if (!(cause instanceof AdminApiError)) return { kind: 'unknown' };
  if (cause.kind === 'network' || cause.kind === 'parse') return { kind: 'unknown' };
  // 202 Accepted with the new task: the data provider only treats 200 as success.
  if (cause.kind === 'http')
    return cause.httpStatus === 202 ? createdOf(cause.data) : { kind: 'failed' };
  if (cause.code === 10403) return { kind: 'forbidden' };
  if (cause.code === 20001) {
    const fields = rejectedFields(cause);
    if (fields.includes('accounting_date_from') || fields.includes('accounting_date_to'))
      return { kind: 'dateRange' };
  }
  return { kind: 'failed' };
}
