// B1-05zh (S-19, D10-713, BR-PROD-04): the single decision priceSpecHintFor. null only where the price
// is known to belong to exactly this product / SKU (jd, product_key.jd.mode = sku); every other card
// says 规格以下单页为准 (spec_uncertain). price_from is not produced in this phase (range and lowest-
// spec price fields are not registered in 规划/09). Nothing but platform and jdMode is consulted.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  priceSpecHintFor,
  type PriceSpecHintInput,
} from '../../../../apps/api/src/modules/catalog/domain/spec-hint.ts';

/** Runtime values outside the typed modes: read loosely, as a misconfigured config row would be. */
function loose(platform: string, jdMode: unknown): PriceSpecHintInput {
  return { platform, jdMode } as unknown as PriceSpecHintInput;
}

it('[AC-B1-05zh#1][BR-PROD-04] 京东 sku 模式（product_key 即 skuId，价格即该 SKU 的价）→ null', () => {
  expect(priceSpecHintFor({ platform: 'jd', jdMode: 'sku' })).toBeNull();
});

it.each([
  { name: 'item 模式', input: { platform: 'jd', jdMode: 'item' } as PriceSpecHintInput },
  { name: '未配置模式（缺省即 item）', input: { platform: 'jd' } as PriceSpecHintInput },
])('[AC-B1-05zh#2][BR-PROD-04] 京东 $name → spec_uncertain（不是 null）', ({ input }) => {
  expect(priceSpecHintFor(input)).toBe('spec_uncertain');
});

it.each(['taobao', 'pdd'])(
  '[AC-B1-05zh#3][BR-PROD-04] %s 商品级价无法对应规格 → spec_uncertain，与传入的京东模式无关',
  (platform) => {
    expect(priceSpecHintFor({ platform })).toBe('spec_uncertain');
    expect(priceSpecHintFor({ platform, jdMode: 'item' })).toBe('spec_uncertain');
    // jdMode is the JD key mode only; it never turns another platform's hint into null.
    expect(priceSpecHintFor({ platform, jdMode: 'sku' })).toBe('spec_uncertain');
  },
);

it.each(['meituan', 'vip', 'douyin', 'eleme', 'kuaishou', 'suning', 'tmall'])(
  '[AC-B1-05zh#4][BR-PROD-04] 其余平台码 %s 一律 spec_uncertain（null 只给确知对应规格的价）',
  (platform) => {
    expect(priceSpecHintFor({ platform })).toBe('spec_uncertain');
    expect(priceSpecHintFor({ platform, jdMode: 'sku' })).toBe('spec_uncertain');
  },
);

it.each([['SKU'], ['Sku'], [' sku'], ['sku '], ['spu'], [''], [null], [1], [true]])(
  '[AC-B1-05zh#5][BR-PROD-04] 京东模式取值非法（%j）时不当 sku：spec_uncertain，不给 null',
  (mode) => {
    expect(priceSpecHintFor(loose('jd', mode))).toBe('spec_uncertain');
  },
);

it('[AC-B1-05zh#6][BR-PROD-04] 只看平台与京东模式：标题、规格文本、价格与区间字段都不改变判定', () => {
  const extras = {
    title: '伊利纯牛奶 250ml*24 盒 最低规格价',
    spec_text: '250ml*24',
    spec: '24 盒',
    price_fen: 4500n,
    coupon_fen: 0n,
    final_price_fen: 4500n,
    price_min_fen: 4500n,
    price_max_fen: 8900n,
    min_group_price: 4500,
    is_lowest_spec_price: true,
    price_from: true,
  };
  const withExtras = (input: PriceSpecHintInput) =>
    priceSpecHintFor({ ...extras, ...input } as unknown as PriceSpecHintInput);
  expect(withExtras({ platform: 'taobao' })).toBe('spec_uncertain');
  expect(withExtras({ platform: 'pdd' })).toBe('spec_uncertain');
  expect(withExtras({ platform: 'jd', jdMode: 'item' })).toBe('spec_uncertain');
  expect(withExtras({ platform: 'jd', jdMode: 'sku' })).toBeNull();
});

it('[AC-B1-05zh#7][BR-PROD-04] 同一输入多次调用结果相同，不留状态', () => {
  const sequence = [
    priceSpecHintFor({ platform: 'jd', jdMode: 'sku' }),
    priceSpecHintFor({ platform: 'taobao' }),
    priceSpecHintFor({ platform: 'jd', jdMode: 'sku' }),
    priceSpecHintFor({ platform: 'jd' }),
    priceSpecHintFor({ platform: 'jd', jdMode: 'sku' }),
  ];
  expect(sequence).toEqual([null, 'spec_uncertain', null, 'spec_uncertain', null]);
});

it('[AC-B1-05zh#8][BR-PROD-04] 属性：任意平台码与模式取值，结果恰为「jd 且 sku → null，否则 spec_uncertain」，从不出 price_from', () => {
  const platformArb = fc.oneof(
    fc.constantFrom('jd', 'taobao', 'pdd', 'meituan', 'vip', 'douyin', 'tmall', 'JD', 'jd '),
    fc.string({ maxLength: 8 }),
  );
  const modeArb = fc.oneof(
    fc.constantFrom<unknown>('sku', 'item', undefined, 'SKU', '', null),
    fc.string({ maxLength: 6 }),
  );
  let checked = 0;
  fc.assert(
    fc.property(platformArb, modeArb, fc.boolean(), (platform, mode, withKey) => {
      const input = withKey ? loose(platform, mode) : ({ platform } as PriceSpecHintInput);
      const expected = platform === 'jd' && withKey && mode === 'sku' ? null : 'spec_uncertain';
      const hint = priceSpecHintFor(input);
      expect(hint).toBe(expected);
      expect(hint).not.toBe('price_from');
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
