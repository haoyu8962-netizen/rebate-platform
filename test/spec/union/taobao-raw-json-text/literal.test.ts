// B1-04zzzzj（FU-TB-ARCHIVE-LITERAL-JSON）：orders.ts 的 rawJsonText 与 punishments.ts / refunds.ts 的两份
// literalJson 合一为 taobaoRawJsonText（raw-json.ts）。纯重构：输出与原三份逐字相同——TaobaoRawNumber 写原文、
// 不经 Number；其余值按 JSON.stringify；数组与对象无空格、成员按插入顺序；兜底分支（D10-2169）不变。
// 期望一律是字面量文本，严格 toBe。
import { expect, it } from 'vitest';
import { TaobaoRawNumber } from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { taobaoRawJsonText } from '../../../../apps/api/src/modules/union/infra/taobao/raw-json.ts';

function num(text: string): TaobaoRawNumber {
  return new TaobaoRawNumber(text);
}

// taobaoRawJsonText：数字原文
it.each([
  ['12345678901234567890'],
  ['1.10'],
  ['-0'],
  ['1e3'],
  ['0.000001'],
  ['2.50E+10'],
  ['-12345678901234567890.000'],
])('[AC-B1-04zzzzj#1] TaobaoRawNumber %s 原样写出，不经 Number', (text) => {
  expect(taobaoRawJsonText(num(text))).toBe(text);
});

it('[AC-B1-04zzzzj#2] 数组与对象里的 TaobaoRawNumber 也原样写出', () => {
  const list = [num('12345678901234567890'), num('1.10'), num('-0'), num('1e3')];
  expect(taobaoRawJsonText(list)).toBe('[12345678901234567890,1.10,-0,1e3]');
  const record = { big: num('12345678901234567890'), rate: num('0.000001') };
  expect(taobaoRawJsonText(record)).toBe('{"big":12345678901234567890,"rate":0.000001}');
});

// taobaoRawJsonText：字符串与常量
it.each([
  ['plain', '"plain"'],
  ['say "hi"', String.raw`"say \"hi\""`],
  ['a\\b', String.raw`"a\\b"`],
  ['line1\nline2', String.raw`"line1\nline2"`],
  ['tab\there', String.raw`"tab\there"`],
  ['ctrl\u0001', String.raw`"ctrl\u0001"`],
  ['凑狸订单', '"凑狸订单"'],
  ['sep\u2028end', '"sep\u2028end"'],
  ['lone\ud800', String.raw`"lone\ud800"`],
  ['', '""'],
])('[AC-B1-04zzzzj#3] 字符串 %j 按 JSON.stringify 转义为 %s', (value, expected) => {
  expect(taobaoRawJsonText(value)).toBe(expected);
});

it('[AC-B1-04zzzzj#4] null、true、false 写成 JSON 常量', () => {
  expect(taobaoRawJsonText(null)).toBe('null');
  expect(taobaoRawJsonText(true)).toBe('true');
  expect(taobaoRawJsonText(false)).toBe('false');
});

// taobaoRawJsonText：数组与对象
it('[AC-B1-04zzzzj#5] 数组（空、嵌套、混合）无空格输出、按原序', () => {
  expect(taobaoRawJsonText([])).toBe('[]');
  expect(taobaoRawJsonText([[], [[]], [[], []]])).toBe('[[],[[]],[[],[]]]');
  const mixed = [num('1.10'), 'a "q"', null, true, false, {}, [], { k: [num('0')] }];
  const expected = String.raw`[1.10,"a \"q\"",null,true,false,{},[],{"k":[0]}]`;
  expect(taobaoRawJsonText(mixed)).toBe(expected);
});

it('[AC-B1-04zzzzj#6] 对象（空、嵌套）无空格输出、成员按插入顺序', () => {
  expect(taobaoRawJsonText({})).toBe('{}');
  const nested = { a: { b: { c: num('0.000001') }, e: {} }, d: [], f: 'x' };
  expect(taobaoRawJsonText(nested)).toBe('{"a":{"b":{"c":0.000001},"e":{}},"d":[],"f":"x"}');
  const unsorted = { zeta: num('3'), alpha: num('1'), mid: num('2.0') };
  expect(taobaoRawJsonText(unsorted)).toBe('{"zeta":3,"alpha":1,"mid":2.0}');
});

it('[AC-B1-04zzzzj#7] 键名按 JSON.stringify 转义（引号、反斜杠、换行、中文键、空键）', () => {
  const escaped = { 'say "k"': 'v', 'a\\b': null, 'line\n': true };
  const expected = String.raw`{"say \"k\"":"v","a\\b":null,"line\n":true}`;
  expect(taobaoRawJsonText(escaped)).toBe(expected);
  const plain = { 键名: num('1.10'), '': false };
  expect(taobaoRawJsonText(plain)).toBe('{"键名":1.10,"":false}');
});

// taobaoRawJsonText：兜底分支（D10-2169，合一后不变）
it('[AC-B1-04zzzzj#8] 不是 TaobaoRawNumber 的普通 number 走 JSON.stringify', () => {
  expect(taobaoRawJsonText(1.5)).toBe('1.5');
  expect(taobaoRawJsonText(0)).toBe('0');
  expect(taobaoRawJsonText([1.5, 0])).toBe('[1.5,0]');
  expect(taobaoRawJsonText({ n: 1.5 })).toBe('{"n":1.5}');
});

it('[AC-B1-04zzzzj#9] 对象成员值为 null 写 null', () => {
  expect(taobaoRawJsonText({ a: null })).toBe('{"a":null}');
  expect(taobaoRawJsonText({ a: null, b: { c: null } })).toBe('{"a":null,"b":{"c":null}}');
});
