// CT-07e (D10-1758 / D10-1765; 规划/01 F-ADM-10, 04 §3.2 pool_items.tags): the tags of a pool item
// and the `tag` filter of adminListPoolItems. One normalization for both: NFKC → trim → inner runs
// of whitespace become one space → empty strings dropped → duplicates after normalization dropped,
// the first occurrence kept in place (case is not folded). Nothing is truncated: a normalized tag of
// more than 16 code points, more than 10 tags, or a control character refuses the whole value.
// Rule tests: test/spec/catalog/pool-tags/**.

/** The normalized tags of a write, in input order; null when refused (20001 data.fields=[tags]). */
export function normalizePoolTags(input: readonly string[]): readonly string[] | null {
  void input;
  throw new Error('NotImplemented: normalizePoolTags');
}

/**
 * The normalized value of the list filter `tag`; null when refused (20001 data.fields=[tag]): longer
 * than 16 code points, a control character, or empty after normalization (only absent means no filter).
 */
export function normalizePoolTagFilter(input: string): string | null {
  void input;
  throw new Error('NotImplemented: normalizePoolTagFilter');
}
