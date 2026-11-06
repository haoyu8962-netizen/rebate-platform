// B1-28p: the pure rules of product feedback (08 BR-ID-02 细则「商品反馈与进店」: each device at most
// feedback.daily_limit_per_device records per natural day in +08:00, default 20; 04 §10.2
// feedback.enabled default on). No Nest, no database, no clock reads: callers pass the instant.
import { accountingDate, chinaDayRange } from '@couli/domain';

/** Configuration keys (registered by B1-28q; a missing key reads as its default). */
export const FEEDBACK_ENABLED_KEY = 'feedback.enabled';
export const FEEDBACK_DAILY_LIMIT_KEY = 'feedback.daily_limit_per_device';

/** 04 §10.2: feedback.enabled defaults to on. */
export const DEFAULT_FEEDBACK_ENABLED = true;
/** BR-ID-02 细则: feedback.daily_limit_per_device defaults to 20 (lower bound 1). */
export const DEFAULT_DAILY_LIMIT = 20;

/**
 * feedback.enabled as stored (a JSON boolean). Absent → on (the default); only an explicit
 * `false` turns the route off. Any other stored shape is not a valid value of the key and reads as
 * the default as well.
 */
export function feedbackEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return DEFAULT_FEEDBACK_ENABLED;
}

/**
 * feedback.daily_limit_per_device as stored: a whole number ≥ 1. Absent or anything else (0,
 * negative, fractional, text) reads as the default 20, never as "no limit".
 */
export function dailyLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  return DEFAULT_DAILY_LIMIT;
}

/**
 * The instant `ms` milliseconds after the epoch, built from a Clock reading (no Date constructor in
 * app code: only the injected Clock creates instants).
 */
export function instantAt(base: Date, ms: number): Date {
  const result = structuredClone(base);
  result.setTime(ms);
  return result;
}

/** The +08:00 natural day [start, end) holding `at`. */
export function chinaDayOf(at: Date): { readonly start: Date; readonly end: Date } {
  const range = chinaDayRange(accountingDate(at));
  return {
    start: instantAt(at, Date.parse(range.start)),
    end: instantAt(at, Date.parse(range.end)),
  };
}

/** Retry-After of a 42901: whole seconds to the next +08:00 midnight, within [1, 86 400]. */
export function retryAfterSeconds(at: Date): number {
  const { end } = chinaDayOf(at);
  const seconds = Math.ceil((end.getTime() - at.getTime()) / 1000);
  return Math.min(86_400, Math.max(1, seconds));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` can be a link id at all. app.links.link_id is a uuid; the contract's Id allows
 * any 1–64 characters, so anything else names no link (30144) and never reaches the database.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** identity's deletion status of an account (users.status deleting → processing, deleted → done). */
export type AccountDeletionStatus = 'none' | 'processing' | 'done';

/**
 * The user_id a submission is recorded under (money r1 S1; 08 BR-ID-28 删除清单「商品反馈记录」).
 * Read after the users row is locked FOR SHARE: an account in the deletion flow (processing / done)
 * or missing in the app is recorded as a guest (no user_id, the device as always), so no row is
 * left carrying the user_id once the deletion cleanup has run. A guest stays a guest.
 */
export function recordedUserId(
  userId: string | null,
  status: AccountDeletionStatus | undefined,
): string | null {
  if (userId === null) return null;
  return status === 'none' ? userId : null;
}

/**
 * The app of the request when the signing device belongs to it, else null (money r1 S2: a device of
 * another app → 10403). The request's app is the token's app (stage ③ has matched it to X-App-Id),
 * or for a guest the X-App-Id header; a guest request without a usable header has no other app
 * than the device's.
 */
export function requestAppOfDevice(
  deviceAppId: string,
  principalAppId: string | undefined,
  headerAppId: unknown,
): string | null {
  const requestApp =
    principalAppId ??
    (typeof headerAppId === 'string' && headerAppId !== '' ? headerAppId : deviceAppId);
  return requestApp === deviceAppId ? requestApp : null;
}
