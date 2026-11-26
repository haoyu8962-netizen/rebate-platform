// BR-ID-33 backstop for audit snapshots. Callers still mask; this keeps plaintext secrets and
// personal data out of the append-only audit_logs when a caller forgot, and masks the personal
// data an operator types into the free text of an audited operation.
//
// - Key names are normalised the way platform logging does it (lower case, non-alphanumerics
//   dropped). A key is sensitive when its normalised name equals one of the given names, or
//   CONTAINS one of AUDIT_SENSITIVE_FRAGMENTS (so totp_secret, totp_secret_cipher,
//   password_hash, verify_phone, verify_phone_hmac, refresh_token… are all caught). Its value
//   is replaced whole, whatever its type.
// - Exception: a key whose normalised name ends with `masked` (phone_masked) holds a display
//   mask the caller already produced, and is kept.
// - Free-text fields: a key that is not sensitive and whose normalised name equals or ends with
//   one of AUDIT_FREE_TEXT_KEYS (reason, note, notes, remark, remarks, comment, comments,
//   description, memo, message: so reject_note, close_reason, review_comment… too; reason_code
//   does not end with one) is free text, and so is everything below it (nested objects and
//   arrays; a sensitive key below it is still replaced whole). Each string (and number, then
//   written as its text when anything was masked) in free text goes through redactFreeText:
//   normalise first, then mask (D10-3266).
//     1. Normalise: each user-perceived character (a grapheme cluster: a base character with
//        the combining marks after it, so e + U+0301 is one character, é) to its Unicode NFKC
//        form (full-width digits, letters, ＠ and ． become ASCII; ①, ⑩, ㎡ expand to their
//        characters). On the normalised text, every
//        white space (\s: space, tab, line breaks, U+2028 / U+2029, NBSP, U+202F, ideographic
//        space…) and every dash or minus (\p{Pd} and U+2212) is a separator. `/ . , _` are no
//        separators.
//     2. E-mail-shaped text: an "@" with non-blank text on both sides. Each side runs from the
//        "@" up to white space, another "@", ASCII `, ; : ! ? ( ) [ ] { } " ' < > = & | \ /` or
//        any other (non-ASCII) punctuation (，。、；：（）「」【】《》！？…); dots at the end of the right side
//        are sentence punctuation, not part of it. On the left side an apostrophe with a character
//        of the address before it belongs to the address (mary.o'connor@…); one with white space,
//        punctuation or the start of the text before it is a quote and ends the side. A right side shaped like a domain (labels of
//        letters, digits, marks and "-" joined by ".", the last one two or more letters or
//        xn--…) is shown as written and the left side keeps its first 2 characters (1 when it
//        has 2, none when it has 1; characters counted as grapheme clusters of the normalised
//        text) followed by 「***」: zhangsan@example.com → zh***@example.com.
//        Any other right side: the whole piece but "@" is starred (alice@localhost →
//        *****@*********).
//     3. Digit runs (outside e-mail-shaped text): ASCII digits with any number of separators
//        between two digits, maybe followed (after separators) by X / x (see below for when). On
//        the digits (and the X), separators taken out, in this order:
//          - with an X: 17 digits + X with a correct GB 11643 check character → identity number,
//            whatever follows the X (证件11010519491231002X已核); anything else of 11 or more
//            digits with an X that no ASCII letter or digit follows → the fallback (the X counts
//            as its last character);
//          - 11 digits 1[3-9]…, or 86 followed by them → mobile, 3 + 4: the 4 digits after the
//            first 3 of the number starred (138****5678; the 86 prefix kept);
//          - 18 digits with a correct check digit, or 15 digits whose 7th–12th are a real date
//            19YY-MM-DD → identity number, first 1 + last 1 (1****************X, 1*************2);
//          - 13–19 digits passing Luhn → card, only the last 4 shown;
//          - otherwise 11 or more digits → the fallback, only the last 4 characters shown (order
//            numbers, references, numbers failing Luhn or a check, digits glued to letters, a uuid
//            whose dashes join its digits). No boundary test: letters around a run change nothing.
//          - fewer than 11 digits: as written.
//        One star per hidden digit; separators inside a run stay as written.
//     4. Mapping back: masks are decided on the normalised text and written back character by
//        character of the original. An original character none of whose normalised characters
//        is masked stays as written (full-width digits, ＠, the domain, ㎡, ①…); one that is
//        (partly) masked is written as its normalised characters with the masked ones replaced
//        (⑩ with its 1 hidden → *0), so no expansion is kept whole across a mask.
//   Free text that matches nothing is not changed.
// - Values outside free text (structured fields: *_fen amounts, ids, idempotency keys, codes,
//   target) get no value pattern of the free text: only a string or number that contains a
//   mainland mobile number (11 digits starting with 1[3-9], optionally +86 / 86, optional single
//   spaces or hyphens between digit groups, not embedded in a longer run of digits, letters or
//   hyphens, so UUIDs and ids are untouched) has that number replaced by [REDACTED]; a number
//   that is a phone number is replaced whole.
// - Audit rows written before this change are not rewritten (no backfill).
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

/** Normalised names; a key equal to or ending with one of them holds free text (B2-02ze). */
export const AUDIT_FREE_TEXT_KEYS = Object.freeze([
  'reason',
  'note',
  'notes',
  'remark',
  'remarks',
  'comment',
  'comments',
  'description',
  'memo',
  'message',
] as const);

function normalized(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PHONE = /(?<![0-9A-Za-z-])(?:\+?86[ -]?)?1[3-9](?:[ -]?[0-9]){9}(?![0-9A-Za-z-])/g;

function redactPhones(text: string): string {
  return text.replace(PHONE, AUDIT_REDACTED);
}

// ------------------------------------------------------------------------------------------
// Free text (rules 1–4 of the header).

/**
 * The original text by grapheme cluster, its NFKC form by code point, and where each came from.
 */
interface Normalised {
  readonly source: readonly string[];
  readonly chars: readonly string[];
  /** starts[i] … starts[i + 1] are the normalised positions of source[i]. */
  readonly starts: readonly number[];
}

const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });

function normalise(text: string): Normalised {
  const source = Array.from(GRAPHEMES.segment(text), (part) => part.segment);
  const chars: string[] = [];
  const starts: number[] = [];
  for (const char of source) {
    starts.push(chars.length);
    chars.push(...Array.from(char.normalize('NFKC')));
  }
  starts.push(chars.length);
  return { source, chars, starts };
}

/** Rule 1: white space and dashes (U+2212 included) are separators; nothing else is. */
const SEPARATOR = /^[\s\p{Pd}\u2212]$/u;
const DIGIT = /^[0-9]$/;
/** Rule 2: where a side of an e-mail-shaped piece ends (besides "@"). */
const ASCII_STOP = /^[\s,;:!?()[\]{}"'<>=&|\\/]$/u;
const PUNCTUATION = /^\p{P}$/u;
/** Labels joined by dots; the last of two or more letters, or Punycode. */
const DOMAIN = /^(?:[\p{L}\p{N}\p{M}-]+\.)+(?:\p{L}{2,}|xn--[A-Za-z0-9-]+)$/iu;
const ASCII_LETTER_OR_DIGIT = /^[0-9A-Za-z]$/;
const MOBILE = /^(?:86)?1[3-9][0-9]{9}$/;
const FALLBACK_MIN = 11;
const CARD_MIN = 13;
const CARD_MAX = 19;
const SHOWN = 4;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECKS = '10X98765432';

function endsSide(char: string): boolean {
  return (
    char === '@' || ASCII_STOP.test(char) || (char.codePointAt(0)! > 0x7f && PUNCTUATION.test(char))
  );
}

/** Rule 2: the left side goes on past `chars[at - 1]` (the character just left of the side). */
function leftGoesOn(chars: readonly string[], at: number, floor: number): boolean {
  const char = chars[at - 1]!;
  if (char !== "'") return !endsSide(char);
  return at - 1 > floor && !endsSide(chars[at - 2]!);
}

function passesLuhn(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits.charAt(digits.length - 1 - i));
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
  }
  return total % 10 === 0;
}

/** 18 characters whose last is the GB 11643 check character of the first 17 digits. */
function isIdentity18(chars: string): boolean {
  if (!/^[0-9]{17}[0-9Xx]$/.test(chars)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(chars.charAt(i)) * ID_WEIGHTS[i]!;
  return ID_CHECKS.charAt(sum % 11) === chars.charAt(17).toUpperCase();
}

/** 15 digits whose 7th–12th digits are a real date 19YY-MM-DD. */
function isIdentity15(digits: string): boolean {
  if (!/^[0-9]{15}$/.test(digits)) return false;
  const year = 1900 + Number(digits.slice(6, 8));
  const month = Number(digits.slice(8, 10));
  const day = Number(digits.slice(10, 12));
  if (month < 1 || month > 12 || day < 1) return false;
  // Plain calendar arithmetic (no Date: app code reads time only through the Clock).
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

/**
 * Indexes (into the run's characters: its digits, then the X if any) to star, by rule 3. Empty
 * when the run stays as written.
 */
function hiddenOfRun(chars: string): number[] {
  const range = (from: number, to: number): number[] =>
    Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
  const withX = /[Xx]$/.test(chars);
  const digits = withX ? chars.slice(0, -1) : chars;
  const identity = range(1, chars.length - 1);
  const tailOnly = range(0, chars.length - SHOWN);
  if (withX) {
    if (chars.length === 18 && isIdentity18(chars)) return identity;
    return digits.length >= FALLBACK_MIN ? tailOnly : [];
  }
  if (MOBILE.test(digits)) {
    const start = digits.length - 11;
    return range(start + 3, start + 7);
  }
  if ((digits.length === 18 && isIdentity18(digits)) || isIdentity15(digits)) return identity;
  if (digits.length >= CARD_MIN && digits.length <= CARD_MAX && passesLuhn(digits)) {
    return tailOnly;
  }
  return digits.length >= FALLBACK_MIN ? tailOnly : [];
}

/**
 * Rule 2 on the normalised characters: writes the masks of every e-mail-shaped piece into
 * `masks` and marks its positions in `taken`.
 */
function maskEmails(chars: readonly string[], masks: (string | undefined)[], taken: boolean[]) {
  let floor = 0;
  for (let at = 0; at < chars.length; at += 1) {
    if (chars[at] !== '@') continue;
    let left = at;
    while (left > floor && leftGoesOn(chars, left, floor)) left -= 1;
    let right = at + 1;
    while (right < chars.length && !endsSide(chars[right]!)) right += 1;
    // Dots at the end are sentence punctuation (alice@example.com. → the address ends at com).
    while (right > at + 1 && chars[right - 1] === '.') right -= 1;
    if (left === at || right === at + 1) continue;
    for (let p = left; p < right; p += 1) taken[p] = true;
    if (DOMAIN.test(chars.slice(at + 1, right).join(''))) {
      // Counted in user-perceived characters of the normalised text (b + U+0301 is one).
      const local = Array.from(GRAPHEMES.segment(chars.slice(left, at).join('')), (part) =>
        Array.from(part.segment),
      );
      const shown = local.length >= 3 ? 2 : local.length === 2 ? 1 : 0;
      const kept = left + local.slice(0, shown).reduce((total, part) => total + part.length, 0);
      masks[kept] = '***';
      for (let p = kept + 1; p < at; p += 1) masks[p] = '';
    } else {
      for (let p = left; p < right; p += 1) if (p !== at) masks[p] = '*';
    }
    floor = right;
    at = right - 1;
  }
}

/** Rule 3 on the normalised characters outside e-mail-shaped pieces. */
function maskRuns(chars: readonly string[], masks: (string | undefined)[], taken: boolean[]) {
  const free = (p: number): boolean => p < chars.length && !taken[p];
  let p = 0;
  while (p < chars.length) {
    if (!free(p) || !DIGIT.test(chars[p]!)) {
      p += 1;
      continue;
    }
    const positions = [p];
    let q = p + 1;
    while (free(q) && (DIGIT.test(chars[q]!) || SEPARATOR.test(chars[q]!))) {
      if (DIGIT.test(chars[q]!)) positions.push(q);
      q += 1;
    }
    const last = positions[positions.length - 1]!;
    let x = last + 1;
    while (free(x) && SEPARATOR.test(chars[x]!)) x += 1;
    if (free(x) && (chars[x] === 'X' || chars[x] === 'x')) {
      const digits = positions.map((at) => chars[at]!).join('');
      const identity = digits.length === 17 && isIdentity18(digits + chars[x]!);
      if (identity || !(free(x + 1) && ASCII_LETTER_OR_DIGIT.test(chars[x + 1]!))) {
        positions.push(x);
      }
    }
    const run = positions.map((at) => chars[at]!).join('');
    for (const index of hiddenOfRun(run)) masks[positions[index]!] = '*';
    p = positions[positions.length - 1]! + 1;
  }
}

/** BR-ID-33 value masking of one free-text string (rules in the header). */
export function redactFreeText(text: string): string {
  const { source, chars, starts } = normalise(text);
  /** Per normalised position: undefined = kept, otherwise what it is written as. */
  const masks: (string | undefined)[] = new Array<string | undefined>(chars.length);
  const taken: boolean[] = new Array<boolean>(chars.length).fill(false);
  maskEmails(chars, masks, taken);
  maskRuns(chars, masks, taken);
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const from = starts[i]!;
    const to = starts[i + 1]!;
    let touched = false;
    for (let p = from; p < to; p += 1) if (masks[p] !== undefined) touched = true;
    if (!touched) {
      out += source[i]!;
      continue;
    }
    for (let p = from; p < to; p += 1) out += masks[p] ?? chars[p]!;
  }
  return out;
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
  const isFreeText = (key: string): boolean => {
    const name = normalized(key);
    return AUDIT_FREE_TEXT_KEYS.some((part) => name === part || name.endsWith(part));
  };
  const visit = (item: JsonValue, free: boolean): JsonValue => {
    if (item === null) return null;
    if (typeof item === 'string') return free ? redactFreeText(item) : redactPhones(item);
    if (typeof item === 'number') {
      const text = String(item);
      if (free) {
        const masked = redactFreeText(text);
        return masked === text ? item : masked;
      }
      return redactPhones(text) === text ? item : AUDIT_REDACTED;
    }
    if (typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map((child) => visit(child, free));
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(item)) {
      if (child === undefined) continue;
      out[key] = isSensitive(key) ? AUDIT_REDACTED : visit(child, free || isFreeText(key));
    }
    return out;
  };
  // A non-null input maps to a non-null output.
  return visit(value, false) as Snapshot;
}
