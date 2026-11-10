// B3-04b · BR-AI-08 / BR-AI-09: the model-facing parameters of search_products. The model only
// picks a sort enum and integer-fen price bounds; ordering and filtering run on the server.
import type { ToolDefinition } from '../registry/index.ts';

export type SearchSort = 'relevance' | 'rebate_desc' | 'final_price_asc' | 'sales_desc';

export function searchSorts(): readonly SearchSort[] {
  return ['relevance', 'rebate_desc', 'final_price_asc', 'sales_desc'];
}

/** BR-AI-09: K = cards per page, default 8 (also the product_list maximum). */
export function defaultPageSize(): number {
  return 8;
}

/** B3-04e · BR-AI-05 "换一批" → page+1; 08 sets no cap, 5 only guards abuse. */
export function maxSearchPage(): number {
  return 5;
}

/** B3-04e · BR-AI-08 spec word (e.g. 24盒, 500ml); 08 sets no cap, 50 characters. */
export function maxSpecLength(): number {
  return 50;
}

/** B3-04k · 04 §8.5 / BR-AI-17: the only benefits the server can check (coupon ⇔ coupon_fen > 0;
 * taolijin per BR-AI-17). Subsidy, free shipping, flagship store have no data field yet. */
export type SearchBenefit = 'coupon' | 'taolijin';

export function searchBenefits(): readonly SearchBenefit[] {
  return ['coupon', 'taolijin'];
}

/** B3-04k · 04 §8.5 exclude_keywords: at most 5 words of 1–20 characters each. */
export function maxExcludeKeywords(): number {
  return 5;
}

export function maxExcludeKeywordLength(): number {
  return 20;
}

/** B3-04k: brand / category_hint length guard; 08 sets no cap, same as q. */
export function maxHintLength(): number {
  return 100;
}

/** BR-AI-08: 0 < price ≤ 10,000,000 fen. */
export function maxPriceFen(): number {
  return 10_000_000;
}

export function searchProductsDefinition(platforms: readonly string[]): ToolDefinition {
  const price = { type: 'integer', minimum: 1, maximum: maxPriceFen() };
  return {
    name: 'search_products',
    description:
      'Search products on the enabled shopping platforms. Prices are integer fen and compare ' +
      'with the final price; sort is one of the listed values (default relevance). Put a ' +
      'spec word (size, count, volume) in spec, not in q; page asks for the next batch. ' +
      'benefits keeps only items with that benefit; brand and category_hint narrow the search ' +
      'words; exclude_keywords drops items whose title contains any of them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['q'],
      properties: {
        q: { type: 'string', minLength: 1, maxLength: 100 },
        platforms: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: [...platforms] },
        },
        sort: { type: 'string', enum: [...searchSorts()] },
        price_min_fen: price,
        price_max_fen: { ...price },
        limit: { type: 'integer', minimum: 1, maximum: defaultPageSize() },
        // BR-AI-08: the spec word the model splits out of the user text; q never contains it.
        spec: { type: 'string', minLength: 1, maxLength: maxSpecLength() },
        // BR-AI-05: the page for "换一批" (page+1); omitted means the first page.
        page: { type: 'integer', minimum: 1, maximum: maxSearchPage() },
        // B3-04k · 04 §8.5: benefit conditions, checked on the server after the upstream answer.
        benefits: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', enum: [...searchBenefits()] },
        },
        // B3-04k: brand / category_hint only join the upstream search words; they filter nothing.
        brand: { type: 'string', minLength: 1, maxLength: maxHintLength() },
        category_hint: { type: 'string', minLength: 1, maxLength: maxHintLength() },
        exclude_keywords: {
          type: 'array',
          maxItems: maxExcludeKeywords(),
          items: { type: 'string', minLength: 1, maxLength: maxExcludeKeywordLength() },
        },
      },
    },
  };
}
