// CT-07g (FU-POOL-TAGS-NORMALIZE-SINGLE, D10-2034) (b): the home configuration's save
// (adminCreatePageConfigVersion, content's PageConfigAdmin) normalizes the tags of each product_pool
// data source with the normalization it is handed (app.module hands catalog's), not with a copy of
// its own: every save of such tags calls the injected function, and what is checked, saved and
// answered is the injected function's result. With catalog's normalization the saved tags follow
// the table of (a) row by row; a list that normalizes to [] is refused with data.fields exactly
// that data source's tags (PageFieldsError, which the controller answers as 20001) and nothing is
// written. Every save runs inside a function whose settled answer is handed to the assertions.
import { expect, it } from 'vitest';
import { normalizePoolTags } from '../../../../apps/api/src/modules/catalog/index.ts';
import { PageFieldsError } from '../../../../apps/api/src/modules/content/application/page-config-admin.ts';
import {
  TABLE,
  attempt,
  bench,
  gridSection,
  poolSource,
  recording,
  staticWithTags,
  tagsAt,
} from './kit.ts';

const KEPT = TABLE.filter((row) => row.expected.length > 0);
const EMPTIED = TABLE.filter((row) => row.expected.length === 0);

it.each(KEPT)(
  '[CT-07g][D10-2034] 首页配置保存走注入的规范化，结果与同表一致：$label',
  async ({ input, expected }) => {
    const spy = recording(normalizePoolTags);
    const b = bench(spy.normalize);
    const sections = [gridSection('pool_grid', poolSource(input))];

    const outcome = await attempt(() => b.save(sections));

    expect(spy.calls, 'the injected normalization is called with the tags as sent').toContainEqual([
      ...input,
    ]);
    expect(outcome.ok, outcome.ok ? '' : String(outcome.error)).toBe(true);
    if (!outcome.ok) return;
    expect(tagsAt(outcome.value.sections, 0)).toEqual(expected);
    expect(b.inserted).toHaveLength(1);
    expect(tagsAt(b.inserted[0], 0)).toEqual(expected);
    expect(b.checked.length).toBeGreaterThan(0);
    for (const sections of b.checked) expect(tagsAt(sections, 0)).toEqual(expected);
  },
);

it.each(EMPTIED)(
  '[CT-07g][D10-2034] 首页配置保存经注入的规范化后为空 → 拒（20001，data.fields 恰为 sections.N.data_source.tags），什么都不写：$label',
  async ({ input }) => {
    const spy = recording(normalizePoolTags);
    const b = bench(spy.normalize);
    const sections = [
      gridSection('pool_grid', poolSource(['新品'])),
      gridSection('pool_grid_2', poolSource(input)),
    ];

    const outcome = await attempt(() => b.save(sections));

    expect(spy.calls, 'the injected normalization is called with the tags as sent').toContainEqual([
      ...input,
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(PageFieldsError);
    expect((outcome.error as PageFieldsError).fields).toEqual(['sections.1.data_source.tags']);
    expect(b.inserted).toEqual([]);
  },
);

it('[CT-07g][D10-2034] 保存存下与返回的是注入函数的结果（不是 content 自己算的）；只有 product_pool 数据源的 tags 交给它', async () => {
  const marked = (input: readonly string[]): readonly string[] =>
    input.map((tag) => `已注入:${tag.trim()}`);
  const spy = recording(marked);
  const b = bench(spy.normalize);
  const poolTags = [' 新品 ', 'ＡＢ', 'ab'];
  const bannerTags = [' 横幅 '];
  const sections = [
    gridSection('pool_grid', poolSource(poolTags)),
    staticWithTags('banner', bannerTags),
    gridSection('pool_plain', poolSource()),
  ];

  const outcome = await attempt(() => b.save(sections));

  expect(spy.calls.length).toBeGreaterThan(0);
  for (const call of spy.calls) expect(call).toEqual(poolTags);
  expect(outcome.ok, outcome.ok ? '' : String(outcome.error)).toBe(true);
  if (!outcome.ok) return;
  const want = [
    gridSection('pool_grid', poolSource(marked(poolTags))),
    staticWithTags('banner', bannerTags),
    gridSection('pool_plain', poolSource()),
  ];
  expect(outcome.value.sections).toEqual(want);
  expect(b.inserted).toEqual([want]);
});
