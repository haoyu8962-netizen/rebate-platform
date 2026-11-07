import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { mapped, row } from '../jd-goods/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  CID1,
  CID1_NAME,
  categoryInfo,
  has,
  mappedCounting,
  sameOtherwise,
  withCategory,
} from './kit.ts';

// 京东一级类目的性质（D10-805 ⑤）：任意正整数的 cid1 都归一为同一十进制串；任意非空白名称原样出；
// 任意空白名称、任意非正整数 / 非数字的 cid1 都不出对应键，且不告警、不改其他字段。说明见 ./kit.ts。

/** A positive integer in decimal, as a JSON number or as a string. */
const positiveCid1 = fc
  .tuple(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), fc.boolean())
  .map(([value, asNumber]) => ({
    wire: asNumber ? num(String(value)) : String(value),
    text: String(value),
  }));

/** Only whitespace that String#trim removes; the empty string included. */
const blank = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\u3000', '\u00A0', '\u2003'), { maxLength: 6 })
  .map((parts) => parts.join(''));

/** A string with at least one non-whitespace character. */
const nonBlankName = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim() !== '');

/** A digit run with a non-digit character in it. */
const lettered = fc
  .tuple(
    fc.stringMatching(/^[0-9]{0,6}$/),
    fc.constantFrom('a', 'x', 'Z', '_', '#', '/', '中'),
    fc.stringMatching(/^[0-9]{0,6}$/),
  )
  .map(([head, mark, tail]) => `${head}${mark}${tail}`);

/** cid1 values that are not a positive integer. */
const badCid1 = fc.oneof(
  fc.integer({ min: -1_000_000_000, max: 0 }).map((value) => num(String(value))),
  fc.integer({ min: -1_000_000_000, max: 0 }).map((value) => String(value)),
  fc
    .tuple(fc.integer({ min: 0, max: 99_999_999 }), fc.integer({ min: 1, max: 99 }), fc.boolean())
    .map(([whole, cents, asNumber]) => {
      const text = `${whole}.${String(cents).padStart(2, '0')}`;
      return asNumber ? num(text) : text;
    }),
  lettered,
  blank,
  fc.constantFrom<unknown>(null, undefined, true, false, {}, [], [num(CID1)], { cid1: num(CID1) }),
);

it('[AC-B1-04zzv#13] 任意正整数 cid1（JSON 数字或字符串）→ category_l1_id 是同一十进制串', () => {
  expect(mapped(withCategory(categoryInfo())).category_l1_id).toBe(CID1);
  expect(() =>
    fc.assert(
      fc.property(positiveCid1, (cid1) => {
        const item = mapped(withCategory(categoryInfo({ cid1: cid1.wire })));
        return item.category_l1_id === cid1.text && item.category_l1_name === CID1_NAME;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[AC-B1-04zzv#14] 任意非空白 cid1Name → category_l1_name 原样', () => {
  expect(mapped(withCategory(categoryInfo())).category_l1_name).toBe(CID1_NAME);
  expect(() =>
    fc.assert(
      fc.property(nonBlankName, (cid1Name) => {
        const item = mapped(withCategory(categoryInfo({ cid1Name })));
        return item.category_l1_name === cid1Name && item.category_l1_id === CID1;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[AC-B1-04zzv#15] 任意空白 cid1Name → 不出 category_l1_name，category_l1_id 照出，不告警', () => {
  expect(mapped(withCategory(categoryInfo())).category_l1_name).toBe(CID1_NAME);
  expect(() =>
    fc.assert(
      fc.property(blank, (cid1Name) => {
        const { item, warned } = mappedCounting(withCategory(categoryInfo({ cid1Name })));
        return !has(item, 'category_l1_name') && item.category_l1_id === CID1 && warned === 0;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[AC-B1-04zzv#16] 任意非正整数 / 非数字的 cid1 → 不出 category_l1_id；照常映射，不告警，其余字段不变', () => {
  expect(mapped(withCategory(categoryInfo())).category_l1_id).toBe(CID1);
  const plain = mapped(row());
  expect(() =>
    fc.assert(
      fc.property(badCid1, (cid1) => {
        const { item, warned } = mappedCounting(withCategory(categoryInfo({ cid1 })));
        return (
          !has(item, 'category_l1_id') &&
          item.price_status === 'ok' &&
          warned === 0 &&
          sameOtherwise(item, plain)
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);
