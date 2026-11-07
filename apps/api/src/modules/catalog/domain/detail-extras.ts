// B1-05zk (D10-664 S-09 S09b, D10-736; 04 §8.3「商品详情专用字段」; contract CT-26s): the five
// detail-only keys of the GET /v1/products/{product_key} card, read from the union detail and the
// platform's switches (a switch is on only when its value is exactly `true`). The union data is
// cached whatever the switches say; only the card blanks it (D10-736 ⑦). B1-05zm (S17-c1):
// shop_entry is judged by shopEntryOf. Rule tests: test/spec/catalog/detail-extras/**,
// test/spec/catalog/shop-entry/**.
import type { components } from '@couli/contracts-ts';
import type { UnionItemDetail } from '../../union/index.ts';

type ProductCard = components['schemas']['ProductCard'];

/** The five keys as they go on the detail card (every key present). */
export type DetailExtras = Required<
  Pick<ProductCard, 'coupon_end_at' | 'sales_text' | 'shop_logo' | 'shop_scores' | 'shop_entry'>
>;

/** detail.coupon_end / detail.sales / detail.shop_scores .enabled.<platform>, already judged. */
export interface DetailExtraSwitches {
  readonly couponEnd: boolean;
  readonly sales: boolean;
  readonly shopScores: boolean;
}

/** Configuration keys of the three switches of a platform (platform code, e.g. taobao). */
export function detailExtraSwitchKeys(platform: string): {
  readonly couponEnd: string;
  readonly sales: string;
  readonly shopScores: string;
} {
  return {
    couponEnd: `detail.coupon_end.enabled.${platform}`,
    sales: `detail.sales.enabled.${platform}`,
    shopScores: `detail.shop_scores.enabled.${platform}`,
  };
}

/** A switch value counts as on only when it is exactly `true`. */
export function switchOn(value: unknown): boolean {
  return value === true;
}

/** B1-05zm (S17-c1): configuration keys of a platform's shop entry (platform code, e.g. taobao). */
export interface ShopEntryKeys {
  /** shop.entry.enabled.<platform> (switch, default off). */
  readonly enabled: string;
  /** shop.entry.source.<platform> (where the shop link is converted, e.g. dataoke). */
  readonly source: string;
}

/** B1-05zm: shop.entry.enabled.<platform> and shop.entry.source.<platform> of a platform. */
export function shopEntryKeys(platform: string): ShopEntryKeys {
  return {
    enabled: `shop.entry.enabled.${platform}`,
    source: `shop.entry.source.${platform}`,
  };
}

/** B1-05zm: everything shop_entry is decided from; nothing here is asked of the union. */
export interface ShopEntryFacts {
  /** The value of shop.entry.enabled.<platform> as read (absent: undefined). */
  readonly enabled: unknown;
  /** The value of shop.entry.source.<platform> as read (absent: undefined). */
  readonly source: unknown;
  /** The platform adapter's shopConvertSources; undefined when it declares none. */
  readonly adapterSources: readonly string[] | undefined;
  /** The union detail's shop fields. */
  readonly item: Pick<UnionItemDetail, 'shop_ref' | 'shop_name'>;
}

/**
 * B1-05zm (S17-c1; BR-PRICE-21 细则「进店」, D10-736 ②): true only when ① enabled is exactly
 * `true`, ② source is a configured (non-empty) source, ③ the adapter declares shopConvertSources
 * and it contains that source, and ④ the item carries both a non-empty shop_ref and shop_name.
 */
export function shopEntryOf(facts: ShopEntryFacts): boolean {
  const { enabled, source, adapterSources, item } = facts;
  return (
    switchOn(enabled) &&
    typeof source === 'string' &&
    source !== '' &&
    adapterSources !== undefined &&
    adapterSources.includes(source) &&
    typeof item.shop_ref === 'string' &&
    item.shop_ref !== '' &&
    typeof item.shop_name === 'string' &&
    item.shop_name !== ''
  );
}

/** The five keys of a union detail answer under the given switches. */
export function detailExtras(
  item: Pick<UnionItemDetail, 'coupon_end_at' | 'sales_text' | 'shop_logo' | 'shop_scores'>,
  switches: DetailExtraSwitches,
  shopEntry = false,
): DetailExtras {
  return {
    coupon_end_at: switches.couponEnd ? (item.coupon_end_at ?? null) : null,
    sales_text: switches.sales ? (item.sales_text ?? null) : null,
    shop_logo: item.shop_logo ?? null,
    shop_scores:
      switches.shopScores && item.shop_scores !== undefined
        ? item.shop_scores.map(({ key, value }) => ({ key, value }))
        : [],
    shop_entry: shopEntry,
  };
}

/** The five keys of a card with nothing to show (pool fallback): null / null / null / [] / false. */
export function emptyDetailExtras(): DetailExtras {
  return {
    coupon_end_at: null,
    sales_text: null,
    shop_logo: null,
    shop_scores: [],
    shop_entry: false,
  };
}
