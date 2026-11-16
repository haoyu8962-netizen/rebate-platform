// CT-07e (D10-1758 / D10-1761; 规划/04 §3.2): the product_pool data source of contracts/home-schema.json
// on the console side takes an optional `tags`, a string array of 1–10 items, each 1–16 code points
// without control characters. Checked through content's save / publish check of a page's sections
// (the compiled contract plus the F1-09c rules), the path the console's page writes take.
import { expect, it } from 'vitest';
import { createPageSectionsCheck } from '../../../../apps/api/src/modules/content/application/page-sections-check.ts';
import { homeSectionsSchema } from '../../../../apps/api/src/modules/content/infra/home-schema.ts';
import { ELEVEN_TAGS, TEN_TAGS } from './model.ts';

const check = createPageSectionsCheck(homeSectionsSchema());
const SOURCE = 'sections.0.data_source';

function poolSection(type: 'product_grid' | 'product_scroll', extra: Record<string, unknown>) {
  return {
    id: 'pool_tagged',
    type,
    version: 1,
    ...(type === 'product_grid' ? { props: { columns: 2 } } : { props: {} }),
    data_source: { kind: 'product_pool', pool_id: 'pool_demo_daily', limit: 20, ...extra },
  };
}

/** The fields a save of this one section is refused with; [] when it is accepted. */
function refusal(type: 'product_grid' | 'product_scroll', extra: Record<string, unknown>) {
  return check([poolSection(type, extra)], true);
}

function expectRefusedAtTags(fields: readonly string[]) {
  expect(fields.length, 'refused').toBeGreaterThan(0);
  for (const field of fields) expect(field.startsWith(SOURCE), field).toBe(true);
}

it.each(['product_grid', 'product_scroll'] as const)(
  '[CT-07e][D10-1758] %s 的 product_pool 数据源可选带 tags：不带、1 项、10 项、16 个码点都通过',
  (type) => {
    expect(refusal(type, {})).toEqual([]);
    expect(refusal(type, { tags: ['新品'] })).toEqual([]);
    expect(refusal(type, { tags: ['新品', '618 大促', 'AB'] })).toEqual([]);
    expect(refusal(type, { tags: [...TEN_TAGS] })).toEqual([]);
    expect(refusal(type, { tags: ['𠀀'.repeat(16)] })).toEqual([]);
  },
);

it.each([
  { label: '超 10 项', tags: [...ELEVEN_TAGS] },
  { label: '一项超 16 个码点', tags: ['新品', '中'.repeat(17)] },
  { label: '空串', tags: [''] },
  { label: '含控制字符', tags: ['新\u0007品'] },
  { label: '不是字符串', tags: [618] },
  { label: '不是数组', tags: '新品' },
])('[CT-07e][D10-1758] product_pool 的 tags $label → 保存被拒，指到 data_source', ({ tags }) => {
  expect(refusal('product_grid', { tags: ['新品'] })).toEqual([]);

  expectRefusedAtTags(refusal('product_grid', { tags }));
});
