// B1-04zzn (S-19, D10-728 ②, BR-PROD-04): priceSpecHintFor stays the single decision. A new input
// says whether the card's price is the union product-detail answer; pinduoduo + that answer is
// price_from (pdd.ddk.goods.detail: min_group_price is the lowest SKU's price → 「¥x 起」). Nothing
// else moves: jd sku → null, everything else → spec_uncertain. Platform and flag compare strictly.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  priceSpecHintFor,
  type PriceSpecHintInput,
} from '../../../../apps/api/src/modules/catalog/domain/spec-hint.ts';

/** Runtime values outside the typed input, as a misread field would carry them. */
function loose(input: Readonly<Record<string, unknown>>): PriceSpecHintInput {
  return input as unknown as PriceSpecHintInput;
}

it('[AC-B1-04zzn#1][BR-PROD-04] 拼多多 + 价格取自联盟商品详情 → price_from', () => {
  expect(priceSpecHintFor({ platform: 'pdd', fromUnionDetail: true })).toBe('price_from');
});

it('[AC-B1-04zzn#2][BR-PROD-04] 拼多多不是联盟详情价（缺省 / false）仍 spec_uncertain；同一平台换成详情价才是 price_from', () => {
  expect(priceSpecHintFor({ platform: 'pdd' })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'pdd', fromUnionDetail: false })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'pdd', fromUnionDetail: true })).toBe('price_from');
});

it('[AC-B1-04zzn#3][BR-PROD-04] 只收窄拼多多：淘宝、京东 item / 无模式的详情价仍 spec_uncertain，京东 sku 详情价仍 null', () => {
  expect(priceSpecHintFor({ platform: 'taobao', fromUnionDetail: true })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'jd', jdMode: 'item', fromUnionDetail: true })).toBe(
    'spec_uncertain',
  );
  expect(priceSpecHintFor({ platform: 'jd', fromUnionDetail: true })).toBe('spec_uncertain');
  expect(priceSpecHintFor({ platform: 'jd', jdMode: 'sku', fromUnionDetail: true })).toBeNull();
  expect(priceSpecHintFor({ platform: 'pdd', fromUnionDetail: true })).toBe('price_from');
});

it('[AC-B1-04zzn#4][BR-PROD-04] 拼多多详情价与传入的京东模式无关（jdMode 只管京东）', () => {
  expect(priceSpecHintFor({ platform: 'pdd', jdMode: 'item', fromUnionDetail: true })).toBe(
    'price_from',
  );
  expect(priceSpecHintFor({ platform: 'pdd', jdMode: 'sku', fromUnionDetail: true })).toBe(
    'price_from',
  );
});

it.each(['PDD', 'Pdd', ' pdd', 'pdd ', 'pinduoduo', 'pdd:', 'meituan', 'tmall', ''])(
  '[AC-B1-04zzn#5][BR-PROD-04] 平台码严格比较：%j 带详情价也不出 price_from；只有 pdd 出',
  (platform) => {
    expect(priceSpecHintFor({ platform, fromUnionDetail: true })).toBe('spec_uncertain');
    expect(priceSpecHintFor({ platform: 'pdd', fromUnionDetail: true })).toBe('price_from');
  },
);

it.each([['true'], [1], ['yes'], [{}], [null], ['union_detail']])(
  '[AC-B1-04zzn#6][BR-PROD-04] 详情价标记不是恰好 true（%j）时不当详情价：拼多多 spec_uncertain；恰好 true 才 price_from',
  (flag) => {
    expect(priceSpecHintFor(loose({ platform: 'pdd', fromUnionDetail: flag }))).toBe(
      'spec_uncertain',
    );
    expect(priceSpecHintFor(loose({ platform: 'pdd', fromUnionDetail: true }))).toBe('price_from');
  },
);

it('[AC-B1-04zzn#7][BR-PROD-04] 标题、规格文本、价格与区间字段不参与：拼多多列表价带「起」也是 spec_uncertain，详情价不带也是 price_from', () => {
  const extras = {
    title: '合成牛奶 250ml*24 盒 ¥45 起',
    spec_text: '250ml*24',
    price_fen: 4500n,
    coupon_fen: 0n,
    final_price_fen: 4500n,
    price_min_fen: 4500n,
    price_max_fen: 8900n,
    min_group_price: 4500,
    is_lowest_spec_price: true,
    price_from: true,
  };
  expect(priceSpecHintFor(loose({ ...extras, platform: 'pdd' }))).toBe('spec_uncertain');
  expect(priceSpecHintFor(loose({ platform: 'pdd', fromUnionDetail: true }))).toBe('price_from');
  expect(
    priceSpecHintFor(
      loose({ platform: 'pdd', fromUnionDetail: true, title: '合成牛奶 250ml*24 盒' }),
    ),
  ).toBe('price_from');
});

it('[AC-B1-04zzn#8][BR-PROD-04] 交替调用各自判定，不留状态', () => {
  const sequence = [
    priceSpecHintFor({ platform: 'pdd', fromUnionDetail: true }),
    priceSpecHintFor({ platform: 'pdd' }),
    priceSpecHintFor({ platform: 'jd', jdMode: 'sku', fromUnionDetail: true }),
    priceSpecHintFor({ platform: 'pdd', fromUnionDetail: true }),
    priceSpecHintFor({ platform: 'taobao', fromUnionDetail: true }),
    priceSpecHintFor({ platform: 'pdd', fromUnionDetail: false }),
  ];
  expect(sequence).toEqual([
    'price_from',
    'spec_uncertain',
    null,
    'price_from',
    'spec_uncertain',
    'spec_uncertain',
  ]);
});

it('[AC-B1-04zzn#9][BR-PROD-04] 属性：结果恰为「jd 且 sku → null；pdd 且详情价恰为 true → price_from；否则 spec_uncertain」', () => {
  const platformArb = fc.oneof(
    { arbitrary: fc.constant('pdd'), weight: 4 },
    {
      arbitrary: fc.constantFrom('jd', 'taobao', 'PDD', ' pdd', 'pdd ', 'Pdd', 'meituan'),
      weight: 3,
    },
    { arbitrary: fc.string({ maxLength: 6 }), weight: 1 },
  );
  const modeArb = fc.constantFrom<unknown>('sku', 'item', undefined, 'SKU', null);
  const flagArb = fc.constantFrom<unknown>(true, true, false, undefined, 'true', 1, null);
  let pddDetailHits = 0;
  fc.assert(
    fc.property(platformArb, modeArb, flagArb, (platform, mode, flag) => {
      const input = loose({
        platform,
        ...(mode === undefined ? {} : { jdMode: mode }),
        ...(flag === undefined ? {} : { fromUnionDetail: flag }),
      });
      const expected =
        platform === 'jd' && mode === 'sku'
          ? null
          : platform === 'pdd' && flag === true
            ? 'price_from'
            : 'spec_uncertain';
      if (expected === 'price_from') pddDetailHits += 1;
      expect(priceSpecHintFor(input)).toBe(expected);
    }),
    { ...propParams(), examples: [['pdd', undefined, true]] },
  );
  expect(pddDetailHits).toBeGreaterThan(0);
}, 900_000);
