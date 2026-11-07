// B1-04zzn (S-19, D10-728 ②, BR-PROD-04): fixtures for the pinduoduo detail price_from rule tests.
// The detail kit (../detail/kit.ts) is reused read only; every value is synthetic.
//
// D10-728 ②: pdd.ddk.goods.detail documents min_group_price / min_normal_price as the lowest SKU's
// price (规划/09, documented, not measured), so a pinduoduo card whose price is that union detail
// answer says 「¥x 起」 (price_from). Every other card keeps the B1-05zh decision: pinduoduo list /
// search / rank / feed / pool / Agent cards and the detail's pool fallback → spec_uncertain; taobao
// → spec_uncertain; jd item mode → spec_uncertain; jd sku mode → null (detail included).
import { expect, vi } from 'vitest';
import type { PoolReader } from '../../../../apps/api/src/modules/catalog/application/pool-read.ts';
import {
  getProduct,
  type ProductDetailData,
  type ProductDetailOptions,
  type ProductDetailQuery,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import { UnionError, type UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { PRODUCT_KEY, fixture, item, productRef } from '../detail/kit.ts';

export type Hint = 'price_from' | 'spec_uncertain' | null;

/** Pinduoduo product key: pdd:<goods_id>; the raw ID is goods_sign (BR-PROD-03 / 05). */
export const PDD_KEY = 'pdd:synthetic001';
export const PDD_SIGN = 'synthetic-opaque-sign';
export const TB_KEY = PRODUCT_KEY;
/** jd item mode: jd:i_<second segment of itemId>. */
export const JD_ITEM_KEY = 'jd:i_synthetic001';
/** jd sku mode: jd:<skuId>. */
export const JD_SKU_KEY = 'jd:synthetic_sku';

/** A pinduoduo union detail answer (its price is the lowest SKU's per pdd.ddk.goods.detail). */
export function pddDetail(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return item({
    platform: 'pdd',
    item_id: null,
    goods_id: 'synthetic001',
    goods_sign: PDD_SIGN,
    ...overrides,
  });
}

export function jdItemDetail(): UnionItemDetail {
  return item({
    platform: 'jd',
    item_id: null,
    itemId: 'synthetic_synthetic001_tail',
    skuId: 'different_sku',
  });
}

export function jdSkuDetail(): UnionItemDetail {
  return item({
    platform: 'jd',
    item_id: null,
    skuId: 'synthetic_sku',
    itemId: 'synthetic_other_tail',
  });
}

/** The union is down for this call (→ 50401 branch, BR-PRICE-11). */
export function outage(): UnionError {
  return new UnionError('upstream_unavailable', 'synthetic outage', 'pdd');
}

/** A pool whose detail row is a pinduoduo pool row of the asked key (TRADE-12 fallback). */
export function pddPool(pooled: UnionItemDetail = pddDetail()) {
  const detail = vi.fn(async (appId: string, productKey: string) => {
    void appId;
    return {
      item: pooled,
      ref: productRef({ platform: 'pdd', productKey, rawItemId: PDD_SIGN, source: 'pool' }),
    };
  });
  const reader: PoolReader = {
    page: vi.fn(async () => null),
    fallbackPoolId: vi.fn(async () => null),
    detail,
  };
  return { reader, detail };
}

/** The detail kit answering a pinduoduo union detail by default. */
export function pddFixture() {
  const f = fixture();
  f.detail.mockResolvedValue(pddDetail());
  return {
    ...f,
    getAt(
      productKey: string,
      query: Partial<ProductDetailQuery> = {},
      options: Partial<ProductDetailOptions> = {},
    ): Promise<ProductDetailData> {
      return getProduct({ product_key: productKey, ...query }, { ...f.options, ...options });
    },
    getPdd(
      query: Partial<ProductDetailQuery> = {},
      options: Partial<ProductDetailOptions> = {},
    ): Promise<ProductDetailData> {
      return getProduct({ product_key: PDD_KEY, ...query }, { ...f.options, ...options });
    },
  };
}

/** Read loosely: the generated card type may or may not list the field. */
export function hintOf(card: object): unknown {
  return (card as Readonly<Record<string, unknown>>)['price_spec_hint'];
}

/** The card carries the field with exactly this value (absent is not accepted for null). */
export function expectHint(card: object, expected: Hint): void {
  expect(card).toHaveProperty('price_spec_hint');
  expect(hintOf(card)).toBe(expected);
}
