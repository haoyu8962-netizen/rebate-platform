// B1-04zzx (FU-CATEGORY-BLOCKLIST step 3, single A; D10-860): the search tab's category blocklist.
// The frozen search kit (test/spec/catalog/search/kit.ts) is reused read-only. The blocklist port is
// the optional `categoryFilter` option of searchProducts (frozen fixtures leave it out, so the
// search behaves as before there). The fake port below models the D10-860 rules over in-memory
// active rows per app (disabled rows and the table itself are covered by the *.int.test.ts files):
// - an item with a category is blocked by a row of its platform with the same category id (string
//   equality) whose keyword is empty or occurs in the title as a literal substring;
// - an item without a category (category_l1_id absent or '') is not judged by category: every row
//   of its platform that carries a keyword applies by literal title substring; pure category rows
//   (no keyword) do not apply.
// All values are synthetic.
import { vi } from 'vitest';
import type {
  Catalog,
  CategoryCandidate,
  SearchCandidate,
  SearchProductsOptions,
  SearchProductsQuery,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { searchProducts } from '../../../../apps/api/src/modules/catalog/search.ts';
import * as platformModule from '../../../../apps/api/src/modules/platform/index.ts';
import type { Platform } from '../../../../apps/api/src/modules/union/index.ts';
import { QUERY, candidate, fixture } from '../search/kit.ts';

export const APP = 'synthetic-app';
export const MISSING_EVENT = 'catalog_category_missing';
export const BLOCKED_EVENT = 'catalog_category_blocked';

/** An active category_blocklist row of one app, as the port sees it. */
export interface BlockRow {
  readonly platform: string;
  readonly categoryId: string;
  readonly keyword: string | null;
}

/**
 * A search candidate whose item and product_refs title are both `title` (default
 * `synthetic-<name>`). `category` undefined leaves category_l1_id absent; '' sets an empty string.
 */
export function goods(
  name: string,
  category: string | undefined,
  options: { readonly title?: string; readonly platform?: Platform; readonly final?: bigint } = {},
): SearchCandidate {
  const base = candidate(name, options.final ?? 1000n, 0n, options.platform ?? 'taobao');
  const title = options.title ?? base.item.title;
  return {
    item: {
      ...base.item,
      title,
      ...(category === undefined ? {} : { category_l1_id: category }),
    },
    ref: { ...base.ref, title },
  };
}

function noCategory(id: string | null | undefined): boolean {
  return id === null || id === undefined || id === '';
}

function hasKeyword(row: BlockRow): row is BlockRow & { readonly keyword: string } {
  return row.keyword !== null && row.keyword !== '';
}

/** The D10-860 decision for one candidate against one app's active rows. */
export function isBlocked(item: CategoryCandidate, rows: readonly BlockRow[]): boolean {
  return rows.some((row) => {
    if (row.platform !== item.platform) return false;
    if (noCategory(item.categoryId)) return hasKeyword(row) && item.title.includes(row.keyword);
    return (
      row.categoryId === item.categoryId && (!hasKeyword(row) || item.title.includes(row.keyword))
    );
  });
}

/** In-memory blocklist port: rows per app; every call is recorded (app id and plain fields). */
export function blocklist() {
  const rows = new Map<string, BlockRow[]>();
  const calls: { appId: string; items: CategoryCandidate[] }[] = [];
  const port: Pick<Catalog, 'filterCategories'> = {
    async filterCategories<T extends CategoryCandidate>(
      appId: string,
      items: readonly T[],
    ): Promise<T[]> {
      calls.push({
        appId,
        items: items.map((item) => ({
          platform: item.platform,
          categoryId: item.categoryId,
          title: item.title,
        })),
      });
      const active = rows.get(appId) ?? [];
      return items.filter((item) => !isBlocked(item, active));
    },
  };
  return {
    rows,
    calls,
    port,
    block(appId: string, list: readonly BlockRow[]) {
      rows.set(appId, [...list]);
    },
  };
}

/** The frozen search fixture with the blocklist port wired in. */
export function setup() {
  const f = fixture();
  const list = blocklist();
  const options: SearchProductsOptions = { ...f.options, categoryFilter: list.port };
  return {
    ...f,
    ...list,
    options,
    run(query: Partial<SearchProductsQuery> = {}) {
      return searchProducts({ ...QUERY, ...query }, options);
    },
  };
}

interface WarnRecorder {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** First arguments of the warn calls carrying `event`. */
export function alerts(warn: WarnRecorder, event: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of warn.mock.calls) {
    const fields = call[0];
    if (typeof fields !== 'object' || fields === null) continue;
    const record = fields as Record<string, unknown>;
    if (record['event'] === event) out.push(record);
  }
  return out;
}

/** Sum of `count` over the alerts; a non-number count makes the sum NaN (never equal). */
export function total(list: readonly Record<string, unknown>[]): number {
  let sum = 0;
  for (const fields of list) {
    const count = fields['count'];
    sum += typeof count === 'number' ? count : Number.NaN;
  }
  return sum;
}

/** One selectable synthetic channel per platform for the fallback feed (CT-15m whitelist). */
export function feedChannels(): void {
  vi.spyOn(platformModule, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: (['taobao', 'jd', 'pdd'] as const).map((platform) => ({
      platform,
      channel_id: `synthetic-${platform}-channel`,
      name: 'synthetic',
      sort_basis: 'sales' as const,
      selectable: true,
      source: 'synthetic',
    })),
  });
}

export function titles(cards: readonly { readonly title?: string | null }[]): (string | null)[] {
  return cards.map((card) => card.title ?? null);
}
