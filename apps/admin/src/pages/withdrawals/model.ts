// 提现审核页的数据辅助：提现状态 / 审核方式 / 转人工原因 / 风险标签的后台字典名（BR-TEXT-25，缺键
// 显示编码）、后台金额（BR-TEXT-10，经 @couli/money，只用整数分）、北京时间、筛选条件到
// listAdminWithdrawals 查询参数（CT-24y）、错误分类。这里不放文案。
import { formatYuanAdmin, parseFen } from '@couli/money';
import {
  payout_method,
  withdrawal_review_mode,
  withdrawal_status,
  type Schema,
} from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { withdrawalsTexts as t } from '../../texts/withdrawals.ts';

export type WithdrawalRow = Schema<'AdminWithdrawalListItem'>;
export type WithdrawalDetail = Schema<'AdminWithdrawalDetail'>;
export type WithdrawalPage = Schema<'AdminWithdrawalPage'>;
export type WithdrawalStatus = Schema<'WithdrawalStatus'>;
export type ReviewMode = Schema<'WithdrawalReviewMode'>;
export type PayoutChannel = Schema<'AdminPayoutChannelCode'>;
export type DisplayStatus = Schema<'AdminWithdrawalDisplayStatus'>;
export type RiskFlagCode = Schema<'AdminWithdrawalRiskFlagCode'>;

export const LIST_URL = '/admin/v1/withdrawals';
export const itemUrl = (id: string): string => `${LIST_URL}/${encodeURIComponent(id)}`;
/** The console route of a withdrawal's detail. */
export const detailRoute = (id: string): string => `/withdrawals/${encodeURIComponent(id)}`;

/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;

export const STATUSES: readonly WithdrawalStatus[] = withdrawal_status;
export const REVIEW_MODES: readonly ReviewMode[] = withdrawal_review_mode;
export const CHANNELS: readonly PayoutChannel[] = payout_method;
/** The codes of AdminWithdrawalRiskFlagCode (contract order). */
export const RISK_FLAGS: readonly RiskFlagCode[] = [
  'first_withdrawal',
  'credited_today',
  'same_device_multi_account',
  'invalid_ratio_60d',
  'high_commission_ratio_60d',
  'withdraw_vs_received',
  'had_negative',
  'recon_diff',
  'blacklist_hit',
  'payee_prev_other_user',
  'risk_calc_failed',
];

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

/** admin_dict.withdrawal_status.<code>, else the code. */
export const statusLabel = (code: string): string =>
  dictName(`admin_dict.withdrawal_status.${code}`, code);
/** admin_dict.withdrawals.review_mode.<code>, else the code. */
export const reviewModeLabel = (code: string): string =>
  dictName(`admin_dict.withdrawals.review_mode.${code}`, code);
/** admin_dict.withdrawals.risk_flags.<code>, else the code. */
export const riskLabel = (code: string): string =>
  dictName(`admin_dict.withdrawals.risk_flags.${code}`, code);
/**
 * An unmet condition of auto_decision.failed_conditions: `risk_flag:<code>` by the risk flag's
 * name, otherwise admin_dict.withdrawals.auto_decision.failed_conditions.<code>; else the code.
 */
export function conditionLabel(code: string): string {
  const risk = /^risk_flag:(.+)$/.exec(code);
  if (risk !== null) return riskLabel(risk[1]!);
  return dictName(`admin_dict.withdrawals.auto_decision.failed_conditions.${code}`, code);
}
/** The payout channel's name (no admin_dict row), else the code. */
export const channelLabel = (code: string): string => t.channels[code] ?? code;
/** A name from `names`, else the code. */
export const nameOr = (names: Readonly<Record<string, string>>, code: string): string =>
  names[code] ?? code;

/** antd preset Tag colour by status (the text carries the meaning). */
export function statusColor(code: WithdrawalStatus): string {
  if (code === 'PENDING_REVIEW' || code === 'APPROVED') return 'warning';
  if (code === 'PAYING') return 'processing';
  if (code === 'PAID_API' || code === 'PAID_MANUAL') return 'success';
  if (code === 'FAILED') return 'error';
  return 'default';
}

/** Admin amount (BR-TEXT-10: ¥, thousands, two decimals, minus sign kept). */
export function money(fen: number): string {
  return formatYuanAdmin(parseFen(fen));
}

/** A ratio in bp as a percentage with two decimals (integer arithmetic only). */
export function percentOf(bp: number | null): string {
  if (bp === null) return t.dash;
  return `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`;
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

/** The status tabs (规格 §2: 全部 / 待审 / 驳回 / 手动 / 自动) and the condition each adds. */
export type StatusTab = 'all' | 'pendingReview' | 'rejected' | 'manual' | 'auto';
export const STATUS_TABS: readonly StatusTab[] = [
  'all',
  'pendingReview',
  'rejected',
  'manual',
  'auto',
];

/**
 * The quick filters of CT-24y listAdminWithdrawals (BR-WDR-08 细则): 待审 = display_status
 * pending_review, 驳回 = rejected, 手动 = paid_manual (PAID_MANUAL), 自动 = PAID_API (either
 * paid_auto_system or paid_auto_review, sent as status=PAID_API). review_mode is only the
 * 审核方式 filter's.
 */
function tabQuery(tab: StatusTab, status: WithdrawalStatus | undefined): Record<string, string> {
  if (tab === 'pendingReview') return { display_status: 'pending_review' };
  if (tab === 'rejected') return { display_status: 'rejected' };
  if (tab === 'manual') return { display_status: 'paid_manual' };
  if (tab === 'auto') {
    // The 状态 filter ANDs with the tab: another status than PAID_API keeps that status and
    // adds a PAID_API-only display status, so the server answers the (empty) intersection.
    if (status === undefined || status === 'PAID_API') return { status: 'PAID_API' };
    return { display_status: 'paid_auto_system' };
  }
  return {};
}

/** Applied list conditions (what the last 【查询】 sent). */
export interface Filters {
  readonly status?: WithdrawalStatus;
  readonly reviewMode?: ReviewMode;
  readonly channel?: PayoutChannel;
  readonly riskFlag?: RiskFlagCode;
  readonly outBizNo?: string;
  readonly userId?: string;
  /** created_from / created_to (ISO 8601 with +08:00; created_to exclusive). */
  readonly createdFrom?: string;
  readonly createdTo?: string;
}

/** Draft of the filter form (strings as typed). */
export interface Draft {
  readonly status: WithdrawalStatus | undefined;
  readonly reviewMode: ReviewMode | undefined;
  readonly channel: PayoutChannel | undefined;
  readonly riskFlag: RiskFlagCode | undefined;
  readonly outBizNo: string;
  readonly userId: string;
  readonly dateFrom: string;
  readonly dateTo: string;
}

export const EMPTY_DRAFT: Draft = {
  status: undefined,
  reviewMode: undefined,
  channel: undefined,
  riskFlag: undefined,
  outBizNo: '',
  userId: '',
  dateFrom: '',
  dateTo: '',
};

export const sameDraft = (a: Draft, b: Draft): boolean =>
  (Object.keys(a) as (keyof Draft)[]).every((name) => a[name] === b[name]);

export interface DraftErrors {
  readonly outBizNo?: string;
  readonly userId?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

const OUT_BIZ_NO = /^[A-Za-z0-9]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date YYYY-MM-DD as [y, m, d], else undefined. */
function dateParts(text: string): [number, number, number] | undefined {
  const found = DATE.exec(text);
  if (found === null) return undefined;
  const [y, m, d] = [Number(found[1]), Number(found[2]), Number(found[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d)
    return undefined;
  return [y, m, d];
}
/** Start of the Beijing day `days` after [y, m, d], as ISO 8601 with +08:00. */
function beijingStart([y, m, d]: [number, number, number], days: number): string {
  const day = new Date(Date.UTC(y, m - 1, d + days));
  return `${day.getUTCFullYear()}-${two(day.getUTCMonth() + 1)}-${two(day.getUTCDate())}T00:00:00+08:00`;
}

/**
 * Checks the draft before sending (number and id patterns, dates, from ≤ to, as the server does)
 * and turns it into conditions: the application dates cover whole Beijing days (created_to is the
 * start of the day after the end date, exclusive).
 */
export function checkDraft(draft: Draft): { filters: Filters } | { errors: DraftErrors } {
  const outBizNo = draft.outBizNo.trim();
  const userId = draft.userId.trim();
  const fromText = draft.dateFrom.trim();
  const toText = draft.dateTo.trim();
  const from = fromText === '' ? undefined : dateParts(fromText);
  const to = toText === '' ? undefined : dateParts(toText);
  const errors: { -readonly [K in keyof DraftErrors]: DraftErrors[K] } = {};
  if (outBizNo !== '' && !OUT_BIZ_NO.test(outBizNo)) errors.outBizNo = t.filter.outBizNoInvalid;
  if (userId !== '' && !UUID.test(userId)) errors.userId = t.filter.userIdInvalid;
  if (fromText !== '' && from === undefined) errors.dateFrom = t.filter.dateInvalid;
  if (toText !== '' && to === undefined) errors.dateTo = t.filter.dateInvalid;
  if (from !== undefined && to !== undefined && fromText > toText) {
    errors.dateFrom = t.filter.dateRange;
    errors.dateTo = t.filter.dateRange;
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    filters: {
      ...(draft.status === undefined ? {} : { status: draft.status }),
      ...(draft.reviewMode === undefined ? {} : { reviewMode: draft.reviewMode }),
      ...(draft.channel === undefined ? {} : { channel: draft.channel }),
      ...(draft.riskFlag === undefined ? {} : { riskFlag: draft.riskFlag }),
      ...(outBizNo === '' ? {} : { outBizNo }),
      ...(userId === '' ? {} : { userId: userId.toLowerCase() }),
      ...(from === undefined ? {} : { createdFrom: beijingStart(from, 0) }),
      ...(to === undefined ? {} : { createdTo: beijingStart(to, 1) }),
    },
  };
}

/**
 * Query parameters of listAdminWithdrawals for a page: the status tab's quick filter AND the
 * applied filters (all conditions combine with AND on the server).
 */
export function listQuery(
  tab: StatusTab,
  filters: Filters,
  page: number,
): Record<string, string | number> {
  return {
    page,
    page_size: PAGE_SIZE,
    ...tabQuery(tab, filters.status),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.reviewMode === undefined ? {} : { review_mode: filters.reviewMode }),
    ...(filters.channel === undefined ? {} : { payout_channel: filters.channel }),
    ...(filters.riskFlag === undefined ? {} : { risk_flag: filters.riskFlag }),
    ...(filters.outBizNo === undefined ? {} : { out_biz_no: filters.outBizNo }),
    ...(filters.userId === undefined ? {} : { user_id: filters.userId }),
    ...(filters.createdFrom === undefined ? {} : { created_from: filters.createdFrom }),
    ...(filters.createdTo === undefined ? {} : { created_to: filters.createdTo }),
  };
}

export const codeOf = (cause: unknown): number | undefined =>
  cause instanceof AdminApiError ? cause.code : undefined;

/** Whether the account may read withdrawals (withdraw.review or fund.view, CT-24y). */
export const canRead = (access: { can(permission: string): boolean }): boolean =>
  access.can('withdraw.review') || access.can('fund.view');

/** POST adminBatchApproveWithdrawals (the detail sends just its own withdrawal). */
export const APPROVE_URL = `${LIST_URL}/batch-approve`;
/** POST adminRejectWithdrawal. */
export const rejectUrl = (id: string): string => `${itemUrl(id)}/reject`;
export const STEP_UP_URL = '/admin/v1/auth/step-up';
/** The permission point of 【审核通过】【驳回】 (a super admin holds every point). */
export const REVIEW_PERMISSION = 'withdraw.review';
/** AdminWithdrawalRejectRequest.note maxLength (Unicode code points). */
export const REJECT_NOTE_MAX = 500;

export type RejectReason = Schema<'AdminWithdrawalRejectRequest'>['reason_code'];
/** The five reasons a person can choose (contract order); NEGATIVE_BALANCE is the system's. */
export const REJECT_REASONS: readonly RejectReason[] = [
  'RISK_SUSPECT',
  'ORDER_ABNORMAL',
  'PAYEE_INFO_INVALID',
  'USER_REQUEST',
  'OTHER',
];

/** 【审核通过】 only from PENDING_REVIEW (W2). */
export const canApprove = (status: WithdrawalStatus): boolean => status === 'PENDING_REVIEW';
/** 【驳回】 from PENDING_REVIEW or APPROVED (W3). */
export const canReject = (status: WithdrawalStatus): boolean =>
  status === 'PENDING_REVIEW' || status === 'APPROVED';

interface UserDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// 随包的用户字典（contracts/texts.default.json，BR-TEXT-08 withdraw_reject_reason）：驳回原因的
// 用户文案只读 withdraw_reject_reason.<编码>.title；缺键时只显示原因码中文名，不写死用户文案。
const userLoaded = import.meta.glob<UserDictionary>('../../../../../contracts/texts.default.json', {
  eager: true,
  import: 'default',
});
const userDictionary: Readonly<Record<string, string>> = Object.values(userLoaded)[0]?.texts ?? {};

function userText(key: string): string | undefined {
  const value = Object.hasOwn(userDictionary, key) ? userDictionary[key] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The member's text of a reject reason: withdraw_reject_reason.<code>.title, else its enum name. */
export function rejectReasonText(code: string): string {
  return userText(`withdraw_reject_reason.${code}.title`) ?? t.review.reasonNames[code] ?? code;
}

/** A new Idempotency-Key for one review operation (kept across a 10003 re-verification). */
export function newRequestKey(): string {
  return globalThis.crypto.randomUUID();
}

/** data.fields of a 20001, else []. */
export function fieldsOf(cause: unknown): readonly unknown[] {
  if (!(cause instanceof AdminApiError)) return [];
  const data = cause.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields as unknown[];
  return [];
}

/** data.reason of an error, else undefined. */
export function reasonOf(cause: unknown): string | undefined {
  if (!(cause instanceof AdminApiError)) return undefined;
  const data = cause.data;
  if (typeof data === 'object' && data !== null && 'reason' in data)
    return typeof data.reason === 'string' ? data.reason : undefined;
  return undefined;
}

/** 结果未知转人工的单：【立即查询】与【人工处置】共用的权限点（totp 档 step-up）。 */
export const EXECUTE_PERMISSION = 'payout.execute';

export const queryUrl = (id: string): string => `${itemUrl(id)}/query`;
export const resolveUrl = (id: string): string => `${itemUrl(id)}/resolve`;

/** The longest proof_text, in Unicode code points (contract maxLength). */
export const PROOF_MAX = 4000;
const ORDER_ID_MAX = 64;

/** Only a PAYING withdrawal past T+24h (needs_manual) takes the query and the disposal. */
export const canHandleUnknown = (item: {
  readonly status: WithdrawalStatus;
  readonly needs_manual: boolean;
}): boolean => item.status === 'PAYING' && item.needs_manual;

/** channel_order_id: 1 to 64 code points, no whitespace or NUL (compared exactly, not trimmed). */
export function checkOrderId(value: string): boolean {
  const count = Array.from(value).length;
  return count >= 1 && count <= ORDER_ID_MAX && /^[^\s\u0000]+$/u.test(value);
}

const BEIJING_INPUT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * A typed Beijing time `YYYY-MM-DD HH:mm:ss` (surrounding blanks ignored) as ISO 8601 with
 * +08:00; undefined when the shape or the calendar value is not valid.
 */
export function parseBeijingTime(value: string): string | undefined {
  const text = value.trim();
  const match = BEIJING_INPUT.exec(text);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day)
    return undefined;
  return `${text.slice(0, 10)}T${text.slice(11)}+08:00`;
}
