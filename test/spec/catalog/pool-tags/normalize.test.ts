// CT-07e (D10-1758 / D10-1765): the one normalization of pool tags and of the list filter `tag`.
// Pure functions: NFKC → trim → inner whitespace runs become one space → empty dropped → duplicates
// after normalization dropped (first occurrence kept, case not folded); more than 16 code points,
// more than 10 tags or a control character after normalization refuses the whole value (null),
// nothing is truncated. The inputs keep to characters whose NFKC form and whitespace class are the
// same under every reading of "whitespace" (no tab, newline, U+0085 or U+FEFF).
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  normalizePoolTagFilter,
  normalizePoolTags,
} from '../../../../apps/api/src/modules/catalog/domain/pool-tags.ts';
import {
  CONTROL_CHARS,
  ELEVEN_TAGS,
  NBSP,
  TEN_TAGS,
  WIDE_SPACE,
  codePoints,
  hasControl,
  modelTag,
  modelTags,
} from './model.ts';

it('[CT-07e][D10-1758] 规范化：NFKC、去首尾空白、内部空白并一、空串丢弃、去重保留第一次出现的顺序、大小写不折叠', () => {
  expect(normalizePoolTags([])).toEqual([]);
  const mixed = `618${WIDE_SPACE} ${NBSP}大促`;
  const input = ['  新品  ', 'ＡＢ', 'AB', 'ab', WIDE_SPACE, mixed, '新品'];
  expect(normalizePoolTags(input)).toEqual(['新品', 'AB', 'ab', '618 大促']);
  expect(normalizePoolTags(['乙', '甲', '乙', ' 甲 '])).toEqual(['乙', '甲']);
  expect(normalizePoolTags(['①', '1'])).toEqual(['1']);
  expect(normalizePoolTags(['   ', WIDE_SPACE, NBSP])).toEqual([]);
});

it('[CT-07e][D10-1758] 长度按规范化后的 Unicode 码点算：16 个码点通过，17 个拒绝，不截断', () => {
  const astral = '𠀀';
  expect(normalizePoolTags([astral.repeat(16)])).toEqual([astral.repeat(16)]);
  expect(normalizePoolTags(['中'.repeat(16)])).toEqual(['中'.repeat(16)]);
  expect(normalizePoolTags([`  ${'中'.repeat(16)}  `])).toEqual(['中'.repeat(16)]);
  expect(normalizePoolTags([astral.repeat(17)])).toBeNull();
  expect(normalizePoolTags(['甲', '中'.repeat(17)])).toBeNull();
  // NFKC expands U+337F to four characters: 4 × 4 = 16 passes, 5 × 4 = 20 is refused.
  expect(normalizePoolTags(['㍿'.repeat(4)])).toEqual(['株式会社'.repeat(4)]);
  expect(normalizePoolTags(['㍿'.repeat(5)])).toBeNull();
});

it('[CT-07e][D10-1758] 项数按规范化后算：10 项通过，11 项拒绝；重复与空串去掉后不超 10 项也通过', () => {
  expect(normalizePoolTags(TEN_TAGS)).toEqual(TEN_TAGS);
  expect(normalizePoolTags(ELEVEN_TAGS)).toBeNull();
  expect(normalizePoolTags([...TEN_TAGS, ' 标签0 ', 'Ｘ'])).toBeNull();
  expect(normalizePoolTags([...TEN_TAGS, ' 标签0 ', '  ', '标签9'])).toEqual(TEN_TAGS);
});

it.each(CONTROL_CHARS.map((char) => ({ code: char.codePointAt(0)!.toString(16), char })))(
  '[CT-07e][D10-1758] 含控制字符 U+$code 的标签拒绝整组，不删字符',
  ({ char }) => {
    expect(normalizePoolTags(['甲'])).toEqual(['甲']);
    expect(normalizePoolTags(['甲', `乙${char}丙`])).toBeNull();
    expect(normalizePoolTags([char])).toBeNull();
  },
);

it('[CT-07e][D10-1765] 列表筛选 tag 同一套规范化：NFKC、去首尾空白、内部空白并一，大小写不折叠', () => {
  expect(normalizePoolTagFilter('新品')).toBe('新品');
  expect(normalizePoolTagFilter('  ＡＢ ')).toBe('AB');
  expect(normalizePoolTagFilter('ab')).toBe('ab');
  expect(normalizePoolTagFilter(`618${WIDE_SPACE}${WIDE_SPACE}大促`)).toBe('618 大促');
  expect(normalizePoolTagFilter('𠀀'.repeat(16))).toBe('𠀀'.repeat(16));
});

it.each([
  { label: '空串', value: '' },
  { label: '只有空格', value: '   ' },
  { label: '只有全角空格', value: WIDE_SPACE.repeat(2) },
  { label: '超 16 个码点', value: '𠀀'.repeat(17) },
  { label: '规范化后超 16 个码点', value: '㍿'.repeat(5) },
  { label: '含控制字符', value: '新\u0007品' },
  { label: '含 DEL', value: '新品\u007f' },
])('[CT-07e][D10-1765] 列表筛选 tag $label → 拒绝（不当成不筛，也不当成无结果）', ({ value }) => {
  expect(normalizePoolTagFilter(' 新品 ')).toBe('新品');
  expect(normalizePoolTagFilter(value)).toBeNull();
});

/** Characters with an unambiguous NFKC form; WIDE_SPACE and NBSP become a plain space. */
const UNIT = fc.constantFrom(
  'a',
  'A',
  'b',
  '新',
  '品',
  ' ',
  ' ',
  WIDE_SPACE,
  NBSP,
  'Ａ',
  '①',
  '1',
  '𠀀',
  '㍿',
  '\u0007',
  '\u007f',
);
const RAW_TAG = fc.string({ unit: UNIT, maxLength: 20 });

it('[CT-07e][D10-1758] 任意输入：结果与规则逐步算出的一致；通过的结果每项都已规范化、互不相同、不超 16 个码点、不超 10 项、无控制字符，再规范化一次不变', () => {
  fc.assert(
    fc.property(fc.array(RAW_TAG, { maxLength: 14 }), (input) => {
      const result = normalizePoolTags(input);
      expect(result).toEqual(modelTags(input));
      if (result === null) return;
      expect(result.length).toBeLessThanOrEqual(10);
      expect(new Set(result).size).toBe(result.length);
      for (const tag of result) {
        expect(tag).toBe(tag.normalize('NFKC').trim().replace(/ {2,}/g, ' '));
        expect(tag).not.toBe('');
        expect(codePoints(tag)).toBeLessThanOrEqual(16);
        expect(hasControl(tag)).toBe(false);
      }
      expect(normalizePoolTags(result)).toEqual(result);
    }),
    { numRuns: propRuns(), seed: propSeed() },
  );
});

it('[CT-07e][D10-1765] 任意输入：列表筛选 tag 与写入单项的规范化一致，空串也拒绝', () => {
  fc.assert(
    fc.property(RAW_TAG, (input) => {
      expect(normalizePoolTagFilter(input)).toBe(modelTag(input));
    }),
    { numRuns: propRuns(), seed: propSeed() },
  );
});
