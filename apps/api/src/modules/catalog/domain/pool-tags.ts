// CT-07e (D10-1758 / D10-1765; 规划/01 F-ADM-10, 04 §3.2 pool_items.tags): the tags of a pool item
// and the `tag` filter of adminListPoolItems. One normalization for both: NFKC → trim → inner runs
// of whitespace become one space → empty strings dropped → duplicates after normalization dropped,
// the first occurrence kept in place (case is not folded). Nothing is truncated: a normalized tag of
// more than 16 code points, more than 10 tags, or a control character refuses the whole value.
// Rule tests: test/spec/catalog/pool-tags/**.

/** At most this many tags on one item (after normalization). */
export const MAX_POOL_TAGS = 10;
/** At most this many Unicode code points in one tag (after normalization). */
export const MAX_POOL_TAG_CODE_POINTS = 16;

/** U+0000–U+001F and U+007F–U+009F (Unicode Cc). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** One tag as stored: NFKC, trimmed, every inner run of whitespace one space ('' when blank). */
function normalizeOne(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function acceptable(tag: string): boolean {
  return [...tag].length <= MAX_POOL_TAG_CODE_POINTS && !CONTROL.test(tag);
}

/** The normalized tags of a write, in input order; null when refused (20001 data.fields=[tags]). */
export function normalizePoolTags(input: readonly string[]): readonly string[] | null {
  const out: string[] = [];
  for (const raw of input) {
    const tag = normalizeOne(raw);
    if (tag === '' || out.includes(tag)) continue;
    if (!acceptable(tag)) return null;
    out.push(tag);
    if (out.length > MAX_POOL_TAGS) return null;
  }
  return out;
}

/**
 * The normalized value of the list filter `tag`; null when refused (20001 data.fields=[tag]): longer
 * than 16 code points, a control character, or empty after normalization (only absent means no filter).
 */
export function normalizePoolTagFilter(input: string): string | null {
  const tag = normalizeOne(input);
  return tag !== '' && acceptable(tag) ? tag : null;
}
