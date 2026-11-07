// B1-05zm (S17-c1): the shop_entry judgment itself (catalog/domain/detail-extras.ts). 08
// BR-PRICE-21 细则「进店」: true only when the platform switch is on, the configured source can
// make the shop link for that platform, and the product carries a shop id; D10-736 ②: decided
// from these facts alone, never by asking the source. S17-c1 adds the shop name (④): the shop link
// conversion needs both shop_ref and shop_name (union ShopConvertReq).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  shopEntryKeys,
  shopEntryOf,
  type ShopEntryFacts,
} from '../../../../apps/api/src/modules/catalog/domain/detail-extras.ts';
import { DATAOKE, SHOP_NAME, SHOP_REF } from './kit.ts';

const ALL_MET: ShopEntryFacts = {
  enabled: true,
  source: DATAOKE,
  adapterSources: [DATAOKE],
  item: { shop_ref: SHOP_REF, shop_name: SHOP_NAME },
};

it.each([{ platform: 'taobao' }, { platform: 'jd' }, { platform: 'pdd' }])(
  '[AC-B1-05zm#1] 进店的两个配置键按平台代码拼：shop.entry.enabled.$platform 与 shop.entry.source.$platform',
  ({ platform }) => {
    expect(shopEntryKeys(platform)).toEqual({
      enabled: `shop.entry.enabled.${platform}`,
      source: `shop.entry.source.${platform}`,
    });
  },
);

it.each<{ readonly name: string; readonly facts: ShopEntryFacts }>([
  { name: '开关 false', facts: { ...ALL_MET, enabled: false } },
  { name: '开关字符串 "true"', facts: { ...ALL_MET, enabled: 'true' } },
  { name: '开关数字 1', facts: { ...ALL_MET, enabled: 1 } },
  { name: '开关 null', facts: { ...ALL_MET, enabled: null } },
  { name: '开关没配', facts: { ...ALL_MET, enabled: undefined } },
  { name: '开关对象 {enabled:true}', facts: { ...ALL_MET, enabled: { enabled: true } } },
  { name: '来源没配', facts: { ...ALL_MET, source: undefined } },
  { name: '来源 null', facts: { ...ALL_MET, source: null } },
  { name: '来源空串', facts: { ...ALL_MET, source: '' } },
  { name: '来源不是适配器声明的（合成值）', facts: { ...ALL_MET, source: 'synthetic-other' } },
  { name: '来源大小写不同', facts: { ...ALL_MET, source: 'DATAOKE' } },
  { name: '来源是数组 ["dataoke"]', facts: { ...ALL_MET, source: [DATAOKE] } },
  { name: '适配器没声明 shopConvertSources', facts: { ...ALL_MET, adapterSources: undefined } },
  { name: '适配器声明为空', facts: { ...ALL_MET, adapterSources: [] } },
  { name: '商品没有 shop_ref', facts: { ...ALL_MET, item: { shop_name: SHOP_NAME } } },
  {
    name: '商品 shop_ref 为空串',
    facts: { ...ALL_MET, item: { shop_ref: '', shop_name: SHOP_NAME } },
  },
  { name: '商品没有店名', facts: { ...ALL_MET, item: { shop_ref: SHOP_REF } } },
  { name: '商品店名为空串', facts: { ...ALL_MET, item: { shop_ref: SHOP_REF, shop_name: '' } } },
  { name: '商品两样都没有', facts: { ...ALL_MET, item: {} } },
])('[AC-B1-05zm#2] 四条件全满足才为 true，缺一即 false：$name', ({ facts }) => {
  expect(shopEntryOf(ALL_MET)).toBe(true);
  expect(shopEntryOf(facts)).toBe(false);
});

it('[AC-B1-05zm#3] 任意组合下 shop_entry 恰好等于「开关严格 true ∧ 来源非空且在适配器声明里 ∧ shop_ref 与店名都非空」', () => {
  let checked = 0;
  fc.assert(
    fc.property(
      fc.record({
        enabled: fc.constantFrom<unknown>(true, false, 'true', 1, null, undefined),
        source: fc.constantFrom<unknown>(DATAOKE, '', 'synthetic-other', null, undefined),
        adapterSources: fc.constantFrom<readonly string[] | undefined>(
          [DATAOKE],
          ['synthetic-other'],
          [],
          undefined,
        ),
        ref: fc.constantFrom<string | undefined>(SHOP_REF, '', undefined),
        name: fc.constantFrom<string | undefined>(SHOP_NAME, '', undefined),
      }),
      (s) => {
        const item = {
          ...(s.ref === undefined ? {} : { shop_ref: s.ref }),
          ...(s.name === undefined ? {} : { shop_name: s.name }),
        };
        const expected =
          s.enabled === true &&
          typeof s.source === 'string' &&
          s.source !== '' &&
          s.adapterSources !== undefined &&
          s.adapterSources.includes(s.source) &&
          s.ref !== undefined &&
          s.ref !== '' &&
          s.name !== undefined &&
          s.name !== '';
        expect(
          shopEntryOf({
            enabled: s.enabled,
            source: s.source,
            adapterSources: s.adapterSources,
            item,
          }),
        ).toBe(expected);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
