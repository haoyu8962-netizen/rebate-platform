import { expect, it } from 'vitest';
import { getSectionItems } from '../../../../apps/api/src/modules/catalog/section-items.ts';
import type { ItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import { fixture as detailFixture, item as detailItem } from '../detail/kit.ts';
import { candidate as poolCandidate } from '../hot-rank/kit.ts';
import { candidate, fixture as searchFixture } from '../search/kit.ts';
import { PAGE_KEY, SECTION_ID, sectionFixture } from '../section-items/kit.ts';

const main = 'https://img.synthetic.invalid/catalog/main.jpg?size=large&v=1';
const gallery = 'https://img.synthetic.invalid/catalog/gallery.jpg';
// 正例与缺省例放在同一请求/用例，既钉住有图，也防止从多图补主图或跨商品串图。
const samples: readonly ItemImages[] = [
  { main_image_url: main, image_urls: [gallery] },
  { image_urls: [gallery] },
  {},
  { main_image_url: gallery },
];
const expected = [main, null, null, gallery];

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-04zzf#5] %s 搜索卡 image 取适配器主图，无主图为 null，不从多图补',
  async (platform) => {
    const f = searchFixture();
    const items = samples.map((images, index) => {
      const entry = candidate(`image-${index}`, 1000n, 0n, platform);
      return { ...entry, item: { ...entry.item, ...images } };
    });
    f.pages.set(1, { items, hasMore: false });
    const data = await f.run({ platform, limit: samples.length });
    expect(data.items.map((card) => card.image)).toEqual(expected);
    expect(data.items.map((card) => card.product_key)).toEqual(
      items.map((entry) => entry.ref.productKey),
    );
  },
);

it('[AC-B1-04zzf#6] 首页 product_pool 经 listPageSectionItems 卡片组装保留主图，缺省不补图', async () => {
  const f = sectionFixture();
  const candidates = samples.map((images, index) => {
    const entry = poolCandidate(`image-${index}`);
    return { ...entry, item: { ...entry.item, ...images } };
  });
  f.setSection({ dataSource: { kind: 'product_pool', pool_id: 'synthetic-pool', limit: 4 } });
  const data = await getSectionItems(
    { pageKey: PAGE_KEY, sectionId: SECTION_ID },
    {
      ...f.options,
      poolReader: {
        page: async () => ({ candidates, nextOffset: null }),
        fallbackPoolId: async () => null,
        detail: async () => null,
      },
    },
  );
  expect(data.items.map((card) => card.image)).toEqual(expected);
  expect(data.items.map((card) => card.product_key)).toEqual(
    candidates.map((entry) => entry.ref.productKey),
  );
});

it('[AC-B1-04zzf#7] 详情卡 image 取当前适配器主图，无图和仅多图均为 null', async () => {
  const f = detailFixture();
  const itemRef = f.issue();
  const actual = [];
  for (const images of samples) {
    f.detail.mockResolvedValue(detailItem(images));
    const card = await f.get({ item_ref: itemRef });
    actual.push(card.image);
  }
  expect(actual).toEqual(expected);
});
