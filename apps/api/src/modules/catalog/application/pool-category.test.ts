import { describe, expect, it, vi } from 'vitest';
import type { UnionItemDetail } from '../../union/index.ts';
import { filterByRules } from '../domain/rules.ts';
import type { Catalog, CategoryRule } from '../domain/types.ts';
import { poolCategoryBlocked, type PoolCategoryOptions } from './pool-category.ts';

const APP = 'app_unit';

function item(extra: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: 'synthetic-1',
    title: '合成商品',
    category_l1_id: '9000501',
    ...extra,
  } as UnionItemDetail;
}

function judge(rules: readonly Omit<CategoryRule, 'platform'>[]) {
  const warn = vi.fn();
  const rows = rules.map((rule): CategoryRule => ({ platform: 'taobao', ...rule }));
  const filter: Pick<Catalog, 'filterCategories'> = {
    filterCategories: (_app, items) => Promise.resolve(filterByRules(items, rows)),
  };
  const filterCategories = vi.spyOn(filter, 'filterCategories');
  const options: PoolCategoryOptions = { filter, logger: { warn } };
  return { options, warn, filterCategories };
}

const events = (warn: ReturnType<typeof vi.fn>) =>
  warn.mock.calls.map(([fields, msg]) => ({ fields: fields as unknown, msg: msg as string }));

describe('poolCategoryBlocked', () => {
  it('[AC-B1-05zo-UNIT#1] a category hit is blocked and warns catalog_category_blocked with the pool prefix only', async () => {
    const { options, warn, filterCategories } = judge([{ categoryId: '9000501', keyword: null }]);
    expect(await poolCategoryBlocked(APP, item(), options)).toBe(true);
    expect(filterCategories).toHaveBeenCalledWith(APP, [
      { platform: 'taobao', categoryId: '9000501', title: '合成商品' },
    ]);
    expect(events(warn)).toEqual([
      {
        fields: { event: 'catalog_category_blocked', platform: 'taobao', count: 1 },
        msg: expect.stringMatching(/^pool_admin:/) as unknown as string,
      },
    ]);
  });

  it('[AC-B1-05zo-UNIT#2] no category and no keyword hit passes and warns catalog_category_missing only', async () => {
    const { options, warn } = judge([{ categoryId: '9000501', keyword: null }]);
    expect(await poolCategoryBlocked(APP, item({ category_l1_id: '' }), options)).toBe(false);
    expect(events(warn)).toEqual([
      {
        fields: { event: 'catalog_category_missing', platform: 'taobao', count: 1 },
        msg: expect.stringMatching(/^pool_admin:/) as unknown as string,
      },
    ]);
  });

  it('[AC-B1-05zo-UNIT#3] a categorised item off the list passes silently', async () => {
    const { options, warn } = judge([]);
    expect(await poolCategoryBlocked(APP, item(), options)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
