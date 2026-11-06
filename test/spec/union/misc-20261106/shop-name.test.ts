import { expect, it } from 'vitest';
import { shopNameField } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { searchRow, searchRows } from '../taobao-official-search/official-harness.ts';

// Task-local AC labels ([AC-B1-04zzj#n]) identify this task's acceptance points, not business rules.
// D10-692 S2-7：shopNameField 先去掉 Unicode Cc / Cf 类字符，再 trim；超过 64 个字符（按码点计，不切开
// 代理对）截断为前 64 个码点（04 与契约未给上限，union 取技术值 64）；清洗后为空则不带 shop_name。
// 店名都是合成值。

const LIMIT = 64;

/** Code points of a string (a surrogate pair is one). */
function codePoints(value: string): number {
  return [...value].length;
}

it.each([
  ['C0 NUL 夹在中间', '合成\u0000青叶店', '合成青叶店'],
  ['C0 BEL / ESC', '\u0007合成\u001B青叶店', '合成青叶店'],
  ['制表与换行夹在中间', '合成\t青叶\n店', '合成青叶店'],
  ['DEL', '合成青叶店\u007F', '合成青叶店'],
  ['C1 NEL / APC', '\u0085合成青叶\u009F店', '合成青叶店'],
  ['零宽空格', '合成\u200B青叶店', '合成青叶店'],
  ['LRM / RLO', '\u200E合成\u202E青叶店', '合成青叶店'],
  ['BOM 夹在中间', '合成\uFEFF青叶店', '合成青叶店'],
  ['软连字符', '合成\u00AD青叶店', '合成青叶店'],
  ['方向隔离符', '\u2066合成青叶店\u2069', '合成青叶店'],
  ['补充平面 Cf（标签字符）', '合成青叶店\u{E0041}\u{E007F}', '合成青叶店'],
])('[AC-B1-04zzj#12] 去掉 Cc / Cf 字符：%s', (_label, raw, name) => {
  expect(shopNameField(raw)).toEqual({ shop_name: name });
});

it.each([
  ['首尾零宽空格包着空白', '\u200B  合成松果店 　\u200B', '合成松果店'],
  ['首尾 BOM 与 LRM 包着空白', '\u200E \uFEFF合成松果店\t\u200E', '合成松果店'],
  ['首尾控制字符包着空白，内部空格保留', '\u0001 合成  松果 店 \u0002', '合成  松果 店'],
])('[AC-B1-04zzj#13] 先去控制字符再 trim：%s', (_label, raw, name) => {
  expect(shopNameField(raw)).toEqual({ shop_name: name });
});

it.each([
  ['只有零宽空格', '\u200B\u200B'],
  ['只有 BOM 与方向符', '\uFEFF\u200E\u202E'],
  ['控制字符夹空白', '\u0000 \u0085　\u200B'],
  ['只有补充平面 Cf', '\u{E0001}\u{E0020}'],
])('[AC-B1-04zzj#14] 清洗后为空（%s）→ 不带 shop_name', (_label, raw) => {
  const field = shopNameField(raw);
  expect(field).toEqual({});
  expect(Object.hasOwn(field, 'shop_name')).toBe(false);
});

it('[AC-B1-04zzj#15] 超过 64 个字符截断为前 64 个', () => {
  const head = '合'.repeat(LIMIT);
  expect(shopNameField(`${head}超出部分`)).toEqual({ shop_name: head });
  const ascii = 'S'.repeat(LIMIT);
  expect(shopNameField(`${ascii}T`)).toEqual({ shop_name: ascii });
});

it('[AC-B1-04zzj#16] 按码点计：63 个字符后接代理对，截断保留整个代理对，不留半个', () => {
  const head = 'a'.repeat(LIMIT - 1);
  const field = shopNameField(`${head}😀😀尾`);
  expect(field).toEqual({ shop_name: `${head}😀` });
  expect(codePoints(field.shop_name ?? '')).toBe(LIMIT);
  expect((field.shop_name ?? '').length).toBe(LIMIT + 1);
});

it('[AC-B1-04zzj#17] 64 个代理对字符（128 个 UTF-16 单元）是 64 个码点，整串保留；第 65 个被截掉', () => {
  const emoji = '😀'.repeat(LIMIT);
  expect(shopNameField(`\u0000${emoji}`)).toEqual({ shop_name: emoji });
  expect(shopNameField(`${emoji}😃`)).toEqual({ shop_name: emoji });
});

it('[AC-B1-04zzj#18] 先清洗再计长度：去掉的控制字符不占 64 个名额', () => {
  const raw = 'b\u200B'.repeat(LIMIT) + 'c';
  expect(shopNameField(raw)).toEqual({ shop_name: 'b'.repeat(LIMIT) });
  const padded = `\u0000\u0000${'d'.repeat(LIMIT)}`;
  expect(shopNameField(padded)).toEqual({ shop_name: 'd'.repeat(LIMIT) });
});

it('[AC-B1-04zzj#19] 经适配器：淘宝官方搜索的 shop_title 同样去控制字符、trim、截断到 64 个码点', async () => {
  const long = '合成长名店'.repeat(20);
  const { page } = await searchRows([
    searchRow(1, { basic: { shop_title: '\u200B合成\u0000青叶店\uFEFF' } }),
    searchRow(2, { basic: { shop_title: long } }),
    searchRow(3, { basic: { shop_title: '\u200E\u200B' } }),
  ]);
  expect(page.items).toHaveLength(3);
  expect(page.items[0]!.shop_name).toBe('合成青叶店');
  expect(page.items[1]!.shop_name).toBe([...long].slice(0, LIMIT).join(''));
  expect(Object.hasOwn(page.items[2]!, 'shop_name')).toBe(false);
});
