// 调账与核销页的数据辅助：状态、原因码、候选单状态的后台字典名（BR-TEXT-25，缺键显示编码）、方向 /
// 单据类型 / 对方科目的值名、后台金额（BR-TEXT-10，只经 @couli/money、只用整数分、不做客户端运算）、
// 北京时间、筛选条件到查询参数、错误分类。这里不放文案。
import { formatYuanAdmin, parseFen } from '@couli/money';
import { admin_adjust_sub_type, admin_adjustment_status, type Schema } from '@couli/contracts-ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { adjustmentsTexts as t } from '../../texts/adjustments.ts';

export type Adjustment = Schema<'AdminAdjustment'>;
export type AdjustmentDetail = Schema<'AdminAdjustmentDetail'>;
export type AdjustmentPage = Schema<'AdminAdjustmentPage'>;
export type AdjustmentStatus = Schema<'AdminAdjustmentStatus'>;
export type ReasonCode = Schema<'AdminAdjustmentReasonCode'>;
export type Writeoff = Schema<'AdminBadDebtWriteoff'>;
export type WriteoffPage = Schema<'AdminBadDebtWriteoffPage'>;

export const ADJUSTMENTS_URL = '/admin/v1/adjustments';
export const WRITEOFFS_URL = '/admin/v1/bad-debt-writeoffs';
export const adjustmentUrl = (adjustId: string): string =>
  `${ADJUSTMENTS_URL}/${encodeURIComponent(adjustId)}`;

/** page_size of both lists (contract default, ≤ 200). */
export const PAGE_SIZE = 20;

/** Filter options in contract order. */
export const STATUSES: readonly AdjustmentStatus[] = admin_adjustment_status;
export const REASONS: readonly ReasonCode[] = admin_adjust_sub_type;

/** adminListAdjustments / adminGetAdjustment: fund.adjust or fund.view. */
export const canReadAdjustments = (access: AccessControl): boolean =>
  access.can('fund.adjust') || access.can('fund.view');
/** adminListBadDebtWriteoffs: fund.writeoff or fund.view. */
export const canReadWriteoffs = (access: AccessControl): boolean =>
  access.can('fund.writeoff') || access.can('fund.view');

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

/** admin_dict.admin_adjustments.status.<code>, else the code. */
export const statusLabel = (code: string): string =>
  dictName(`admin_dict.admin_adjustments.status.${code}`, code);
/** admin_dict.admin_adjustments.sub_type.<code>, else the code. */
export const reasonLabel = (code: string): string =>
  dictName(`admin_dict.admin_adjustments.sub_type.${code}`, code);
/** admin_dict.bad_debt_writeoff.status.<code>, else the code. */
export const writeoffStatusLabel = (code: string): string =>
  dictName(`admin_dict.bad_debt_writeoff.status.${code}`, code);

function named(names: Readonly<Record<string, string>>, code: string): string {
  return Object.hasOwn(names, code) ? (names[code] ?? code) : code;
}
export const directionLabel = (code: string): string => named(t.direction, code);
export const refTypeLabel = (code: string): string => named(t.refType, code);
/** 对方科目，contra_platform 有值（联盟应收）时连同平台编码。 */
export function subjectLabel(subject: string, platform: string | null): string {
  const name = named(t.subject, subject);
  return platform === null ? name : t.subjectWithPlatform(name, platform);
}

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals, minus sign kept); null shows the dash. */
export function money(fen: number | null): string {
  return fen === null ? t.dash : formatYuanAdmin(parseFen(fen));
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

/** Applied 调账单 conditions (what the last 【查询】 sent). */
export interface Filters {
  readonly status?: AdjustmentStatus;
  readonly reasonCode?: ReasonCode;
  readonly userId?: string;
}

/** Draft of the filter form (user id as typed). */
export interface Draft {
  readonly status: AdjustmentStatus | undefined;
  readonly reasonCode: ReasonCode | undefined;
  readonly userId: string;
}

export const EMPTY_DRAFT: Draft = { status: undefined, reasonCode: undefined, userId: '' };

/** The applied conditions of a draft (the user id trimmed; empty ones left out). */
export function filtersOf(draft: Draft): Filters {
  const userId = draft.userId.trim();
  return {
    ...(draft.status === undefined ? {} : { status: draft.status }),
    ...(draft.reasonCode === undefined ? {} : { reasonCode: draft.reasonCode }),
    ...(userId === '' ? {} : { userId }),
  };
}

/** Query parameters of adminListAdjustments for a page under `filters`. */
export function adjustmentsQuery(filters: Filters, page: number): Record<string, string | number> {
  return {
    page,
    page_size: PAGE_SIZE,
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.reasonCode === undefined ? {} : { reason_code: filters.reasonCode }),
    ...(filters.userId === undefined ? {} : { user_id: filters.userId }),
  };
}

/** Query parameters of adminListBadDebtWriteoffs for a page. */
export function writeoffsQuery(page: number): Record<string, string | number> {
  return { page, page_size: PAGE_SIZE };
}

export const codeOf = (cause: unknown): number | undefined =>
  cause instanceof AdminApiError ? cause.code : undefined;

/** data.fields of a 20001. */
export function fieldsOf(cause: unknown): readonly string[] {
  if (!(cause instanceof AdminApiError)) return [];
  const data = cause.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields.filter((field): field is string => typeof field === 'string');
  return [];
}
