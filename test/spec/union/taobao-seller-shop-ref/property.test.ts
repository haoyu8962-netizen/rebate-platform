import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { dtkRow, expectTrueIdentities, searchRows } from '../taobao-search/kit.ts';
import { expectedShopRef, expectNoInvalidItem } from './kit.ts';

// 任意一页大淘客搜索行（每行各自的 sellerId：合法数字串、安全正整数、各类不合格值、缺失混排）：每条都照常
// 返回、顺序不变；每条的 shop_ref 恰为本行 sellerId 合格时的十进制文本，否则没有这个键；不告警 invalid_item。

/** Positive decimal strings without leading zeros, also past the safe-integer range. */
const validText = fc.bigInt({ min: 1n, max: 10n ** 30n }).map((n) => String(n));
/** Safe positive integers as JSON numbers. */
const validNumber = fc.maxSafeNat().filter((n) => n > 0);
const whitespace = fc.constantFrom(' ', '\t', '\n', '　');

const invalid: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.bigInt({ min: 0n, max: 10n ** 20n }).map((n) => `0${n}`),
  fc.bigInt({ min: 1n, max: 10n ** 20n }).map((n) => `-${n}`),
  fc.tuple(validText, fc.nat({ max: 999 })).map(([whole, part]) => `${whole}.${part}`),
  fc
    .tuple(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 0, max: 30 }))
    .map(([mantissa, exponent]) => `${mantissa}e${exponent}`),
  fc
    .tuple(validText, whitespace, fc.boolean())
    .map(([text, space, before]) => (before ? `${space}${text}` : `${text}${space}`)),
  fc.integer({ min: -1_000_000, max: 0 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom<unknown>(null, true, false, {}, [], ['1']),
  fc.constant(undefined),
);

const sellerIdLists = fc.array(fc.oneof(validText, validNumber, invalid), {
  minLength: 1,
  maxLength: 6,
});

it('[AC-B1-04zzs#8] 任意 sellerId 混排：每条照常返回、顺序不变；shop_ref 恰为本行 sellerId 合格时的十进制文本，否则缺省；不告警 invalid_item', async () => {
  await expect(
    fc.assert(
      fc.asyncProperty(sellerIdLists, async (sellerIds) => {
        const rows = sellerIds.map((sellerId, index) => dtkRow(index + 1, { sellerId }));
        const { h, page } = await searchRows(rows);
        expect(expectTrueIdentities(page)).toEqual(rows.map((_row, index) => index + 1));
        page.items.forEach((item, index) => {
          const expected = expectedShopRef(sellerIds[index]);
          expect(Object.hasOwn(item, 'shop_ref'), `row ${index + 1} has shop_ref`).toBe(
            expected !== undefined,
          );
          expect(item.shop_ref).toBe(expected);
        });
        expectNoInvalidItem(h);
      }),
      propParams(),
    ),
  ).resolves.toBeUndefined();
}, 900_000);
