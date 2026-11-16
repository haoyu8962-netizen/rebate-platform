// CT-07e (D10-1777 ②; 规划/04 §3.2): saving a page normalizes the `tags` of each product_pool data
// source as pool items' tags are normalized (catalog/domain/pool-tags.ts; content does not import
// catalog): NFKC → trim → inner runs of whitespace one space → blanks dropped → duplicates after
// normalization dropped, the first occurrence kept in place (case not folded). Bounds (1–10 tags,
// 1–16 code points, no control character) stay with the home-schema check, which runs on the
// normalized sections. A non-empty list that normalizes to [] is refused on its own (20001,
// sections.N.data_source.tags), since dropping every item would silently turn "only items with these
// tags" into "no filter". Pure: the input is never changed; a section without such a field is returned
// as is.

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

/** The sections as saved: product_pool tags normalized; anything that is not an array is returned as is. */
export function normalizePoolSourceTags(sections: unknown): unknown {
  return Array.isArray(sections) ? sections.map(normalizedSection) : sections;
}

/**
 * `sections.N.data_source.tags` of each product_pool data source whose tags were sent non-empty and
 * normalize to [] (all blanks); [] when there is none.
 */
export function emptiedPoolSourceTagFields(sections: unknown): string[] {
  if (!Array.isArray(sections)) return [];
  const fields: string[] = [];
  sections.forEach((section, index) => {
    const tags = stringTags(section);
    if (tags !== undefined && tags.length > 0 && normalizeSourceTags(tags).length === 0) {
      fields.push(`sections.${index}.data_source.tags`);
    }
  });
  return fields;
}
