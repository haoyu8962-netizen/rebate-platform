// CT-07f (D10-1984 / D10-1986; 规划/01 F-ADM-10, 04 §3.2; 编排 D10-1758 / D10-1761 / D10-1764 /
// D10-1777): the home configuration's product_pool data source may carry `tags`, a string array of
// 1–10 items, each under the CT-07e tag rules. Saved, the tags are normalized as pool-item tags are
// and duplicates after normalization dropped; a value that normalizes to [] is refused (20001,
// data.fields at that data source's tags) and nothing is written. A section with tags reads only
// the rows whose tags meet them (any one, exact equality); absent tags do not filter. The feed's
// union fall-back (feed.fallback_pool_id) is never filtered. Pages sent to App / H5 (getPage and
// the preview) carry no tags anywhere in a product_pool data source, and the stored version and the
// caches keep them.
//
// Shared by the rule tests of this directory only: the shapes below are written out, never taken
// from the code under test.
import { expect } from 'vitest';
import { TEN_TAGS, WIDE_SPACE } from '../pool-tags/model.ts';

export { ELEVEN_TAGS, TEN_TAGS, WIDE_SPACE, modelTags, tagsOf } from '../pool-tags/model.ts';

/** A tag of exactly 16 code points (U+20000, one code point and two UTF-16 units each). */
export const SIXTEEN_CODE_POINTS = '𠀀'.repeat(16);
/** 17 code points as typed and after normalization. */
export const SEVENTEEN_CODE_POINTS = '中'.repeat(17);
/** 5 code points as typed, 20 after NFKC (㍿ → 株式会社). */
export const LONG_AFTER_NFKC = '㍿'.repeat(5);
/** Every item is blank once normalized: the value normalizes to []. */
export const BLANK_TAGS: readonly string[] = ['   ', WIDE_SPACE, ` ${WIDE_SPACE} `];

/** A product_pool data source; `tags` undefined leaves the key out. */
export function poolSource(
  poolId: string,
  tags?: readonly string[],
  limit = 20,
): Record<string, unknown> {
  return {
    kind: 'product_pool',
    pool_id: poolId,
    limit,
    ...(tags === undefined ? {} : { tags: [...tags] }),
  };
}

/** A product_grid section of the home schema around a data source. */
export function gridSection(id: string, dataSource: unknown): Record<string, unknown> {
  return { id, type: 'product_grid', version: 1, data_source: dataSource };
}

/** A product_scroll section of the home schema around a data source. */
export function scrollSection(id: string, dataSource: unknown): Record<string, unknown> {
  return { id, type: 'product_scroll', version: 1, data_source: dataSource };
}

/** A banner whose static item carries a key named `tags`: not a product_pool data source. */
export function bannerWithItemTags(id: string): Record<string, unknown> {
  return {
    id,
    type: 'banner',
    version: 1,
    data_source: { kind: 'static', items: [{ action: { route: 'Help' }, tags: ['横幅自带'] }] },
  };
}

/** A pool id in the shape adminCreateProductPool stores (UUIDv7, lowercase); fixed for config. */
export const CONFIG_POOL_ID = '0199f107-cccc-7000-8000-00000000f001';

/** The valid tag values of the save shape (D10-1986): one item, ten items, a 16-code-point item. */
export const VALID_TAGS: readonly { label: string; tags: readonly string[] }[] = [
  { label: '1 项', tags: ['新品'] },
  { label: '10 项', tags: TEN_TAGS },
  { label: '一项正好 16 个码点', tags: ['甲', SIXTEEN_CODE_POINTS] },
];

/** Every product_pool data source in a list of sections, wherever the section puts it. */
export function poolSourcesOf(sections: unknown): Record<string, unknown>[] {
  expect(Array.isArray(sections), 'sections is an array').toBe(true);
  const out: Record<string, unknown>[] = [];
  for (const section of sections as unknown[]) {
    if (typeof section !== 'object' || section === null) continue;
    const source = (section as Record<string, unknown>)['data_source'];
    if (typeof source !== 'object' || source === null) continue;
    if ((source as Record<string, unknown>)['kind'] === 'product_pool') {
      out.push(source as Record<string, unknown>);
    }
  }
  return out;
}

/** The sections with the `tags` key of every product_pool data source left out, nothing else. */
export function withoutPoolTags(sections: readonly Record<string, unknown>[]) {
  return sections.map((section) => {
    const source = section['data_source'];
    if (
      typeof source !== 'object' ||
      source === null ||
      (source as Record<string, unknown>)['kind'] !== 'product_pool'
    ) {
      return section;
    }
    const rest = Object.fromEntries(
      Object.entries(source as Record<string, unknown>).filter(([key]) => key !== 'tags'),
    );
    return { ...section, data_source: rest };
  });
}

/** A delivered page or preview: no product_pool data source carries `tags`, as a key at all. */
export function expectNoPoolTags(sections: unknown): void {
  const sources = poolSourcesOf(sections);
  expect(sources.length, 'product_pool data sources in the answer').toBeGreaterThan(0);
  for (const source of sources) {
    expect(Object.keys(source), JSON.stringify(source)).not.toContain('tags');
  }
}
