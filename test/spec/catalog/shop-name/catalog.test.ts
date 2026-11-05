import { expect, it, vi } from 'vitest';
import { createCatalogProductReader } from '../../../../apps/api/src/modules/catalog/application/product-reader.ts';
import type { ProductDetailUpstream } from '../../../../apps/api/src/modules/catalog/detail.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture as cardFixture, item, ref, request } from '../card/kit.ts';
import { fixture as detailFixture, item as detailItem } from '../detail/kit.ts';

// 这里输入的是适配器清洗后的 DTO；每次有名之后再读无名，防止复用上一件商品的店名。
const samples: readonly Partial<UnionItemDetail>[] = [
  { shop_name: '合成青叶  Home旗舰店（东区）' },
  {},
  { shop_name: '合成松果店' },
  {},
];
const expected = ['合成青叶  Home旗舰店（东区）', null, '合成松果店', null];

it.each([
  { ac: 8, platform: 'taobao' },
  { ac: 9, platform: 'jd' },
  { ac: 10, platform: 'pdd' },
] as const)(
  '[AC-B1-04zzg#$ac] $platform 真实 card-assembler 输出店名，缺省显式 null，不用标题或店铺 ID 补',
  async ({ platform }) => {
    const f = cardFixture();
    const names = [];
    for (const fields of samples) {
      const card = await f.service.assemble(
        request({
          item: item({ ...fields, platform, title: '合成标题不能作店名' }),
          ref: ref({ platform, shopId: 'synthetic-shop-id', shopType: 'synthetic-shop-type' }),
        }),
      );
      names.push(card.shop_name);
    }
    expect(names).toEqual(expected);
    expect(f.register).toHaveBeenCalledTimes(samples.length);
  },
);

it('[AC-B1-04zzg#11] getProduct 真实详情卡保留当前 DTO 店名，后续缺失为 null', async () => {
  const f = detailFixture();
  const itemRef = f.issue();
  const names = [];
  for (const fields of samples) {
    f.detail.mockResolvedValue(detailItem(fields));
    names.push((await f.get({ item_ref: itemRef })).shop_name);
  }
  expect(names).toEqual(expected);
  expect(f.detail).toHaveBeenCalledTimes(samples.length);
});

it.each([
  { ac: 12, platform: 'taobao' },
  { ac: 13, platform: 'jd' },
  { ac: 14, platform: 'pdd' },
] as const)(
  '[AC-B1-04zzg#$ac] $platform product-reader 联盟详情摘要有店名则原样，无则 null',
  async ({ platform }) => {
    const detail = vi.fn<ProductDetailUpstream['detail']>();
    const reader = createCatalogProductReader({
      refs: { readProductRef: async () => null },
      upstream: { detail },
      config: { configValue: async () => null },
    });
    const names = [];
    for (const fields of samples) {
      detail.mockResolvedValue(detailItem({ ...fields, platform }));
      const summary = await reader.read({
        appId: 'synthetic-shop-app',
        platform,
        productKey: 'synthetic-shop-product',
        rawItemId: 'synthetic-shop-raw-id',
      });
      names.push(summary.shopName);
    }
    expect(names).toEqual(expected);
    expect(detail).toHaveBeenCalledTimes(samples.length);
  },
);
