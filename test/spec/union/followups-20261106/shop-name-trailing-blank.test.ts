import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { shopNameField } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { dtkRow, one } from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zzk#n]) identify this task's acceptance points, not business rules.
// D10-725 ①：shopNameField 在 B1-04zzj 口径（去 Cc / Cf → trim → 按码点截到前 64 个）之后，再去掉截断
// 留下的尾部空白（ASCII 空格、U+3000 等 Unicode 空白；第 64 个码点及其前面连续的空白一并去掉）。
// 店名都是合成值；不可见与特殊空白一律写成 \u 转义。

const LIMIT = 64;
const HAN = '合';

/** Code points of a string (a surrogate pair is one). */
function codePoints(value: string): number {
  return [...value].length;
}

/** Unicode whitespace kinds that survive the Cc / Cf cleaning (all trimmed by String#trim). */
const BLANKS: [string, string][] = [
  ['ASCII 空格', ' '],
  ['全角空格 U+3000', '　'],
  ['不换行空格 U+00A0', ' '],
  ['EM SPACE U+2003', ' '],
  ['窄不换行空格 U+202F', ' '],
  ['中等数学空格 U+205F', ' '],
  ['行分隔符 U+2028', '\u2028'],
];
const BLANK_CHARS = BLANKS.map(([, blank]) => blank);
const VISIBLE_CHARS = [HAN, '店', 'a', 'Z', '7', '\u{1F600}'];

it.each(BLANKS)(
  '[AC-B1-04zzk#8] 63 个「合」+ %s + 「店」：截到 64 个码点后去尾空白 → shop_name 为 63 个「合」',
  (_label, blank) => {
    const head = HAN.repeat(LIMIT - 1);
    const field = shopNameField(`${head}${blank}店`);
    expect(field).toEqual({ shop_name: head });
    expect(codePoints(field.shop_name ?? '')).toBe(LIMIT - 1);
  },
);

it('[AC-B1-04zzk#9] 第 64 个码点及其前面连续多个空白（混合种类）一并去掉', () => {
  const head = HAN.repeat(LIMIT - 4);
  const field = shopNameField(`${head} 　  店铺`);
  expect(field).toEqual({ shop_name: head });
  expect(codePoints(field.shop_name ?? '')).toBe(LIMIT - 4);
});

it('[AC-B1-04zzk#10] 先去 Cc / Cf 再计 64 个：零宽字符被去掉后落在第 64 位的全角空格同样去掉；代理对不被切开', () => {
  const head = HAN.repeat(LIMIT - 1);
  expect(shopNameField(`${head}\u200B　\u200B店`)).toEqual({ shop_name: head });
  const emojiHead = `${HAN.repeat(LIMIT - 2)}\u{1F600}`;
  const field = shopNameField(`${emojiHead} 尾`);
  expect(field).toEqual({ shop_name: emojiHead });
  expect(codePoints(field.shop_name ?? '')).toBe(LIMIT - 1);
});

it('[AC-B1-04zzk#11] 经适配器：大淘客搜索的 shopName 截断后同样去尾空白', async () => {
  const head = HAN.repeat(LIMIT - 1);
  const item = await one(dtkRow(51, { shopName: `${head}　店` }));
  expect(item.shop_name).toBe(head);
});

it('[AC-B1-04zzk#12] 属性：截断点落在空白串里时，shop_name = 前 64 个码点去尾空白，不以空白结尾、不超过 64 个码点', () => {
  const name = fc.integer({ min: 1, max: LIMIT - 1 }).chain((headLength) =>
    fc
      .tuple(
        fc.constantFrom(...VISIBLE_CHARS),
        fc.array(fc.constantFrom(...VISIBLE_CHARS, ...BLANK_CHARS), {
          minLength: headLength - 1,
          maxLength: headLength - 1,
        }),
        fc.array(fc.constantFrom(...BLANK_CHARS), {
          minLength: LIMIT - headLength,
          maxLength: LIMIT - headLength + 4,
        }),
        fc.array(fc.constantFrom(...VISIBLE_CHARS, ...BLANK_CHARS), { maxLength: 6 }),
        fc.constantFrom(...VISIBLE_CHARS),
      )
      .map(([first, rest, blanks, tail, last]) =>
        [first, ...rest, ...blanks, ...tail, last].join(''),
      ),
  );
  fc.assert(
    fc.property(name, (raw) => {
      const expected = [...raw].slice(0, LIMIT).join('').trimEnd();
      const field = shopNameField(raw);
      expect(field).toEqual({ shop_name: expected });
      expect(field.shop_name ?? '').not.toMatch(/\s$/u);
      expect(codePoints(field.shop_name ?? '')).toBeLessThanOrEqual(LIMIT);
      expect(raw.startsWith(field.shop_name ?? '\u0000')).toBe(true);
    }),
    propParams(),
  );
}, 900_000);
