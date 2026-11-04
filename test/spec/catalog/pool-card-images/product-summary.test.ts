import { expect, it, vi } from 'vitest';
import { createCatalogProductReader } from '../../../../apps/api/src/modules/catalog/application/product-reader.ts';
import type { ProductDetailUpstream } from '../../../../apps/api/src/modules/catalog/detail.ts';
import {
  createLinkLanding,
  createSnapshotCardReader,
} from '../../../../apps/api/src/modules/linking/application/link-landing.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  LINK,
  NOW,
  TRACE,
  landingData,
  snapshot,
  validate,
} from '../../linking/landing/kit.ts';

const MAIN = 'https://img.synthetic.invalid/summary/main.jpg?size=large&v=1';
const SECOND = 'https://img.synthetic.invalid/summary/second.jpg';
const GALLERY = 'https://img.synthetic.invalid/summary/gallery.jpg';

// Only external read ports are faked. The real summary feeds the real GET-link landing use case.
// Each platform checks positive and absent images together: all cases expose today's null summary.
it.each([
  {
    ac: 4,
    platform: 'taobao',
    key: 'tb:summary',
    raw: 'synthetic-summary',
    ids: { item_id: 'synthetic-summary' },
  },
  {
    ac: 5,
    platform: 'jd',
    key: 'jd:i_summary',
    raw: 'synthetic_summary',
    ids: { itemId: 'synthetic_summary' },
  },
  {
    ac: 6,
    platform: 'pdd',
    key: 'pdd:summary',
    raw: 'synthetic-sign',
    ids: { goods_id: 'summary', goods_sign: 'synthetic-sign' },
  },
] as const)(
  '[AC-B1-05za#$ac] $platform 商品摘要把详情主图带到真实链接落地入口，无主图不从多图补',
  async ({ platform, key, raw, ids }) => {
    const samples: readonly Partial<UnionItemDetail>[] = [
      { main_image_url: MAIN, image_urls: [GALLERY, SECOND] },
      { image_urls: [GALLERY] },
      {},
      { main_image_url: SECOND },
      { image_urls: [] },
    ];
    const detail = vi.fn<ProductDetailUpstream['detail']>();
    const products = createCatalogProductReader({
      refs: { readProductRef: async () => null },
      upstream: { detail },
      config: { configValue: async () => null },
    });
    const link = snapshot({ platform, product_key: key, raw_item_id: raw });
    const service = createLinkLanding({
      callerContext: { current: async () => ({ appId: APP, userId: null, deviceId: null }) },
      links: { find: async () => link },
      cards: createSnapshotCardReader({
        clock: new FixedClock(NOW),
        itemRefs: { issue: () => 'synthetic-item-ref' },
        products,
      }),
    });
    const images: (string | null)[] = [];
    for (const imageFields of samples) {
      detail.mockResolvedValue({
        platform,
        ...ids,
        title: '合成摘要商品',
        price_fen: 6000n,
        coupon_fen: 1000n,
        final_price_fen: 5000n,
        commission_rate_bp: 1500n,
        quoted_at: NOW,
        ...imageFields,
      });
      const result = await service.get({ linkId: LINK, traceId: TRACE });
      expect(result.status).toBe(200);
      await validate(result.envelope, 'LinkLandingResponse');
      const card = landingData(result.envelope).product_card;
      expect(card).toMatchObject({ product_key: key, title: '合成摘要商品' });
      images.push(card.image);
    }
    expect(detail).toHaveBeenCalledTimes(samples.length);
    expect(images).toEqual([MAIN, null, null, SECOND, null]);
  },
);
