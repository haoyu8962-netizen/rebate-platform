// B1-05zo (FU-POOL-CATEGORY-BLOCK, D10-1059; CT-26zf 30147 category_blocked): the console's
// product pool refuses a product whose level-one category this app blocks. The judgment is the
// search tab's own (Catalog.filterCategories: this app's active category_blocklist rows, read on
// every call) over the union answer of this call only, never stored data, and only when that
// answer carries the product's details (live, price_status=anomaly included). The pool source
// (pool-source.ts, option `category`) calls it once one product is confirmed and its key matches,
// before the price judgment and before any write; answers without details never reach it.
import type { Logger } from 'pino';
import type { UnionItemDetail } from '../../union/index.ts';
import { categoryMissing } from '../domain/rules.ts';
import type { Catalog } from '../domain/types.ts';

/** 30147 (http 422): the product's category is blocked; carries no data. */
export class PoolCategoryBlockedError extends Error {
  constructor() {
    super('catalog: the product category is blocked for product pools');
    this.name = 'PoolCategoryBlockedError';
  }
}

export interface PoolCategoryOptions {
  readonly filter: Pick<Catalog, 'filterCategories'>;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * True when the app's blocklist drops the item. An item without a category is judged by the
 * keyword rules only (domain/rules.ts); let through, it is counted under catalog_category_missing,
 * blocked, under catalog_category_blocked. The alerts carry the event, platform and count only.
 */
export async function poolCategoryBlocked(
  appId: string,
  item: UnionItemDetail,
  options: PoolCategoryOptions,
): Promise<boolean> {
  const candidate = {
    platform: item.platform,
    categoryId: item.category_l1_id ?? null,
    title: item.title,
  };
  const kept = await options.filter.filterCategories(appId, [candidate]);
  if (kept.length === 0) {
    options.logger.warn(
      { event: 'catalog_category_blocked', platform: item.platform, count: 1 },
      'pool_admin: item refused by the category blocklist',
    );
    return true;
  }
  if (categoryMissing(candidate.categoryId)) {
    options.logger.warn(
      { event: 'catalog_category_missing', platform: item.platform, count: 1 },
      'pool_admin: item without a category, judged by keyword rows only',
    );
  }
  return false;
}
