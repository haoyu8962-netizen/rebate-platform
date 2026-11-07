// B1-05zh (S-19, D10-713, BR-PROD-04): the one server-side decision of ProductCard.price_spec_hint.
// Pure: no configuration, clock or upstream reads; title, spec_text and prices are never looked at.
// jd in product_key.jd.mode = sku → null (the price is that SKU's); everything else (taobao, pdd,
// jd item mode or no mode) → spec_uncertain.
// B1-04zzn (D10-728 ②): pdd whose price is the union product-detail answer → price_from. 09 登记:
// pdd.ddk.goods.detail's min_group_price is the lowest-priced SKU's price (documented, not
// measured). fromUnionDetail changes nothing for taobao or jd; pdd search / recommend / pool /
// Agent prices stay spec_uncertain.

/** ProductCard.price_spec_hint (contracts/openapi.yaml, CT-26s). */
export type PriceSpecHint = 'price_from' | 'spec_uncertain' | null;

export interface PriceSpecHintInput {
  readonly platform: string;
  /** product_key.jd.mode the card's product_key was derived under; absent means item. */
  readonly jdMode?: 'item' | 'sku';
  /**
   * B1-04zzn (D10-728 ②): true only when the card's price is the union product-detail answer
   * (GET /v1/products/{product_key}: fresh, cache hit or stale entry of that answer). Absent or
   * anything but exactly true means a list / search / pool / Agent price. Pinduoduo's detail price
   * is the lowest SKU's (pdd.ddk.goods.detail min_group_price), so pdd + true reads price_from.
   */
  readonly fromUnionDetail?: boolean;
}

export function priceSpecHintFor(input: PriceSpecHintInput): PriceSpecHint {
  // Strict comparison on purpose: a misread mode ('SKU', ' sku', null…) or platform ('JD') is not sku.
  if (input.platform === 'jd' && input.jdMode === 'sku') return null;
  // Likewise only platform exactly 'pdd' and fromUnionDetail exactly true ('PDD', 1, 'true' are not).
  if (input.platform === 'pdd' && input.fromUnionDetail === true) return 'price_from';
  return 'spec_uncertain';
}
