import { describe, expect, it, vi } from 'vitest';
import type { UnionItemDetail } from '../../union/index.ts';
import type { ProductDetailRequest } from '../detail.ts';
import { createCatalogProductReader } from './product-reader.ts';

const APP_ID = 'synthetic_reader_unit';

function unionItem(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return {
    platform: 'jd',
    itemId: 'syn-item-01',
    title: '合成联盟商品',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 2000n,
    quoted_at: '2026-10-08T12:00:00+08:00',
    ...overrides,
  } as UnionItemDetail;
}

function fixture(options: {
  stored?: { title: string; shopType: string | null } | null;
  detail?: () => Promise<UnionItemDetail>;
  jdMode?: string | null;
}) {
  const readProductRef = vi.fn(async () => options.stored ?? null);
  const detail = vi.fn((request: ProductDetailRequest): Promise<UnionItemDetail> =>
    request.rawItemId === undefined
      ? Promise.reject(new Error('synthetic: no raw ID'))
      : (options.detail ?? (async () => unionItem()))(),
  );
  const configValue = vi.fn(async () =>
    options.jdMode === undefined || options.jdMode === null
      ? null
      : { value: options.jdMode, version: 1 },
  );
  const reader = createCatalogProductReader({
    refs: { readProductRef },
    upstream: { detail },
    config: { configValue },
  });
  return { reader, readProductRef, detail, configValue };
}

const QUERY = {
  appId: APP_ID,
  platform: 'jd',
  productKey: 'jd:i_syn01',
  rawItemId: 'syn-item-01',
} as const;

describe('catalog read-only product port (B1-06j landing card)', () => {
  it('[AC-B1-06j] product_refs of the app gives title and shop type without any union call', async () => {
    const f = fixture({ stored: { title: '合成已登记商品', shopType: 'tmall' } });
    await expect(f.reader.read(QUERY)).resolves.toEqual({
      title: '合成已登记商品',
      image: null,
      shopName: null,
      shopType: 'tmall',
    });
    expect(f.readProductRef).toHaveBeenCalledWith(APP_ID, 'jd', 'jd:i_syn01');
    expect(f.detail).not.toHaveBeenCalled();
  });

  it('[AC-B1-06j] without product_refs one union detail by the snapshot raw ID gives the title', async () => {
    const f = fixture({ stored: null, jdMode: 'sku' });
    await expect(f.reader.read(QUERY)).resolves.toEqual({
      title: '合成联盟商品',
      image: null,
      shopName: null,
      shopType: null,
    });
    expect(f.detail).toHaveBeenCalledTimes(1);
    expect(f.detail.mock.calls[0]![0]).toEqual({
      appId: APP_ID,
      productKey: 'jd:i_syn01',
      platform: 'jd',
      rawItemId: 'syn-item-01',
      jdMode: 'sku',
    });
  });

  it('[AC-B1-04zzg] the union detail shop name is passed through; absent stays null', async () => {
    const named = fixture({
      stored: null,
      detail: async () => unionItem({ shop_name: '合成单测店' }),
    });
    await expect(named.reader.read(QUERY)).resolves.toMatchObject({ shopName: '合成单测店' });
    const unnamed = fixture({ stored: null });
    await expect(unnamed.reader.read(QUERY)).resolves.toMatchObject({ shopName: null });
  });

  it('[AC-B1-06j] jd mode defaults to item when unset', async () => {
    const f = fixture({ stored: null });
    await f.reader.read(QUERY);
    expect(f.detail.mock.calls[0]![0]).toMatchObject({ jdMode: 'item' });
  });

  it('[AC-B1-06j] a union failure leaves every product field null', async () => {
    const f = fixture({
      stored: null,
      detail: () => Promise.reject(new Error('synthetic union outage')),
    });
    await expect(f.reader.read(QUERY)).resolves.toEqual({
      title: null,
      image: null,
      shopName: null,
      shopType: null,
    });
  });

  it('[AC-B1-06j] a union answer for another platform is not used', async () => {
    const f = fixture({
      stored: null,
      detail: async () => unionItem({ platform: 'pdd', goods_sign: 'syn-sign' } as never),
    });
    await expect(f.reader.read(QUERY)).resolves.toMatchObject({ title: null });
  });

  it.each([
    ['no product key', { productKey: null }],
    ['no raw ID', { rawItemId: null }],
    ['an unregistered platform', { platform: 'meituan' }],
  ])('[AC-B1-06j] %s: no union call, fields null', async (_label, change) => {
    const f = fixture({ stored: null });
    await expect(f.reader.read({ ...QUERY, ...change })).resolves.toMatchObject({
      title: null,
      shopType: null,
    });
    expect(f.detail).not.toHaveBeenCalled();
  });
  it.each([
    [
      'the main image',
      { main_image_url: 'https://img.synthetic.invalid/unit/main.jpg' },
      'https://img.synthetic.invalid/unit/main.jpg',
    ],
    ['only the gallery', { image_urls: ['https://img.synthetic.invalid/unit/g.jpg'] }, null],
    ['an empty main image', { main_image_url: '' }, null],
  ] as const)(
    '[AC-B1-05za] union detail with %s gives the summary image',
    async (_label, images, expected) => {
      const f = fixture({ stored: null, detail: async () => unionItem(images) });
      await expect(f.reader.read(QUERY)).resolves.toMatchObject({
        title: '合成联盟商品',
        image: expected,
      });
    },
  );
});
