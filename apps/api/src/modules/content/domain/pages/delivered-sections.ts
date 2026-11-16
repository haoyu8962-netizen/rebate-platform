// CT-07e (D10-1758; 规划/04 §3.2): the tags of a product_pool data source are the server's filter
// (catalog reads the section through PageReader.section and delivers only the matching items), so a
// page delivered to the apps and H5 — getPage and previewPage — carries no tag field. Pure: the
// stored and cached sections are never changed; a section without such a field is returned as is.

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One section as delivered: a product_pool data source loses `tags`, nothing else changes. */
export function deliveredSection(section: Record<string, unknown>): Record<string, unknown> {
  const source = section['data_source'];
  if (!isRecord(source) || source['kind'] !== 'product_pool' || !('tags' in source)) return section;
  const rest: Record<string, unknown> = { ...source };
  delete rest['tags'];
  return { ...section, data_source: rest };
}

/** The sections as delivered, in order (entries that are not objects pass through unchanged). */
export function deliveredSections(sections: readonly unknown[]): Record<string, unknown>[] {
  return sections.map((section) =>
    isRecord(section) ? deliveredSection(section as Record<string, unknown>) : section,
  ) as Record<string, unknown>[];
}
