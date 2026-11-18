// CT-07f (D10-1986; D10-1777 ②): `tags` of a product_pool data source on the home configuration's
// save (adminCreatePageConfigVersion) and publish, through the real admin entry, database, guard
// and Clock. Optional; a string array of 1–10 items, each under the CT-07e rules. Saved, the value is
// normalized as pool-item tags are (NFKC, trim, inner whitespace one space, blanks dropped,
// duplicates after normalization dropped, first kept in place, case not folded). A value that
// normalizes to [] is refused with 20001 and data.fields at that data source's tags: dropping every
// item would quietly turn "only the rows with these tags" into "no filter". Every refusal writes
// nothing (no page row, version or audit row).
//
// Before the change the save checks do not know `tags` and refuse every value. So each refusal case
// first saves the same section with a valid value on a page of its own and expects it to succeed,
// and every save goes through a function whose answer is handed to the assertions.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  rejected,
  send,
  setup,
  snapshot,
  success,
  version as readVersion,
  type Sent,
  type Setup,
  type Version,
} from '../../content/pages-admin/kit.ts';
import {
  BLANK_TAGS,
  CONFIG_POOL_ID,
  ELEVEN_TAGS,
  LONG_AFTER_NFKC,
  SEVENTEEN_CODE_POINTS,
  VALID_TAGS,
  WIDE_SPACE,
  gridSection,
  modelTags,
  poolSource,
  poolSourcesOf,
  scrollSection,
} from './kit.ts';

const h = useHarness();

/** One save of a whole page at expected_revision 0, as the console sends it. */
function saveOf(f: Setup, key: string, sections: readonly object[]): () => Promise<Sent> {
  return () => {
    f.clock.advanceMs(1000);
    return send(f, 'save', key, { sections, expected_revision: 0 });
  };
}

async function saved(run: () => Promise<Sent>): Promise<Version> {
  return success<Version>(await run());
}

/** The tags of the product_pool data source of section `index`, as an answer or a row holds them. */
function tagsAt(sections: unknown, index: number): unknown {
  expect(Array.isArray(sections), 'sections is an array').toBe(true);
  const section = (sections as unknown[])[index];
  expect(section, `section ${String(index)}`).toEqual(expect.any(Object));
  const source = (section as Record<string, unknown>)['data_source'] as Record<string, unknown>;
  return source['tags'];
}

async function storedSections(f: Setup, key: string): Promise<unknown> {
  const rows = await h.db
    .selectFrom('page_versions')
    .select(['sections'])
    .where('app_id', '=', f.appId)
    .where('page_key', '=', key)
    .execute();
  expect(rows).toHaveLength(1);
  return rows[0]?.sections;
}

/**
 * 20001 whose data.fields name the tags of section `index`'s data source: every path lies in that
 * data source, and at least one is its tags or inside them (`exact`: the tags path itself is there).
 */
async function refusedAtTags(sent: Sent, index: number, exact: boolean): Promise<void> {
  await rejected(sent, 20001);
  const { fields } = sent.response.json<{ data: { fields: string[] } }>().data;
  const at = `sections.${String(index)}.data_source.tags`;
  expect(fields.length, JSON.stringify(fields)).toBeGreaterThan(0);
  if (exact) expect(fields, JSON.stringify(fields)).toContain(at);
  expect(
    fields.some((path) => path === at || path.startsWith(`${at}.`)),
    JSON.stringify(fields),
  ).toBe(true);
  for (const path of fields) {
    expect(path.startsWith(`sections.${String(index)}.data_source`), path).toBe(true);
  }
}

it('[CT-07f][D10-1986] product_pool 数据源 tags：不带、1 项、10 项、一项 16 个码点都能保存并发布，存下的就是规范化后的值', async () => {
  const f = await setup(h);
  const values: { label: string; tags: readonly string[] | undefined }[] = [
    { label: '不带', tags: undefined },
    ...VALID_TAGS,
  ];
  for (const [index, { label, tags }] of values.entries()) {
    const key = `custom:valid_${String(index)}`;
    const sections = [gridSection('pool_grid', poolSource(CONFIG_POOL_ID, tags))];

    const version = await saved(saveOf(f, key, sections));

    expect(version.sections, label).toEqual(sections);
    expect(await storedSections(f, key), label).toEqual(sections);
    f.clock.advanceMs(1000);
    const published = await success(
      await send(f, 'publish', key, { version: 1, gray_percent: 100, expected_revision: 1 }),
    );
    expect(published, label).toMatchObject({ current_version: 1, revision: 2 });
  }
});

it('[CT-07f][D10-1777] 保存时 tags 按 CT-07e 同一套规范化：NFKC、去首尾空白、内部空白并一个、空白项丢掉、规范化后重复的只留第一个、大小写不折叠；返回、读回与存储都是规范化后的值', async () => {
  const f = await setup(h);
  const raw = [' 新品 ', 'ＡＢ', 'AB', 'ab', '新品', '618  大促', '   ', `秒杀${WIDE_SPACE}`];
  const expected = ['新品', 'AB', 'ab', '618 大促', '秒杀'];
  expect(modelTags(raw)).toEqual(expected);
  const scrollRaw = ['Ｘ', ' X ', 'x'];
  const scrollExpected = ['X', 'x'];
  expect(modelTags(scrollRaw)).toEqual(scrollExpected);
  const sections = [
    gridSection('pool_grid', poolSource(CONFIG_POOL_ID, raw, 6)),
    scrollSection('pool_scroll', poolSource(CONFIG_POOL_ID, scrollRaw, 3)),
  ];

  const version = await saved(saveOf(f, 'home', sections));

  const want = [
    gridSection('pool_grid', poolSource(CONFIG_POOL_ID, expected, 6)),
    scrollSection('pool_scroll', poolSource(CONFIG_POOL_ID, scrollExpected, 3)),
  ];
  expect(version.sections).toEqual(want);
  expect(await readVersion(f, 'home', 1)).toMatchObject({ sections: want });
  expect(await storedSections(f, 'home')).toEqual(want);
  expect(tagsAt(await storedSections(f, 'home'), 0)).toEqual(expected);
});

it('[CT-07f][D10-1777] 已规范化的 tags 原样再存一版：结果相同（规范化幂等）', async () => {
  const f = await setup(h);
  const sections = [gridSection('pool_grid', poolSource(CONFIG_POOL_ID, [' 甲 ', '乙', '甲']))];
  const first = await saved(saveOf(f, 'home', sections));
  expect(tagsAt(first.sections, 0)).toEqual(['甲', '乙']);

  f.clock.advanceMs(1000);
  const again = await success<Version>(
    await send(f, 'save', 'home', { sections: first.sections, expected_revision: 1 }),
  );

  expect(again).toMatchObject({ version: 2 });
  expect(again.sections).toEqual(first.sections);
});

const REFUSED: readonly { label: string; tags: unknown; exact: boolean }[] = [
  { label: '空数组 []', tags: [], exact: true },
  { label: '超 10 项（11 个不同的标签）', tags: ELEVEN_TAGS, exact: true },
  { label: '一项 17 个码点', tags: ['甲', SEVENTEEN_CODE_POINTS], exact: false },
  { label: '一项规范化后 20 个码点', tags: ['甲', LONG_AFTER_NFKC], exact: false },
  { label: '一项含控制字符', tags: ['甲', '乙\u0007'], exact: false },
  { label: '一项不是字符串', tags: ['甲', 7], exact: false },
  { label: '不是数组', tags: '新品', exact: true },
];

it.each(REFUSED)(
  '[CT-07f][D10-1986] tags $label → 20001，data.fields 指向该数据源的 tags，什么都不写',
  async ({ tags, exact }) => {
    const f = await setup(h);
    // The same section with one valid tag is saved: the refusal below is about the value only.
    const ok = await saved(
      saveOf(f, 'custom:ok', [gridSection('pool_grid', poolSource(CONFIG_POOL_ID, ['新品']))]),
    );
    expect(tagsAt(ok.sections, 0)).toEqual(['新品']);
    const before = await snapshot(h, f.appId);
    const source = { ...poolSource(CONFIG_POOL_ID), tags };

    const sent = await saveOf(f, 'home', [gridSection('pool_grid', source)])();

    await refusedAtTags(sent, 0, exact);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each([
  { label: '全是空白', tags: BLANK_TAGS },
  { label: '一项全角空格', tags: [WIDE_SPACE] },
])(
  '[CT-07f][D10-1777] tags 规范化后为空数组（$label）→ 20001，data.fields 恰为该数据源的 tags，不当成不筛，什么都不写',
  async ({ tags }) => {
    const f = await setup(h);
    expect(modelTags(tags)).toEqual([]);
    const sections = [
      gridSection('pool_grid', poolSource(CONFIG_POOL_ID, ['新品'])),
      scrollSection('pool_scroll', poolSource(CONFIG_POOL_ID, tags)),
    ];
    // The first section alone, valid tags included, is saved on a page of its own.
    const ok = await saved(saveOf(f, 'custom:ok', sections.slice(0, 1)));
    expect(poolSourcesOf(ok.sections).map((source) => source['tags'])).toEqual([['新品']]);
    const before = await snapshot(h, f.appId);

    const sent = await saveOf(f, 'home', sections)();

    await rejected(sent, 20001);
    expect(sent.response.json<{ data: unknown }>().data).toEqual({
      fields: ['sections.1.data_source.tags'],
    });
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);
