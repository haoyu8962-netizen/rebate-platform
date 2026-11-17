// CT-07f (D10-1986 / D10-1777 ②; 规划/01 F-ADM-10, 04 §3.2): saving a page normalizes the `tags`
// of each product_pool data source as pool items' tags are normalized: NFKC → trim → inner runs of
// whitespace one space → blanks dropped → duplicates after normalization dropped, the first
// occurrence kept in place (case not folded). The steps are those of catalog/domain/pool-tags.ts
// (normalizeOne + its de-duplication); content cannot import that file (modules-only-via-index, and
// catalog/index.ts already depends on content/index.ts, so importing it back would be a cycle), so
// the same steps are written here and both are pinned by test/spec/catalog/pool-tags*/**.
// Bounds (1–10 tags, 1–16 code points, no control character) stay with the home-schema check, which
// runs on the normalized sections. A list that normalizes to [] (sent as [] or all blanks) is
// refused on its own (20001, sections.N.data_source.tags): dropping every item would quietly turn
// "only the rows with these tags" into "no filter". Pure: the input is never changed.

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The normalized list of one data source's tags, in input order (blanks and duplicates dropped). */
export function normalizeSourceTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (tag !== '' && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The tags of a product_pool data source when they are an array of strings; else undefined. */
function stringTags(section: unknown): readonly string[] | undefined {
  if (!isRecord(section)) return undefined;
  const source = section['data_source'];
  if (!isRecord(source) || source['kind'] !== 'product_pool') return undefined;
  const tags = source['tags'];
  return Array.isArray(tags) && tags.every((tag) => typeof tag === 'string')
    ? (tags as string[])
    : undefined;
}

function normalizedSection(section: unknown): unknown {
  // Anything but an array of strings is left for the shape check to refuse as sent.
  const tags = stringTags(section);
  if (tags === undefined) return section;
  const record = section as Readonly<Record<string, unknown>>;
  const source = record['data_source'] as Readonly<Record<string, unknown>>;
  return { ...record, data_source: { ...source, tags: normalizeSourceTags(tags) } };
}

/** The sections as saved: product_pool tags normalized; a value that is not an array is returned as is. */
export function normalizePoolSourceTags(sections: unknown): unknown {
  return Array.isArray(sections) ? sections.map(normalizedSection) : sections;
}

/**
 * `sections.N.data_source.tags` of each product_pool data source whose tags are an array of strings
 * that normalizes to [] (sent empty or all blanks); [] when there is none.
 */
export function emptiedPoolSourceTagFields(sections: unknown): string[] {
  if (!Array.isArray(sections)) return [];
  const fields: string[] = [];
  sections.forEach((section: unknown, index) => {
    const tags = stringTags(section);
    if (tags !== undefined && normalizeSourceTags(tags).length === 0) {
      fields.push(`sections.${String(index)}.data_source.tags`);
    }
  });
  return fields;
}
