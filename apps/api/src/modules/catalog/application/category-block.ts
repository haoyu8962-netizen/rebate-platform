// B1-04zzx / B1-04zzzz (D10-860 / D10-1045): the category blocklist over one batch of union items,
// shared by the search tab, the hot-sales list and the home feed's union_material sections.
import type { Logger } from 'pino';
import type { Platform, UnionItem } from '../../union/index.ts';
import { categoryMissing } from '../domain/rules.ts';
import type { Catalog } from '../domain/types.ts';

/** Log message prefix of the calling entry ('search', 'rank', 'section'). */
export type CategoryBlockEntry = 'search' | 'rank' | 'section';

/**
 * One filterCategories call over a batch (after the cache, so a changed list applies to the next
 * request). Returns the blocked candidates; without a filter port nothing is blocked and nothing is
 * logged. Per platform, items without a category are counted under catalog_category_missing (blocked
 * ones included) and blocked items under catalog_category_blocked (only when there are any); the
 * alerts carry the event code, the platform and the count only. The entry only prefixes the log
 * message.
 */
export async function blockedByCategory<T extends { readonly item: UnionItem }>(
  candidates: readonly T[],
  appId: string,
  filter: Pick<Catalog, 'filterCategories'> | undefined,
  logger: Pick<Logger, 'warn'>,
  entry: CategoryBlockEntry,
): Promise<ReadonlySet<T>> {
  if (filter === undefined || candidates.length === 0) return new Set();
  const judged = candidates.map((candidate) => ({
    platform: candidate.item.platform,
    categoryId: candidate.item.category_l1_id ?? null,
    title: candidate.item.title,
    candidate,
  }));
  const kept = new Set(await filter.filterCategories(appId, judged));
  const blocked = new Set<T>();
  const missing = new Map<Platform, number>();
  const blockedCount = new Map<Platform, number>();
  for (const judgedEntry of judged) {
    if (categoryMissing(judgedEntry.categoryId)) {
      missing.set(judgedEntry.platform, (missing.get(judgedEntry.platform) ?? 0) + 1);
    }
    if (kept.has(judgedEntry)) continue;
    blocked.add(judgedEntry.candidate);
    blockedCount.set(judgedEntry.platform, (blockedCount.get(judgedEntry.platform) ?? 0) + 1);
  }
  for (const [platform, count] of missing) {
    logger.warn(
      { event: 'catalog_category_missing', platform, count },
      `${entry}: items without a category, judged by keyword rows only`,
    );
  }
  for (const [platform, count] of blockedCount) {
    logger.warn(
      { event: 'catalog_category_blocked', platform, count },
      `${entry}: items dropped by the category blocklist`,
    );
  }
  return blocked;
}
