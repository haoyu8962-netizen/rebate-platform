// Export task helpers: the status shown (a done task past expires_at is expired, as the server
// answers), its BR-TEXT-25 name, and which action a row offers. No copy lives here.
import { export_resource, export_status, type Schema } from '@couli/contracts-ts';
import { rawCodePointLength } from '../../text-length.ts';
import { exportsTexts as t } from '../../texts/exports.ts';

export type ExportRow = Schema<'AdminExport'>;
export type ExportStatus = Schema<'AdminExportStatus'>;
export type ExportResource = Schema<'AdminExportResource'>;

/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;

/** Reason of an unmasked retry: 1–200 characters (AdminUserReason). */
export const REASON_MAX = 200;

export const STATUSES: readonly ExportStatus[] = export_status;

/** 来源页面 options (enum export_resource, contract order). */
export const RESOURCES: readonly ExportResource[] = export_resource;

/**
 * Interval of the silent rereads while the page shown has a pending or running row. Long enough
 * that a page opened for a moment sends its one read only.
 */
export const POLL_MS = 15_000;

/** Day format of the 发起时间 pickers (Beijing days). */
export const DAY_FORMAT = 'YYYY-MM-DD';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time; null shows the dash. */
export function beijingTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** Status as shown: done whose expires_at has come (now included) counts as expired. */
export function shownStatus(row: ExportRow, now: number): ExportStatus {
  if (row.status !== 'done') return row.status;
  if (row.expires_at === null) return 'done';
  const expires = Date.parse(row.expires_at);
  return Number.isNaN(expires) || expires > now ? 'done' : 'expired';
}

/** Earliest expires_at still ahead of `now` among the done rows (when 【下载】 must go). */
export function nextExpiry(items: readonly ExportRow[], now: number): number | undefined {
  let next: number | undefined;
  for (const item of items) {
    if (item.status !== 'done' || item.expires_at === null) continue;
    const at = Date.parse(item.expires_at);
    if (Number.isNaN(at) || at <= now) continue;
    if (next === undefined || at < next) next = at;
  }
  return next;
}

/** A task still on its way: the page reads its list again until it is final. */
export function inFlight(row: ExportRow): boolean {
  return row.status === 'pending' || row.status === 'running';
}

/** `from` of a Beijing day (YYYY-MM-DD): its 00:00 (inclusive). */
export function dayStart(day: string): string {
  return `${day}T00:00:00+08:00`;
}

/** `to` of a last Beijing day (YYYY-MM-DD): the next day's 00:00 (exclusive). */
export function dayAfter(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (date ?? 1) + 1));
  return `${next.getUTCFullYear()}-${two(next.getUTCMonth() + 1)}-${two(next.getUTCDate())}T00:00:00+08:00`;
}

export function statusLabel(status: string): string {
  return (t.status as Readonly<Record<string, string>>)[status] ?? status;
}

export function resourceLabel(resource: string): string {
  return (t.resource as Readonly<Record<string, string>>)[resource] ?? resource;
}

/** antd preset Tag colour by status (the text carries the meaning). */
export function statusTagColor(status: ExportStatus): string {
  if (status === 'done') return 'success';
  if (status === 'running' || status === 'pending') return 'processing';
  if (status === 'failed') return 'error';
  return 'default';
}

export function validReason(reason: string): boolean {
  return reason.trim() !== '' && rawCodePointLength(reason) <= REASON_MAX;
}

/** data.status of a 30417 answer, when it names a known status. */
export function rejectedStatus(data: unknown): ExportStatus | undefined {
  if (typeof data !== 'object' || data === null || !('status' in data)) return undefined;
  const status: unknown = data.status;
  return STATUSES.find((item) => item === status);
}
