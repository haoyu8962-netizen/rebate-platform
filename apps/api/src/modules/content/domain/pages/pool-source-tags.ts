// CT-07f (D10-1986 / D10-1777 ②; 规划/01 F-ADM-10, 04 §3.2): saving a page normalizes the `tags`
// of each product_pool data source as pool items' tags are normalized. CT-07g (D10-2034): content
// keeps no normalization of its own; the one in catalog (catalog/index.ts normalizePoolTags) is
// handed in by app.module (ContentAdminOptions.normalizePoolTags → PageConfigAdmin) and called here
// for every product_pool data source whose tags are an array of strings ([] included). A list the
// normalizer refuses (null, outside catalog's bounds) or that normalizes to [] is refused with
// 20001 at that data source's tags (sections.N.data_source.tags): dropping every item would quietly
// turn "only the rows with these tags" into "no filter". Pure: the input is never changed.

/**
 * The normalization of a list of pool tags, in input order; null when the value is refused. Same
 * shape as catalog's PoolTagsNormalizer; content takes it as a port and never imports catalog.
 */
export type PoolSourceTagsNormalizer = (input: readonly string[]) => readonly string[] | null;

/** The sections as saved, or the refused tags fields when any. */
export type PoolSourceTagsResult =
  | { readonly ok: true; readonly sections: unknown }
  | { readonly ok: false; readonly fields: string[] };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * Each product_pool data source's string tags replaced by `normalize`'s answer (called once per such
 * data source); every other section, and a value that is not an array, as is. Refused when any of
 * those answers is null or [] — fields are `sections.N.data_source.tags`, in section order.
 */
export function normalizePoolSourceTags(
  sections: unknown,
  normalize: PoolSourceTagsNormalizer,
): PoolSourceTagsResult {
  if (!Array.isArray(sections)) return { ok: true, sections };
  const fields: string[] = [];
  const out = sections.map((section: unknown, index) => {
    // Anything but an array of strings is left for the shape check to refuse as sent.
    const tags = stringTags(section);
    if (tags === undefined) return section;
    const normalized = normalize(tags);
    if (normalized === null || normalized.length === 0) {
      fields.push(`sections.${String(index)}.data_source.tags`);
      return section;
    }
    const record = section as Readonly<Record<string, unknown>>;
    const source = record['data_source'] as Readonly<Record<string, unknown>>;
    return { ...record, data_source: { ...source, tags: [...normalized] } };
  });
  return fields.length > 0 ? { ok: false, fields } : { ok: true, sections: out };
}
