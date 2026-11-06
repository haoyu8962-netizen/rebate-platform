// B1-05zh (S-19, D10-713, BR-PROD-04): the one server-side decision of ProductCard.price_spec_hint.
// Pure: no configuration, clock or upstream reads; title, spec_text and prices are never looked at.
// jd in product_key.jd.mode = sku → null (the price is that SKU's); everything else (taobao, pdd,
// jd item mode or no mode) → spec_uncertain. price_from is not produced in this phase.

/** ProductCard.price_spec_hint (contracts/openapi.yaml, CT-26s). */
export type PriceSpecHint = 'price_from' | 'spec_uncertain' | null;

export interface PriceSpecHintInput {
  readonly platform: string;
  /** product_key.jd.mode the card's product_key was derived under; absent means item. */
  readonly jdMode?: 'item' | 'sku';
}

export function priceSpecHintFor(input: PriceSpecHintInput): PriceSpecHint {
  // Strict comparison on purpose: a misread mode ('SKU', ' sku', null…) or platform ('JD') is not sku.
  return input.platform === 'jd' && input.jdMode === 'sku' ? null : 'spec_uncertain';
}
