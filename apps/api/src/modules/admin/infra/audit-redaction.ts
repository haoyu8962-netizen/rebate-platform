// BR-ID-33 backstop for audit snapshots. Callers still mask; this keeps plaintext secrets and
// personal data out of the append-only audit_logs when a caller forgot, and masks the personal
// data an operator types into the free text of an audited operation (B2-02ze).
//
// Free-text masking is a CLOSED LIST of fixed formats (B2-02ze r5, D10-3166 ②, D10-2418 first
// option); nothing outside it is recognised:
//   1. mainland mobile numbers: 11 digits 1[3-9]…, optionally prefixed + / ＋ / 86 / 0086, common
//      separators between groups (rule 3 below); a prefixed number is bounded by its prefix, so a
//      letter right before the prefix does not stop it (WhatsApp+8613812345679 → WhatsApp138****5679);
//   2. identity numbers: 18 characters with a valid GB 11643 check character (X / x / Ｘ / ｘ), or
//      15 digits with a real date; half- and full-width digits alike, normalised before the check;
//   3. bank cards / payee accounts: 13–19 digits passing Luhn, in any separator form;
//   4. Alipay accounts: in the form of a mobile number (as 1) or of an e-mail address (rule 1
//      below; an address ends at an "@" right after its last label: alice@example.cn@财务 →
//      a***@***.cn@财务).
// Known residual risk, accepted: other personal data typed as free text (names, addresses, other
// formats) is not recognised; audit logs are readable only by authorised back-office staff and
// revealing is controlled separately.
//
// - Key names are normalised the way platform logging does it (lower case, non-alphanumerics
//   dropped). A key is sensitive when its normalised name equals one of the given names, or
//   CONTAINS one of AUDIT_SENSITIVE_FRAGMENTS (so totp_secret, totp_secret_cipher,
//   password_hash, verify_phone, verify_phone_hmac, refresh_token… are all caught). Its value
//   is replaced whole, whatever its type.
// - Exception: a key whose normalised name ends with `masked` (phone_masked) holds a display
//   mask the caller already produced, and is kept.
// - Free-text fields (B2-02ze, FU-AUDIT-REASON-FREE-TEXT-PII): a key that is not sensitive and
//   whose normalised name equals or ends with one of AUDIT_FREE_TEXT_KEYS (reason, note, notes,
//   remark, remarks, comment, comments, description, memo, message: so reject_note,
//   close_reason, review_comment… too; reason_code does not end with one) is free text, and so is
//   everything below it (nested objects and arrays; a sensitive key below it is still replaced
//   whole). Each string (and number, then written as its text when anything was masked) in free
//   text is masked value by value by redactFreeText:
//     1. e-mail addresses, recognised by the shape of an address, not split by script (B2-02ze
//        money r1 / r2): a local part of letters and digits of any script, marks and . _ % + -
//        (张san@x.cn and 邮箱alice@… are taken whole), "@", one or more labels of letters and
//        digits of any script, marks and "-" mixed freely (财务mail, 例子, xn--fsqu00a), each
//        followed by "." or "．", and a last label of two or more letters of one script family
//        (Latin / Greek / Cyrillic, or any other) or a Punycode label (xn--…); the last label
//        never takes in a next address glued on (….com和bob@… → two addresses). The first
//        character of the local part, "***@***.", the last label — alice.w@example.com →
//        a***@***.com, bob.lee+refund@mail.corp.example.cn → b***@***.cn, alice@例子.中国 →
//        a***@***.中国, alice@财务mail.example.cn → a***@***.cn (neither the local part nor the
//        domain stays as written). An "@" whose text meets white space or Chinese punctuation
//        before any "." is no address (转给财务@张三处理。, 价格@3.5元, @所有人 stay); "。" does not
//        separate labels (it ends sentences);
//     2. uuids (8-4-4-4-12 hex) are kept as they are and nothing inside them is matched;
//     3. digit runs: digits (ASCII or full-width), between two digits any number of separators
//        in any mix — a class, not a list (B2-02ze money r1 / r2): any white space (every Unicode
//        space separator, U+00A0, U+2007, U+202F, ideographic space; tab, line breaks), any dash
//        (\p{Pd}: -, ‐, –, —, ―, －…), slash (/ ／), dot (. ．), comma, underscore and middle dots
//        (· ・); an optional leading "+" / "＋" and an optional trailing X / x / Ｘ / ｘ. The digits between separators are the run's groups. Only what
//        is recognisably personal is masked (负责人 2026-11-21 「订单号不是敏感信息，不打码」,
//        D10-2354; the earlier 「宁可多脱敏」 is void). Prefixes and separators around a run do not
//        decide anything: card:6259651208437736, cardNo6259651208437736 and 6259651208437736 are
//        judged alike. The recognisers, on the digits of a span with its separators taken out:
//          - a mainland mobile number (11 digits 1[3-9]…, optionally preceded by 86 or 0086),
//            unless a letter, digit or hyphen touches the span from outside the run (the
//            boundary of the structured rule below; tel:13812345678 is masked; with a country
//            prefix only the end is checked, the prefix being its start, r5): BR-ID-33 3 + 4,
//            the 4 in the middle hidden, the country prefix (and "+" / "＋") dropped → 138****5678;
//          - an identity number: 18 characters (17 digits then a digit or X / x) whose last one
//            is the GB 11643 check character of the first 17 (weights 7 9 10 5 8 4 2 1 6 3 7 9
//            10 5 8 4 2, sum mod 11 → 1 0 X 9 8 7 6 5 4 3 2), or 15 digits whose 7th–12th
//            digits are a real date 19YY-MM-DD (no 02-31, 02-29 only in leap years): BR-ID-33
//            first 1 + last 1 hidden in between → 1****************X, 1*************2;
//          - a bank card or payee account: 13–19 digits passing the Luhn check (a trailing X /
//            x is not part of them and stays): all but the last 4 digits hidden, one "*" each
//            → ************7364 (no BIN, no leading digits; never a regrouping);
//        Judging (B2-02ze money r2, by principle): EVERY span of whole groups of the run — the
//        whole run, each group alone, every run of consecutive groups, overlapping ones included,
//        up to 19 digits — is checked by EVERY recogniser; one that matches never stops another
//        from being checked, on the same span or any other. Each match names the digits it
//        hides; a digit is hidden when ANY match hides it (the union, applied once). So what one
//        match shows (a card's last 4, an identity number's first digit, a mobile number's
//        138…5678) is shown only when no other match hides it: 6222 0371 9584 7364 03 (a card
//        and, as a whole, an 18-digit identity number) → *****************3; 1003 6222 0371 9584
//        7364 → ****************7364; 620005 138 1234 5679 (a 13-digit card 620005 138 1234 and
//        the mobile 138 1234 5679) → *************5679. The separators inside a matched span are
//        dropped and its digits written as ASCII; the other groups and separators stay. A group
//        is never cut inside, so 20 digits written together stay. Anything matched by nothing
//        stays as written: a long number failing Luhn (order numbers, references, a card
//        mistyped by one digit), 12 digits or fewer, 20 digits or more written together, an
//        18-character number with a wrong check character, a 15-digit one without a date.
//        Known costs, accepted: about one order number in ten passes Luhn (or an identity check)
//        by chance and is masked; a card mistyped by one digit fails Luhn and is not masked; a
//        number of more than 19 digits written in groups is masked as a card when a span of its
//        groups passes Luhn (6222 0371 9584 7364 1230, a 20-digit reference whose first 16
//        digits pass, → ************7364 1230): BR-ID-33 first, the two cannot be told apart;
//        a number matched twice shows less than either match alone (an 18-digit identity number
//        that also passes Luhn → *****************4); numbers on separate lines or separated by
//        " / " are judged as one run (only recognised spans are masked, so this only ever masks
//        more); Chinese text shaped like an address is masked as one (小王@财务部.请核对 →
//        小***@***.请核对; 邮箱alice@example.com → 邮***@***.com, the word before it taken in).
//   Free text that matches nothing is not changed.
// - Values outside free text (structured fields: *_fen amounts, ids, idempotency keys, codes,
//   target) get no value pattern of the free text: only, as before, a string or number that
//   contains a mainland mobile number (11 digits starting with 1[3-9], optionally +86 / 86,
//   optional single spaces or hyphens between digit groups, not embedded in a longer run of
//   digits, letters or hyphens, so UUIDs and ids are untouched) has that number replaced by
//   [REDACTED]; a number that is a phone number is replaced whole.
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
// Free text (B2-02ze).

/** Letters of the Latin, Greek and Cyrillic scripts. */
const WESTERN = '\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}';
/** One letter of any other script (CJK, kana, hangul, Arabic…): a letter that is not WESTERN. */
const OTHER_LETTER = `[^\\P{L}${WESTERN}]`;
/** Letters of any script, digits of any script, combining marks: mixed freely (B2-02ze money r2). */
const WORD = '\\p{L}\\p{N}\\p{M}';
const LOCAL = `[${WORD}._%+\\-]+`;
const LABEL = `[${WORD}\\-]+`;
const LABEL_DOT = '[.\\uFF0E]';
/** The local part of a next address glued on: a last label never takes it in. */
const NEXT_ADDRESS = `${LOCAL}@`;
/**
 * The last label (shown): Punycode, or two or more letters of one script family — all of them,
 * up to the first character that is not such a letter (and not "@"); when the next address is
 * glued on (….combob@…), the shortest label that leaves that address whole.
 */
const TOP_LABEL =
  `(xn--[A-Za-z0-9-]+(?![A-Za-z0-9-])` +
  `|[${WESTERN}]{2,}(?![${WESTERN}\\p{M}@])` +
  `|${OTHER_LETTER}{2,}(?!${OTHER_LETTER}|[\\p{M}@])` +
  `|[${WESTERN}]{2,}?(?=${NEXT_ADDRESS})` +
  `|${OTHER_LETTER}{2,}?(?=${NEXT_ADDRESS})` +
  // r5 S0 (alice@example.cn@财务): when no next address follows, an "@" right after the last label
  // ends the address there; the address before it is masked as usual.
  `|[${WESTERN}]{2,}(?=@)` +
  `|${OTHER_LETTER}{2,}(?=@))`;
const EMAIL = new RegExp(`${LOCAL}@(?:${LABEL}${LABEL_DOT})+${TOP_LABEL}`, 'gu');
const UUID = /([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/;
const DIGIT = '[0-9\\uFF10-\\uFF19]';
/** A leading plus, half- or full-width (＋). */
const PLUS = '[+\\uFF0B]';
/** A trailing check character X / x, half- or full-width (Ｘ ｘ; r5 S0). */
const CHECK_X = '[Xx\\uFF38\\uFF58]';
/**
 * A class, not a list (B2-02ze money r2): any white space (\s with every Unicode space separator:
 * U+00A0, U+2007, U+202F, ideographic space, tab, line breaks…), any dash (\p{Pd}), slash, dot,
 * full-width dot and slash, and the other digit-grouping marks: comma, underscore, middle dots.
 */
const SEPARATOR = '[\\s\\p{Zs}\\p{Pd}/.\\uFF0E\\uFF0F,_\\u00B7\\u30FB]';
/** Any number of separators, in any mix, may stand between two digits. */
const DIGIT_RUN = new RegExp(`${PLUS}?${DIGIT}(?:${SEPARATOR}*${DIGIT})*${CHECK_X}?`, 'gu');
const MOBILE = /^(?:0086|86)?(1[3-9][0-9]{9})$/;
/** A letter, digit or hyphen right next to a mobile number makes it part of something else. */
const TOUCHING = /[0-9A-Za-z\uFF10-\uFF19-]/;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECKS = '10X98765432';
/** A card or payee account has 13–19 digits. */
const CARD_MIN = 13;
const CARD_MAX = 19;

function maskEmail(address: string, tld: string): string {
  // The first code point (a CJK local part may start outside the BMP).
  return `${String.fromCodePoint(address.codePointAt(0)!)}***@***.${tld}`;
}

/** Full-width digits and Ｘ / ｘ to ASCII; everything else but digits and X dropped. */
function digitsOf(run: string): string {
  return run
    .replace(/[０-９Ｘｘ]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[^0-9Xx]/g, '');
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

/** What the recognisers ask of one span: positions (indexes into its characters) to hide / drop. */
interface Verdict {
  readonly hidden: readonly number[];
  /** A mobile number's country prefix: dropped, not starred. */
  readonly dropped: readonly number[];
  readonly mobile: boolean;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
}

/**
 * Every recogniser on one span of whole groups (its digits, maybe a trailing X / x), ALL of them:
 * one that matches never stops another from being checked (B2-02ze money r2). Null when none
 * matches.
 */
function judge(chars: string, mobileAllowed: boolean, prefixedAllowed: boolean): Verdict | null {
  const hidden: number[] = [];
  const dropped: number[] = [];
  let mobile = false;
  let hit = false;
  if (chars.length === 18 && isIdentity18(chars)) {
    hidden.push(...range(1, 17));
    hit = true;
  }
  // A trailing X is no digit of a card, mobile or 15-digit number: it stays.
  const digits = chars.replace(/[Xx]$/, '');
  const number = MOBILE.exec(digits);
  // A number written with its country prefix (86 / 0086) is bounded by the prefix: a letter
  // right before the prefix does not stop it (r5 S0, WhatsApp+8613812345679).
  if (number !== null && (digits.length === 11 ? mobileAllowed : prefixedAllowed)) {
    const prefix = digits.length - 11;
    dropped.push(...range(0, prefix));
    hidden.push(...range(prefix + 3, prefix + 7));
    mobile = true;
    hit = true;
  }
  if (isIdentity15(digits)) {
    hidden.push(...range(1, 14));
    hit = true;
  }
  if (digits.length >= CARD_MIN && digits.length <= CARD_MAX && passesLuhn(digits)) {
    hidden.push(...range(0, digits.length - 4));
    hit = true;
  }
  return hit ? { hidden, dropped, mobile } : null;
}

/**
 * One digit run (header, rule 3). Its groups are the digits between separators. Every span of
 * whole groups (the whole run and each group alone included) is judged by every recogniser; a
 * digit is hidden when ANY verdict hides it (the union, applied once), so what one candidate
 * shows never shows digits another hides. The separators inside a recognised span are dropped,
 * the others stay; a run nothing recognises is not changed.
 */
function maskRun(run: string, offset: number, text: string): string {
  const plus = run.startsWith('+') || run.startsWith('\uFF0B');
  const body = plus ? run.slice(1) : run;
  const touchesStart = TOUCHING.test(text.charAt(plus ? offset : offset - 1));
  const touchesEnd = TOUCHING.test(text.charAt(offset + run.length));
  // Cells: the digits (and a trailing X) of the run, by their index in `body`.
  const cells: { readonly at: number; readonly char: string }[] = [];
  const groups: { first: number; last: number }[] = [];
  let previous = -2;
  for (let at = 0; at < body.length; at += 1) {
    const char = digitsOf(body.charAt(at));
    if (char === '') continue;
    if (at !== previous + 1) groups.push({ first: cells.length, last: cells.length });
    groups[groups.length - 1]!.last = cells.length;
    cells.push({ at, char });
    previous = at;
  }
  const hidden = new Set<number>();
  const dropped = new Set<number>();
  /** Group g and g + 1 are inside one recognised span: the separators between them are dropped. */
  const joined = new Set<number>();
  /** Digits inside a recognised span: written as ASCII digits (６２２２… → ****…7364). */
  const covered = new Set<number>();
  let dropPlus = false;
  for (let i = 0; i < groups.length; i += 1) {
    let chars = '';
    for (let j = i; j < groups.length; j += 1) {
      const group = groups[j]!;
      for (let c = group.first; c <= group.last; c += 1) chars += cells[c]!.char;
      if (chars.replace(/[Xx]$/, '').length > CARD_MAX) break;
      const endFree = j < groups.length - 1 || !touchesEnd;
      const mobileAllowed = (i > 0 || !touchesStart) && endFree;
      const verdict = judge(chars, mobileAllowed, endFree);
      if (verdict === null) continue;
      const base = groups[i]!.first;
      for (const position of verdict.hidden) hidden.add(cells[base + position]!.at);
      for (const position of verdict.dropped) dropped.add(cells[base + position]!.at);
      for (let g = i; g < j; g += 1) joined.add(g);
      for (let c = groups[i]!.first; c <= groups[j]!.last; c += 1) covered.add(cells[c]!.at);
      // A mobile number drops its country prefix, "+" included.
      if (verdict.mobile && i === 0) dropPlus = true;
    }
  }
  if (hidden.size === 0 && dropped.size === 0) return run;
  let out = plus && !dropPlus ? '+' : '';
  let group = 0;
  for (let at = 0; at < body.length; at += 1) {
    const char = body.charAt(at);
    if (digitsOf(char) !== '') {
      if (at > 0 && digitsOf(body.charAt(at - 1)) === '') group += 1;
      if (!dropped.has(at)) out += hidden.has(at) ? '*' : covered.has(at) ? digitsOf(char) : char;
    } else if (!joined.has(group)) {
      out += char;
    }
  }
  return out;
}

function maskNumbers(text: string): string {
  return text.replace(DIGIT_RUN, (run: string, offset: number) => maskRun(run, offset, text));
}

/** BR-ID-33 value masking of one free-text string (rules in the header). */
export function redactFreeText(text: string): string {
  const withoutEmails = text.replace(EMAIL, (address: string, tld: string) =>
    maskEmail(address, tld),
  );
  // Odd parts are uuids, kept whole; the digit rules see each other part on its own.
  return withoutEmails
    .split(UUID)
    .map((part, index) => (index % 2 === 1 ? part : maskNumbers(part)))
    .join('');
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
