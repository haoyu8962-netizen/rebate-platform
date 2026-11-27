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
//     2. Runs holding an "@" (decided before rule 3): the normalised text is cut at white space
//        (\s: space, tab, line breaks, U+2028 / U+2029, NBSP, U+202F, ideographic space…) into
//        runs of non-blank characters. A run holding an "@" (＠ normalises to it) is written as
//        「***」 whole, whatever is on either side of the "@": letters, digits, dashes, minus
//        signs, CJK, punctuation, quotes and brackets in the run go with it, and no domain is
//        shown (邮箱（alice@example.com）已核 → ***, 请 @张三 处理 → 请 *** 处理). The white
//        space around the run stays as written. Digits in such a run are no mobile, identity
//        number, card or fallback of their own.
//     3. Digit runs (outside runs holding an "@"): ASCII digits with any number of separators
//        between two digits, maybe followed (after separators) by X / x (see below for when). On
//        the digits (and the X), separators taken out, in this order:
//          - 18 digits with a correct check digit → identity number; what follows (an X too,
//            glued or after white space: 110105199003071239 X先生) is not part of it;
//          - more than 18 digits whose first 18 have a correct check digit, and a separator
//            right after the 18th digit in the text → the first 18 are an identity number, the
//            separator stays as written and the digits after it are a run of their own
//            (110105199003071239<tab>2 → 1****************9<tab>2); 19 digits written together,
//            or a 4-4-4-4-3 card whose 18th digit sits inside a group, are not split;
//          - else 17 digits followed directly, or after one separator, by X / x, with a correct
//            GB 11643 check character → identity number with the X, whatever follows the X
//            (证件11010519491231002X已核);
//          - else 11 or more digits followed (after separators) by an X that no ASCII letter or
//            digit follows → the fallback, the X counted as its last character;
//          - 11 digits 1[3-9]…, or 86 followed by them → mobile, 3 + 4: the 4 digits after the
//            first 3 of the number starred (138****5678; the 86 prefix kept);
//          - 15 digits whose 7th–12th are a real date 19YY-MM-DD → identity number, first 1 + last 1 (1****************X, 1*************2);
//          - 13–19 digits passing Luhn → card, only the last 4 shown;
//          - otherwise 11 or more digits → the fallback, only the last 4 characters shown (order
//            numbers, references, numbers failing Luhn or a check, digits glued to letters, a uuid
//            whose dashes join its digits). No boundary test: letters around a run change nothing.
//          - fewer than 11 digits: as written.
//        One star per hidden digit; separators inside a run stay as written.
//     4. Mapping back: masks are decided on the normalised text and written back character by
//        character of the original. An original character none of whose normalised characters
//        is masked stays as written (full-width digits, ㎡, ①…); one that is
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
const ASCII_LETTER_OR_DIGIT = /^[0-9A-Za-z]$/;
const MOBILE = /^(?:86)?1[3-9][0-9]{9}$/;
const FALLBACK_MIN = 11;
const CARD_MIN = 13;
const CARD_MAX = 19;
const SHOWN = 4;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECKS = '10X98765432';

const BLANK = /^\s$/u;
const ID_LENGTH = 18;

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
  // An X is only taken in by maskRuns as an identity number's check character or as the last
  // character of the fallback.
  if (withX) return isIdentity18(chars) ? identity : tailOnly;
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
 * Rule 2 on the normalised characters: every run of non-blank characters holding an "@" is
 * written as 「***」 (masks) and marked in `taken`, so rule 3 does not look at its digits.
 */
function maskAtRuns(chars: readonly string[], masks: (string | undefined)[], taken: boolean[]) {
  let from = 0;
  while (from < chars.length) {
    if (BLANK.test(chars[from]!)) {
      from += 1;
      continue;
    }
    let to = from;
    let hasAt = false;
    while (to < chars.length && !BLANK.test(chars[to]!)) {
      if (chars[to] === '@') hasAt = true;
      to += 1;
    }
    if (hasAt) {
      for (let p = from; p < to; p += 1) {
        taken[p] = true;
        masks[p] = p === from ? '***' : '';
      }
    }
    from = to;
  }
}

const isX = (char: string | undefined): boolean => char === 'X' || char === 'x';

/**
 * Rule 3: the position of the X / x taken into the run whose digits are at `positions`, if any.
 * In this order: 18 digits that are an identity number take none; 17 digits take an X right
 * after them or after one separator when the 18 characters are an identity number; otherwise an
 * X after any separators is taken (into the fallback) unless an ASCII letter or digit follows it.
 */
function xAfter(
  chars: readonly string[],
  positions: readonly number[],
  free: (p: number) => boolean,
): number | undefined {
  const digits = positions.map((at) => chars[at]!).join('');
  if (digits.length === 18 && isIdentity18(digits)) return undefined;
  const last = positions[positions.length - 1]!;
  if (digits.length === 17) {
    for (const x of [last + 1, last + 2]) {
      if (x === last + 2 && !(free(last + 1) && SEPARATOR.test(chars[last + 1]!))) break;
      if (free(x) && isX(chars[x]) && isIdentity18(digits + chars[x]!)) return x;
    }
  }
  if (digits.length < FALLBACK_MIN) return undefined;
  let x = last + 1;
  while (free(x) && SEPARATOR.test(chars[x]!)) x += 1;
  if (!free(x) || !isX(chars[x])) return undefined;
  return free(x + 1) && ASCII_LETTER_OR_DIGIT.test(chars[x + 1]!) ? undefined : x;
}

/** Rule 3 on the normalised characters outside runs holding an "@". */
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
    const head = positions.slice(0, ID_LENGTH);
    const afterHead = head[ID_LENGTH - 1]! + 1;
    if (
      positions.length > ID_LENGTH &&
      SEPARATOR.test(chars[afterHead]!) &&
      isIdentity18(head.map((at) => chars[at]!).join(''))
    ) {
      // An identity number, then a separator: the digits after it are scanned on their own.
      positions.length = ID_LENGTH;
    } else {
      const xAt = xAfter(chars, positions, free);
      if (xAt !== undefined) positions.push(xAt);
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
  maskAtRuns(chars, masks, taken);
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
