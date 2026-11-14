// 差错单页的数据辅助：R1–R3 的类型 / 来源 / 状态取值与后台字典名（BR-TEXT-25，字典缺键时类型名取
// texts/recon.ts，再缺显示编码）、黑名单差错单的订单与命中维度（F1-08ec）、
// 后台金额（BR-TEXT-10，经 @couli/money，只用整数分）、北京时间、筛选条件到查询参数、错误分类。
// 这里不放文案。
import { formatYuanAdmin, parseFen } from '@couli/money';
import { recon_diff_status, type Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { reconTexts as t } from '../../texts/recon.ts';

export type ReconDiff = Schema<'AdminReconDiff'>;
export type ReconDiffDetail = Schema<'AdminReconDiffDetail'>;
export type ReconDiffType = Schema<'AdminReconDiffType'>;
export type ReconDiffSource = Schema<'AdminReconDiffSource'>;
export type ReconDiffStatus = Schema<'AdminReconDiffStatus'>;

/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;
/** Close reason: 1–200 characters after trimming (AdminReconDiffCloseRequest). */
export const REASON_MAX = 200;
/** Write-off note: optional, 1–200 characters after trimming (AdminReconDiffWriteOffRequest). */
export const NOTE_MAX = 200;
/**
 * Characters of a note or reason as the contract counts them: Unicode code points after trimming
 * (an extension-B character such as 𠮷 is one character, two UTF-16 units).
 */
export const noteLength = (note: string): number => Array.from(note.trim()).length;
/** The step-up endpoint (totp tier for payout.execute). */
export const STEP_UP_URL = '/admin/v1/auth/step-up';

/** The ten R1–R3 types (AdminReconDiffType; the R4 types stay on the pay-order page). */
export const TYPES: readonly ReconDiffType[] = [
  'union_mismatch',
  'channel_mismatch',
  'ledger_mismatch',
  'platform_restore',
  'month_end_unbalanced',
  'settle_amount_mismatch',
  'settle_missing',
  'appeal_restore',
  'estimate_changed_after_credit',
  'blacklist_after_credit',
];
export const SOURCES: readonly ReconDiffSource[] = ['R1', 'R2', 'R3'];
export const STATUSES: readonly ReconDiffStatus[] = recon_diff_status;

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

/** admin_dict.recon_diff_type.<code>, else the console name of texts/recon.ts, else the code. */
export const typeLabel = (code: string): string =>
  dictName(
    `admin_dict.recon_diff_type.${code}`,
    Object.hasOwn(t.types, code) ? (t.types[code] ?? code) : code,
  );
/** admin_dict.recon_diffs.source.<code>, else the code. */
export const sourceLabel = (code: string): string =>
  dictName(`admin_dict.recon_diffs.source.${code}`, code);
/** admin_dict.recon_diff_status.<code>, else the code. */
export const statusLabel = (code: string): string =>
  dictName(`admin_dict.recon_diff_status.${code}`, code);

/** antd preset Tag colour by status (the text carries the meaning). */
export function statusColor(code: ReconDiffStatus): string {
  if (code === 'open') return 'warning';
  if (code === 'processing') return 'processing';
  if (code === 'closed') return 'default';
  return 'success';
}

/** Only open / processing differences can be closed (closeAdminReconDiff). */
export const closable = (status: ReconDiffStatus): boolean =>
  status === 'open' || status === 'processing';

/**
 * 【核销】 (writeOffAdminReconDiff, W11 by the bill line): R2 differences still open / processing.
 * payout.execute is checked by the caller.
 */
export const writableOff = (item: { source: string; status: ReconDiffStatus }): boolean =>
  item.source === 'R2' && closable(item.status);

/** The difference type 【确认扣回】 applies to (CT-24zzf). */
export const BLACKLIST_TYPE = 'blacklist_after_credit';

/**
 * 【确认扣回】 (blacklistClawbackAdminReconDiff): blacklist_after_credit differences still open /
 * processing. order.blacklist_clawback is checked by the caller.
 */
export const clawable = (item: { type: string; status: ReconDiffStatus }): boolean =>
  item.type === BLACKLIST_TYPE && closable(item.status);

const BLACKLIST_MARK = '#BLACKLIST#';

/** The order_key part of a blacklist difference's ref_id (`{order_key}#BLACKLIST#{dimensions}`). */
export function blacklistOrderKey(ref: string): string {
  const at = ref.indexOf(BLACKLIST_MARK);
  return at < 0 ? ref : ref.slice(0, at);
}

/** The hit dimensions: resolution.dimensions, else the part of ref_id after `#BLACKLIST#`. */
export function blacklistDimensions(item: {
  ref_id: string;
  resolution?: unknown;
}): readonly string[] {
  const resolution = item.resolution;
  if (typeof resolution === 'object' && resolution !== null && !Array.isArray(resolution)) {
    const listed: unknown = (resolution as Record<string, unknown>)['dimensions'];
    if (Array.isArray(listed)) {
      const names = listed.filter((entry): entry is string => typeof entry === 'string');
      if (names.length > 0) return names;
    }
  }
  const at = item.ref_id.indexOf(BLACKLIST_MARK);
  if (at < 0) return [];
  return item.ref_id
    .slice(at + BLACKLIST_MARK.length)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Console name of a blacklist dimension, else the code. */
export const dimensionLabel = (code: string): string =>
  Object.hasOwn(t.dimensions, code) ? (t.dimensions[code] ?? code) : code;

/** The two data.reason values of a refused clawback (20001, data.fields=[recon_diff_id]). */
export const CLAWBACK_REASONS = [
  'blacklist_clawback_not_supported',
  'blacklist_clawback_disabled',
] as const;
export type ClawbackReason = (typeof CLAWBACK_REASONS)[number];

/** `data.reason` of a 20001 refusing the clawback, when it is one of the two known values. */
export function clawbackReason(cause: unknown): ClawbackReason | undefined {
  if (codeOf(cause) !== 20001) return undefined;
  const reason = dataOf(cause)?.['reason'];
  return CLAWBACK_REASONS.find((item) => item === reason);
}

/** The five data.reason values of the W11 guard (20001, data.fields=[recon_diff_id]). */
export const GUARD_REASONS = [
  'not_payer_side_case',
  'writeoff_disabled',
  'withdrawal_not_returned',
  'transfer_attempts_mismatch',
  'amount_mismatch',
] as const;
export type GuardReason = (typeof GUARD_REASONS)[number];

function dataOf(cause: unknown): Record<string, unknown> | undefined {
  if (!(cause instanceof AdminApiError)) return undefined;
  const data: unknown = cause.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

/** `data.reason` of a 20001 from the W11 guard, when it is one of the five known values. */
export function guardReason(cause: unknown): GuardReason | undefined {
  if (codeOf(cause) !== 20001) return undefined;
  const reason = dataOf(cause)?.['reason'];
  return GUARD_REASONS.find((item) => item === reason);
}

/** `data.resource` of a 20902 (recon_diff / withdrawal), else undefined. */
export function conflictResource(cause: unknown): string | undefined {
  if (codeOf(cause) !== 20902) return undefined;
  const resource = dataOf(cause)?.['resource'];
  return typeof resource === 'string' ? resource : undefined;
}

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals, minus sign kept). */
export function money(fen: number): string {
  return formatYuanAdmin(parseFen(fen));
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const two = (value: number): string => String(value).padStart(2, '0');

/** YYYY-MM-DD HH:mm:ss in Beijing; null shows the dash, unreadable input is shown as is. */
export function beijingTime(iso: string | null): string {
  if (iso === null) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** Applied list conditions (what the last 【查询】 sent). */
export interface Filters {
  readonly type?: ReconDiffType;
  readonly source?: ReconDiffSource;
  readonly status?: ReconDiffStatus;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly refId?: string;
}

/** Draft of the filter form (strings as typed). */
export interface Draft {
  readonly type: ReconDiffType | undefined;
  readonly source: ReconDiffSource | undefined;
  readonly status: ReconDiffStatus | undefined;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly refId: string;
}

export const EMPTY_DRAFT: Draft = {
  type: undefined,
  source: undefined,
  status: undefined,
  periodFrom: '',
  periodTo: '',
  refId: '',
};

/**
 * The starting draft of a page opened at `search` (a workbench card opens /recon?status=…): its
 * `status` when it is an AdminReconDiffStatus (exact case), else the empty draft; nothing else of
 * the address is taken.
 */
export function draftFromSearch(search: string): Draft {
  const value = new URLSearchParams(search).get('status');
  const status = STATUSES.find((item) => item === value);
  return status === undefined ? EMPTY_DRAFT : { ...EMPTY_DRAFT, status };
}

const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$/;

export interface DraftErrors {
  readonly periodFrom?: string;
  readonly periodTo?: string;
}

/** Checks the draft before sending (period pattern, from ≤ to as strings, as the server does). */
export function checkDraft(draft: Draft): { filters: Filters } | { errors: DraftErrors } {
  const from = draft.periodFrom.trim();
  const to = draft.periodTo.trim();
  const errors: { periodFrom?: string; periodTo?: string } = {};
  if (from !== '' && !PERIOD.test(from)) errors.periodFrom = t.filter.periodInvalid;
  if (to !== '' && !PERIOD.test(to)) errors.periodTo = t.filter.periodInvalid;
  if (errors.periodFrom === undefined && errors.periodTo === undefined && from !== '' && to !== '')
    if (from > to) {
      errors.periodFrom = t.filter.periodRange;
      errors.periodTo = t.filter.periodRange;
    }
  if (errors.periodFrom !== undefined || errors.periodTo !== undefined) return { errors };
  const ref = draft.refId.trim().slice(0, 64);
  return {
    filters: {
      ...(draft.type === undefined ? {} : { type: draft.type }),
      ...(draft.source === undefined ? {} : { source: draft.source }),
      ...(draft.status === undefined ? {} : { status: draft.status }),
      ...(from === '' ? {} : { periodFrom: from }),
      ...(to === '' ? {} : { periodTo: to }),
      ...(ref === '' ? {} : { refId: ref }),
    },
  };
}

/** Query parameters of listAdminReconDiffs for a page under `filters`. */
export function listQuery(filters: Filters, page: number): Record<string, string | number> {
  return {
    page,
    page_size: PAGE_SIZE,
    ...(filters.type === undefined ? {} : { type: filters.type }),
    ...(filters.source === undefined ? {} : { source: filters.source }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.periodFrom === undefined ? {} : { period_from: filters.periodFrom }),
    ...(filters.periodTo === undefined ? {} : { period_to: filters.periodTo }),
    ...(filters.refId === undefined ? {} : { ref_id: filters.refId }),
  };
}

/** The list row of a detail (the fields listAdminReconDiffs returns). */
export function rowOf(item: ReconDiffDetail): ReconDiff {
  return {
    recon_diff_id: item.recon_diff_id,
    source: item.source,
    type: item.type,
    period: item.period,
    ref_type: item.ref_type,
    ref_id: item.ref_id,
    expected_fen: item.expected_fen,
    actual_fen: item.actual_fen,
    diff_fen: item.diff_fen,
    status: item.status,
    created_at: item.created_at,
    closed_at: item.closed_at,
  };
}

/** resolution.reason when it is a non-empty string; other keys are never read (CT-24v). */
export function resolutionReason(resolution: unknown): string | undefined {
  if (typeof resolution !== 'object' || resolution === null || Array.isArray(resolution))
    return undefined;
  const reason: unknown = (resolution as Record<string, unknown>)['reason'];
  return typeof reason === 'string' && reason.trim() !== '' ? reason : undefined;
}

/** `data.fields` of a 20001, else an empty list. */
export function rejectedFields(cause: unknown): readonly string[] {
  if (!(cause instanceof AdminApiError) || cause.code !== 20001) return [];
  const data: unknown = cause.data;
  if (typeof data !== 'object' || data === null) return [];
  const fields: unknown = (data as Record<string, unknown>)['fields'];
  return Array.isArray(fields)
    ? fields.filter((item): item is string => typeof item === 'string')
    : [];
}

export const codeOf = (cause: unknown): number | undefined =>
  cause instanceof AdminApiError ? cause.code : undefined;

/** A failure of the request itself (no answer read): resending the same close is safe. */
export const isNetwork = (cause: unknown): boolean =>
  cause instanceof AdminApiError && cause.kind === 'network';

/** A new Idempotency-Key for one close / write-off / clawback dialog. */
export function newRequestKey(): string {
  return globalThis.crypto.randomUUID();
}
