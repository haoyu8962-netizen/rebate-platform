import { expect, it } from 'vitest';
import {
  emptiedPoolSourceTagFields,
  normalizePoolSourceTags,
  normalizeSourceTags,
} from './pool-source-tags.ts';

// D10-2034: the input/output table of catalog's normalization, copied row by row from the CT-07e
// rule test test/spec/catalog/pool-tags/normalize.test.ts (same inputs, same expectations), so this
// copy and catalog/domain/pool-tags.ts are held to one table. The constants below are copied from
// test/spec/catalog/pool-tags/model.ts as defined there.
const WIDE_SPACE = String.fromCodePoint(0x3000);
const NBSP = String.fromCodePoint(0xa0);
const CONTROL_CHARS: readonly string[] = ['\u0000', '\u0007', '\u001b', '\u007f', '\u009f'];
const TEN_TAGS: readonly string[] = Array.from(
  { length: 10 },
  (_unused, index) => `标签${String(index)}`,
);
const ELEVEN_TAGS: readonly string[] = [...TEN_TAGS, '标签10'];
const ASTRAL = '𠀀';

// Rows of normalize.test.ts whose expectation is a list (normalizePoolTags) or a value
// (normalizePoolTagFilter, here sent as a one-item list and expected as a one-item list).
const SAME_AS_CATALOG: readonly {
  label: string;
  input: readonly string[];
  expected: readonly string[];
}[] = [
  { label: '空数组', input: [], expected: [] },
  {
    label: 'NFKC、去首尾空白、内部空白并一、丢空串、去重保序、大小写不折叠',
    input: ['  新品  ', 'ＡＢ', 'AB', 'ab', WIDE_SPACE, `618${WIDE_SPACE} ${NBSP}大促`, '新品'],
    expected: ['新品', 'AB', 'ab', '618 大促'],
  },
  { label: '去重保留第一次出现', input: ['乙', '甲', '乙', ' 甲 '], expected: ['乙', '甲'] },
  { label: 'NFKC 后相同的去重', input: ['①', '1'], expected: ['1'] },
  { label: '全是空白', input: ['   ', WIDE_SPACE, NBSP], expected: [] },
  { label: '16 个增补平面码点', input: [ASTRAL.repeat(16)], expected: [ASTRAL.repeat(16)] },
  { label: '16 个汉字', input: ['中'.repeat(16)], expected: ['中'.repeat(16)] },
  {
    label: '去首尾空白后 16 个码点',
    input: [`  ${'中'.repeat(16)}  `],
    expected: ['中'.repeat(16)],
  },
  { label: 'NFKC 展开后 16 个码点', input: ['㍿'.repeat(4)], expected: ['株式会社'.repeat(4)] },
  { label: '10 项', input: TEN_TAGS, expected: TEN_TAGS },
  {
    label: '重复与空串去掉后 10 项',
    input: [...TEN_TAGS, ' 标签0 ', '  ', '标签9'],
    expected: TEN_TAGS,
  },
  // The control-character rows check ['甲'] → ['甲'] once per character; one row covers them.
  { label: '控制字符各行的对照 [甲]', input: ['甲'], expected: ['甲'] },
  { label: '筛选：新品', input: ['新品'], expected: ['新品'] },
  { label: '筛选：  ＡＢ ', input: ['  ＡＢ '], expected: ['AB'] },
  { label: '筛选：ab', input: ['ab'], expected: ['ab'] },
  {
    label: '筛选：内部两个全角空格',
    input: [`618${WIDE_SPACE}${WIDE_SPACE}大促`],
    expected: ['618 大促'],
  },
  { label: '筛选：16 个增补平面码点', input: [ASTRAL.repeat(16)], expected: [ASTRAL.repeat(16)] },
  { label: '筛选各拒绝行的对照： 新品 ', input: [' 新品 '], expected: ['新品'] },
];

it.each(SAME_AS_CATALOG)(
  '[CT-07f][D10-2034] 与 catalog 规范化同表：$label',
  ({ input, expected }) => {
    expect(normalizeSourceTags(input)).toEqual(expected);
  },
);

// Rows where catalog refuses a single filter value that is blank after normalization. This copy
// does not refuse a value: the item is dropped and a list that normalizes to [] is refused on its
// own by emptiedPoolSourceTagFields (20001, sections.N.data_source.tags).
it.each([
  { label: '空串', value: '' },
  { label: '只有空格', value: '   ' },
  { label: '只有全角空格', value: WIDE_SPACE.repeat(2) },
])('[CT-07f][D10-2034] 筛选拒绝行（$label）：规范化为 []，由空列表单独拒', ({ value }) => {
  expect(normalizeSourceTags([value])).toEqual([]);
  expect(emptiedPoolSourceTagFields([pool([value])])).toEqual(['sections.0.data_source.tags']);
});

// Rows not copied (catalog returns null; here the bound is the home-schema check on the normalized
// sections, contracts/home-schema.json product_pool data_source tags: maxItems 10, items maxLength
// 16, pattern without control characters — not this function's job):
// - [𠀀×17], ['甲', 中×17], [㍿×5]: more than 16 code points → home-schema items.maxLength.
// - ELEVEN_TAGS, [...TEN_TAGS, ' 标签0 ', 'Ｘ']: more than 10 items → home-schema maxItems.
// - ['甲', `乙${char}丙`], [char] for each of CONTROL_CHARS: control character → home-schema pattern.
// - filter '𠀀'×17, '㍿'×5, '新\u0007品', '新品\u007f': same bounds → home-schema.
// - the two fast-check properties: they compare against the bounded model (modelTags/modelTag).
// What this copy does on them: normalizes and keeps everything (nothing truncated or deleted), so the
// schema sees and refuses the value.
it('[CT-07f][D10-2034] 上限与控制字符不在本函数：规范化后原样留给 home-schema 拒', () => {
  expect(normalizeSourceTags([ASTRAL.repeat(17)])).toEqual([ASTRAL.repeat(17)]);
  expect(normalizeSourceTags(['㍿'.repeat(5)])).toEqual(['株式会社'.repeat(5)]);
  expect(normalizeSourceTags(ELEVEN_TAGS)).toEqual(ELEVEN_TAGS);
  for (const char of CONTROL_CHARS) {
    expect(normalizeSourceTags(['甲', `乙${char}丙`])).toEqual(['甲', `乙${char}丙`]);
  }
});

function pool(tags?: unknown) {
  return {
    id: 's',
    type: 'product_grid',
    data_source: {
      kind: 'product_pool',
      pool_id: 'p',
      limit: 5,
      ...(tags === undefined ? {} : { tags }),
    },
  };
}

it('[CT-07f][D10-1777] 只改 product_pool 的字符串 tags，其余区块与输入原样', () => {
  const material = { data_source: { kind: 'static', tags: [' a '] } };
  const input = [pool([' a ', 'a']), pool(), material, pool([1]), 'x'];
  const frozen = structuredClone(input);
  expect(normalizePoolSourceTags(input)).toEqual([pool(['a']), pool(), material, pool([1]), 'x']);
  expect(input).toEqual(frozen);
  expect(normalizePoolSourceTags({ not: 'array' })).toEqual({ not: 'array' });
});

it('[CT-07f][D10-1986] 规范化后为空（[] 或全是空白）才报该数据源的 tags；缺省、非字符串数组不报', () => {
  expect(
    emptiedPoolSourceTagFields([pool(['a']), pool([' ', '　']), pool([]), pool(), pool([1])]),
  ).toEqual(['sections.1.data_source.tags', 'sections.2.data_source.tags']);
  expect(emptiedPoolSourceTagFields(null)).toEqual([]);
});
