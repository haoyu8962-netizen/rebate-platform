// AI 助手记录页的数据辅助：契约类型、接口地址、北京时间显示与输入、两张列表的筛选预检与查询参数、
// 错误分类。这里不放文案（texts/agent-traces.ts）。超时只取行里的 overdue / deadline_at，这里不读时钟。
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { codePointLength } from '../../text-length.ts';

export type SessionItem = Schema<'AdminAgentSessionListItem'>;
export type SessionPage = Schema<'AdminAgentSessionPage'>;
export type SessionDetail = Schema<'AdminAgentSessionDetail'>;
export type TraceMessage = Schema<'AdminAgentTraceMessage'>;
export type TraceRun = Schema<'AdminAgentTraceRun'>;
export type TraceToolCall = Schema<'AdminAgentTraceToolCall'>;
export type TraceCard = Schema<'AgentHistoryCard'>;
export type Report = Schema<'AdminAgentReport'>;
export type ReportPage = Schema<'AdminAgentReportPage'>;
export type ReportStatus = Schema<'AdminAgentReportStatus'>;
export type HandleBody = Schema<'AdminAgentReportHandleRequest'>;

export const SESSIONS_URL = '/admin/v1/agent-traces/sessions';
export const REPORTS_URL = '/admin/v1/agent-traces/reports';
export const sessionUrl = (id: string): string => `${SESSIONS_URL}/${encodeURIComponent(id)}`;
export const handleUrl = (id: string): string => `${REPORTS_URL}/${encodeURIComponent(id)}/handle`;

/** page_size of both lists (contract ≤ 200). */
export const PAGE_SIZE = 20;
/** The handling note: 1–500 code points after trimming (contract AdminAgentReportHandleRequest). */
export const NOTE_MAX = 500;

export const REPORT_STATUSES: readonly ReportStatus[] = ['pending', 'handled'];

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

const TIME_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A typed Beijing time (YYYY-MM-DD[ HH:mm[:ss]]) as ISO 8601 with the +08:00 offset; undefined
 * when it is not a real date and time.
 */
export function beijingInput(value: string): string | undefined {
  const parts = TIME_INPUT.exec(value.trim());
  if (parts === null) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = parts;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  // Reject overflowing values (2026-02-30 rolls over in Date).
  const back = new Date(ms + BEIJING_OFFSET_MS);
  if (
    back.getUTCFullYear() !== Number(year) ||
    back.getUTCMonth() + 1 !== Number(month) ||
    back.getUTCDate() !== Number(day) ||
    back.getUTCHours() !== Number(hour) ||
    back.getUTCMinutes() !== Number(minute) ||
    back.getUTCSeconds() !== Number(second)
  )
    return undefined;
  return iso;
}

/** Errors of the time window: a field that is not a time, or from not earlier than to. */
export interface WindowErrors {
  readonly from?: 'format' | 'range';
  readonly to?: 'format' | 'range';
}

/** The typed window as ISO times; from must be earlier than to (the server refuses from ≥ to). */
export function checkWindow(
  from: string,
  to: string,
): { readonly from?: string; readonly to?: string } | { readonly errors: WindowErrors } {
  const fromText = from.trim();
  const toText = to.trim();
  const fromIso = fromText === '' ? undefined : beijingInput(fromText);
  const toIso = toText === '' ? undefined : beijingInput(toText);
  const errors: { from?: 'format' | 'range'; to?: 'format' | 'range' } = {};
  if (fromText !== '' && fromIso === undefined) errors.from = 'format';
  if (toText !== '' && toIso === undefined) errors.to = 'format';
  if (
    errors.from === undefined &&
    errors.to === undefined &&
    fromIso !== undefined &&
    toIso !== undefined &&
    Date.parse(fromIso) >= Date.parse(toIso)
  ) {
    errors.from = 'range';
    errors.to = 'range';
  }
  if (errors.from !== undefined || errors.to !== undefined) return { errors };
  return {
    ...(fromIso === undefined ? {} : { from: fromIso }),
    ...(toIso === undefined ? {} : { to: toIso }),
  };
}

/** A yes / no filter as typed (undefined: all). */
export type Flag = 'true' | 'false' | undefined;

export interface SessionDraft {
  readonly user: string;
  readonly session: string;
  readonly badcase: Flag;
  readonly reported: Flag;
  readonly from: string;
  readonly to: string;
}

export const EMPTY_SESSION_DRAFT: SessionDraft = {
  user: '',
  session: '',
  badcase: undefined,
  reported: undefined,
  from: '',
  to: '',
};

/** Applied session list conditions (contract parameter names, blank ones left out). */
export type SessionFilters = Readonly<Record<string, string>>;

export function checkSessionDraft(
  draft: SessionDraft,
): { readonly filters: SessionFilters } | { readonly errors: WindowErrors } {
  const window = checkWindow(draft.from, draft.to);
  if ('errors' in window) return { errors: window.errors };
  const user = draft.user.trim();
  const session = draft.session.trim();
  return {
    filters: {
      ...(user === '' ? {} : { user_id: user }),
      ...(session === '' ? {} : { session_id: session }),
      ...(draft.badcase === undefined ? {} : { badcase: draft.badcase }),
      ...(draft.reported === undefined ? {} : { reported: draft.reported }),
      ...(window.from === undefined ? {} : { from: window.from }),
      ...(window.to === undefined ? {} : { to: window.to }),
    },
  };
}

export interface ReportDraft {
  readonly status: ReportStatus | undefined;
  readonly overdue: boolean;
  readonly from: string;
  readonly to: string;
}

export const EMPTY_REPORT_DRAFT: ReportDraft = {
  status: undefined,
  overdue: false,
  from: '',
  to: '',
};

/** Applied report list conditions (contract parameter names, blank ones left out). */
export type ReportFilters = Readonly<Record<string, string>>;

export function checkReportDraft(
  draft: ReportDraft,
): { readonly filters: ReportFilters } | { readonly errors: WindowErrors } {
  const window = checkWindow(draft.from, draft.to);
  if ('errors' in window) return { errors: window.errors };
  return {
    filters: {
      ...(draft.status === undefined ? {} : { status: draft.status }),
      ...(draft.overdue ? { overdue: 'true' } : {}),
      ...(window.from === undefined ? {} : { from: window.from }),
      ...(window.to === undefined ? {} : { to: window.to }),
    },
  };
}

/** Query of a list page under `filters` (page and page_size always sent). */
export function listQuery(
  filters: Readonly<Record<string, string>>,
  page: number,
): Record<string, string | number> {
  return { page, page_size: PAGE_SIZE, ...filters };
}

/** The handling note fits: 1–500 code points once trimmed (apps/admin/src/text-length.ts). */
export function validNote(note: string): boolean {
  const length = codePointLength(note);
  return length >= 1 && length <= NOTE_MAX;
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

/** The overdue filter of an address (?overdue=true, as the workbench card agent_report_overdue sends). */
export function overdueOf(search: string): boolean {
  return new URLSearchParams(search).get('overdue') === 'true';
}

/** Tool arguments as stored (masked), one line; none stored: undefined. */
export function argsText(args: TraceToolCall['args']): string | undefined {
  if (args === null) return undefined;
  return JSON.stringify(args);
}
