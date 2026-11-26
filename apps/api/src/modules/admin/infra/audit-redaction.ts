// BR-ID-33 backstop for audit snapshots. Callers still mask; this only keeps an obvious
// plaintext secret or phone number out of the append-only audit_logs when a caller forgot.
//
// - Key names are normalised the way platform logging does it (lower case, non-alphanumerics
//   dropped). A key is sensitive when its normalised name equals one of the given names, or
//   CONTAINS one of AUDIT_SENSITIVE_FRAGMENTS (so totp_secret, totp_secret_cipher,
//   password_hash, verify_phone, verify_phone_hmac, refresh_token… are all caught). Its value
//   is replaced whole, whatever its type.
// - Exception: a key whose normalised name ends with `masked` (phone_masked) holds a display
//   mask the caller already produced, and is kept.
// - Values: a string or number that contains a mainland mobile number (11 digits starting with
//   1[3-9], optionally +86 / 86, optional single spaces or hyphens between digit groups, not
//   embedded in a longer run of digits, letters or hyphens, so UUIDs and ids are untouched) has
//   that number replaced; a number that is a phone number is replaced whole.
import type { DB } from '@couli/db';

/** A non-null audit_logs.before / after value. */
export type Snapshot = NonNullable<JsonValue>;
type JsonValue = DB['audit_logs']['before'];

export const AUDIT_REDACTED = '[REDACTED]';

/** Normalised fragments; a key containing any of them is sensitive. */
export const AUDIT_SENSITIVE_FRAGMENTS = Object.freeze([
  'password',
  'secret',
  'token',
  'cipher',
  'hmac',
  'phone',
  'mobile',
  'idcard',
  'idno',
  'idnumber',
  'cardno',
  'cookie',
  'authorization',
] as const);

function normalized(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PHONE = /(?<![0-9A-Za-z-])(?:\+?86[ -]?)?1[3-9](?:[ -]?[0-9]){9}(?![0-9A-Za-z-])/g;

function redactPhones(text: string): string {
  return text.replace(PHONE, AUDIT_REDACTED);
}

/**
 * Returns a copy; the input is not mutated. `sensitiveKeys` are exact names (normalised)
 * added to the built-in fragments; the fragments always apply.
 */
export function redactSnapshot(value: Snapshot, sensitiveKeys: readonly string[] = []): Snapshot {
  const names = new Set(sensitiveKeys.map(normalized));
  const isSensitive = (key: string): boolean => {
    const name = normalized(key);
    if (name.endsWith('masked')) return false;
    return names.has(name) || AUDIT_SENSITIVE_FRAGMENTS.some((part) => name.includes(part));
  };
  const visit = (item: JsonValue): JsonValue => {
    if (item === null) return null;
    if (typeof item === 'string') return redactPhones(item);
    if (typeof item === 'number') {
      return redactPhones(String(item)) === String(item) ? item : AUDIT_REDACTED;
    }
    if (typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(visit);
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(item)) {
      if (child === undefined) continue;
      out[key] = isSensitive(key) ? AUDIT_REDACTED : visit(child);
    }
    return out;
  };
  // A non-null input maps to a non-null output.
  return visit(value) as Snapshot;
}

/**
 * B2-02zg skeleton (D10-3279): masks the personal data in one free-text value (normalise first, then
 * mask; see the task brief). Not implemented yet.
 */
export function redactFreeText(_text: string): string {
  throw new Error('NotImplemented: redactFreeText (B2-02zg)');
}
