// CT-07e: the tag rules written out step by step (D10-1758 / D10-1765), for the rule tests only.
// The tests feed it characters whose NFKC form and whitespace class are unambiguous, so "whitespace"
// below is only the plain space that U+3000 and U+00A0 become under NFKC.

/** U+3000 IDEOGRAPHIC SPACE and U+00A0 NO-BREAK SPACE: both a plain space after NFKC. */
export const WIDE_SPACE = String.fromCodePoint(0x3000);
export const NBSP = String.fromCodePoint(0xa0);

/** Control characters (Unicode Cc) the tests use; none of them is whitespace. */
export const CONTROL_CHARS: readonly string[] = ['\u0000', '\u0007', '\u001b', '\u007f', '\u009f'];

/** U+0000–U+001F and U+007F–U+009F. */
export function hasControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

export const MAX_TAGS = 10;
export const MAX_TAG_CODE_POINTS = 16;

export function codePoints(value: string): number {
  return [...value].length;
}

function normalizeOne(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function refused(tag: string): boolean {
  return codePoints(tag) > MAX_TAG_CODE_POINTS || hasControl(tag);
}

/** The tags a write stores, or null when the whole value is refused. */
export function modelTags(input: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of input) {
    const tag = normalizeOne(raw);
    if (tag === '' || out.includes(tag)) continue;
    out.push(tag);
  }
  if (out.length > MAX_TAGS || out.some(refused)) return null;
  return out;
}

/** The list filter's value, or null when refused (empty after normalization included). */
export function modelTag(input: string): string | null {
  const tag = normalizeOne(input);
  return tag === '' || refused(tag) ? null : tag;
}

/** The tags field of a row or wire item, whatever its declared type (undefined when absent). */
export function tagsOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)['tags']
    : undefined;
}

/** Ten distinct valid tags and one more. */
export const TEN_TAGS: readonly string[] = Array.from(
  { length: MAX_TAGS },
  (_unused, index) => `标签${String(index)}`,
);
export const ELEVEN_TAGS: readonly string[] = [...TEN_TAGS, '标签10'];
