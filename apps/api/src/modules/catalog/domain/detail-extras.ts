// B1-05zk (D10-664 S-09 S09b, D10-736; 04 §8.3「商品详情专用字段」; contract CT-26s): the five
// detail-only keys of the GET /v1/products/{product_key} card, read from the union detail and the
// platform's switches (a switch is on only when its value is exactly `true`). The union data is
// cached whatever the switches say; only the card blanks it (D10-736 ⑦). shop_entry stays false
// until S-17. Rule tests: test/spec/catalog/detail-extras/**.
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

/**
 * BR-PRICE-21 细则「进店」, D10-736 ②: true only when shop.entry.enabled.<platform> is on,
 * shop.entry.source.<platform> is configured and that source supports the platform, and the product
 * carries a shop id (shop_ref); decided from these alone, without asking the source beforehand.
 * Nothing can make a shop link carrying the user's attribution yet, so the answer is always false.
 * TODO(规划/11 §2.3): shop_entry 店铺转链能力 — blocked on S-17
 */
export function shopEntry(): false {
  return false;
}

/** The five keys of a union detail answer under the given switches. */
export function detailExtras(
  item: Pick<UnionItemDetail, 'coupon_end_at' | 'sales_text' | 'shop_logo' | 'shop_scores'>,
  switches: DetailExtraSwitches,
): DetailExtras {
  return {
    coupon_end_at: switches.couponEnd ? (item.coupon_end_at ?? null) : null,
    sales_text: switches.sales ? (item.sales_text ?? null) : null,
    shop_logo: item.shop_logo ?? null,
    shop_scores:
      switches.shopScores && item.shop_scores !== undefined
        ? item.shop_scores.map(({ key, value }) => ({ key, value }))
        : [],
    shop_entry: shopEntry(),
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
