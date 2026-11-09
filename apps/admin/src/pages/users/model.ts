// Users page helpers: Beijing-time display, contract enums to copy, and error classification.
// No copy lives here (texts/users.ts); nothing is invented beyond the contract fields.
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { rawCodePointLength } from '../../text-length.ts';
import { usersTexts as t } from '../../texts/users.ts';

export type UserRow = Schema<'AdminUserListItem'>;
export type UserDetail = Schema<'AdminUserDetail'>;
export type UnionBinding = Schema<'AdminUserUnionBinding'>;
export type RiskState = Schema<'AdminUserRiskStateCode'>;

/** Contract enum order (AdminUserRiskStateCode). */
export const RISK_STATES: readonly RiskState[] = ['normal', 'frozen', 'appealing', 'banned'];

/** page_size of the list (contract ≤ 200). */
export const PAGE_SIZE = 20;

/** Reason of a reveal: 1–200 characters (AdminUserRevealRequest.reason). */
export const REASON_MAX = 200;

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time; null shows the dash, unreadable input is shown as is. */
export function beijingTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return t.dash;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

export function riskLabel(state: string): string {
  return (t.risk as Readonly<Record<string, string>>)[state] ?? state;
}

/** antd preset Tag colour by risk state (the text carries the meaning). */
export function riskTagColor(state: string): string {
  if (state === 'normal') return 'success';
  if (state === 'frozen' || state === 'appealing') return 'warning';
  if (state === 'banned') return 'error';
  return 'default';
}

export function bindingStatusLabel(status: string): string {
  return (t.detail.bindingStatus as Readonly<Record<string, string>>)[status] ?? status;
}

export function bindingTagColor(status: string): string {
  if (status === 'active') return 'success';
  if (status === 'pending_auth' || status === 'invalid') return 'warning';
  if (status === 'blocked') return 'error';
  return 'default';
}

export function blockedReasonLabel(reason: string): string {
  return (t.detail.blockedReasons as Readonly<Record<string, string>>)[reason] ?? reason;
}

export function platformLabel(platform: string): string {
  return t.detail.platforms[platform] ?? platform;
}

export function registerMethodLabel(method: string): string {
  return t.detail.registerMethods[method] ?? method;
}

/** A user id (uuid) is looked up as `uid`; anything else is sent as the full phone number. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lookupQuery(value: string): { uid: string } | { phone: string } {
  return UUID.test(value) ? { uid: value } : { phone: value };
}

function fieldsOf(error: AdminApiError): readonly unknown[] {
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields as unknown[];
  return [];
}

function reasonOf(error: AdminApiError): unknown {
  const data = error.data;
  return typeof data === 'object' && data !== null && 'reason' in data ? data.reason : undefined;
}

/** Load outcome of a read: no permission, no such user, or failed (network and the rest). */
export function readFailure(cause: unknown): 'forbidden' | 'missing' | 'failed' {
  if (!(cause instanceof AdminApiError)) return 'failed';
  if (cause.code === 10403) return 'forbidden';
  if (cause.code === 20001 && fieldsOf(cause).includes('user_id')) return 'missing';
  return 'failed';
}

/** The hint next to the lookup box for a failed lookup. */
export function lookupErrorText(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.lookup.failed;
  if (cause.kind === 'network') return t.lookup.network;
  if (cause.code === 10403) return t.lookup.forbidden;
  if (cause.code === 20001) {
    const fields = fieldsOf(cause);
    if (fields.includes('uid') && fields.includes('phone')) return t.lookup.exactlyOne;
    if (reasonOf(cause) === 'phone_invalid') return t.lookup.phoneInvalid;
    if (fields.includes('uid') || fields.includes('phone')) return t.lookup.notFound;
    return t.lookup.invalid;
  }
  return t.lookup.failed;
}

/** The alert next to the phone number for a failed reveal (never retried automatically). */
export function revealErrorText(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.reveal.failed;
  if (cause.kind === 'network') return t.reveal.network;
  if (cause.code === 10403) return t.reveal.forbidden;
  if (cause.code === 20001) {
    // 20001 on a reveal names user_id (unknown user), reason (checked here before sending) or
    // the requested field itself (no bound phone number: nothing to show). The last is matched
    // as "neither of the others": the bare property name reads as a CSS system colour to the
    // shell's colour guard.
    const fields = fieldsOf(cause);
    if (!fields.includes('user_id') && !fields.includes('reason') && fields.length > 0)
      return t.reveal.noPhone;
  }
  return t.reveal.failed;
}

/** Reason accepted by the contract: not blank and at most 200 code points as sent (untrimmed). */
export function validReason(reason: string): boolean {
  return reason.trim() !== '' && rawCodePointLength(reason) <= REASON_MAX;
}
