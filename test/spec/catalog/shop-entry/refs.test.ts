// B1-05zm (S17-c1): the product_refs row each union answer becomes carries shop_id = the union's
// shop_ref (null when it gave none) — search (infra/search-wiring.ts), the hot list
// (infra/hot-rank-wiring.ts) and the detail (detail.ts). The other ref fields are unchanged.
import { expect, it } from 'vitest';
import { createUnionSearchUpstream } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter, UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  NOW,
  fakeAdapter,
  fixture as rankFixture,
  pageRequest,
  platformRow,
  position,
  tbItem,
} from '../hot-rank-upstream/kit.ts';
import { SHOP_REF, entryFixture, shopItem, without } from './kit.ts';

const UNION_SHOP_REF = '7300000000001';

function unionItems(): UnionItem[] {
  return [{ ...tbItem('shop', 1), shop_ref: UNION_SHOP_REF }, tbItem('plain', 2)];
}

it('[AC-B1-05zm#8] 搜索：每个候选的 product_refs 取联盟给的 shop_ref 作 shop_id，没给的为 null，其余字段照旧', async () => {
  const items = unionItems();
  const adapter: UnionAdapter = {
    ...fakeAdapter('taobao').adapter,
    searchItems: async () => ({ items, nextCursor: null }),
  };
  const upstream = createUnionSearchUpstream({
    union: { adapter: () => adapter },
    catalog: { listPlatforms: async () => [platformRow('taobao', 'tb')] },
    config: { configValue: async () => null },
    clock: new FixedClock(NOW),
    ledger: null,
  });
  const page = await upstream.search({
    appId: APP,
    platform: 'taobao',
    keyword: '合成',
    pageNo: 1,
    pageSize: 20,
    sort: 'relevance',
    promotionSlot: 'synthetic-slot',
  });
  expect(page.items.map((candidate) => candidate.ref.shopId)).toEqual([UNION_SHOP_REF, null]);
  expect(page.items.map((candidate) => candidate.ref)).toMatchObject([
    { appId: APP, productKey: 'tb:1', source: 'search', shopType: null, canonicalUrl: null },
    { appId: APP, productKey: 'tb:2', source: 'search', shopType: null, canonicalUrl: null },
  ]);
});

it('[AC-B1-05zm#9] 热榜：每个名次的 product_refs 取联盟给的 shop_ref 作 shop_id，没给的为 null', async () => {
  const f = rankFixture();
  const [withShop, plain] = unionItems();
  f.fake('taobao').setPage({
    items: [position(withShop!, null), position(plain!, '合成销量文本')],
    hasMore: false,
  });
  const page = await f.upstream().page(pageRequest());
  expect(page.items.map((candidate) => candidate.ref.shopId)).toEqual([UNION_SHOP_REF, null]);
  expect(page.items.map((candidate) => candidate.ref.productKey)).toEqual(['tb:1', 'tb:2']);
});

it('[AC-B1-05zm#10] 详情：登记的 product_refs 与卡片所用引用的 shop_id 都取联盟详情的 shop_ref；没给时为 null', async () => {
  const f = entryFixture();
  await f.get();
  expect(f.registerProductRef).toHaveBeenCalledTimes(1);
  expect(f.registerProductRef.mock.calls[0]?.[0]).toMatchObject({
    source: 'detail',
    shopId: SHOP_REF,
    shopType: null,
  });
  expect(f.rows[0]?.ref.shopId).toBe(SHOP_REF);

  const g = entryFixture();
  g.detail.mockResolvedValue(without(shopItem(), 'shop_ref'));
  await g.get();
  expect(g.registerProductRef.mock.calls[0]?.[0]).toMatchObject({ source: 'detail', shopId: null });
  expect(g.rows[0]?.ref.shopId).toBeNull();
});
