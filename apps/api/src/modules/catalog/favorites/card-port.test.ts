import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { DemoUnionError, UnionError, type UnionItemDetail } from '../../union/index.ts';
import type { CardQuoteContext } from '../application/card-assembler.ts';
import type { CatalogProductReader } from '../application/product-reader.ts';
import type { ProductDetailRequest } from '../detail.ts';
import type { PlatformRecord, ProductRef } from '../domain/types.ts';
import type { RegisterLinkInput, Viewer } from '../ports.ts';
import { createFavoriteCardPort, type FavoriteCardPortOptions } from './card-port.ts';
import { favoriteCardView } from './rules.ts';

const NOW = '2031-05-20T04:00:00.000Z';
const viewer: Viewer = {
  appId: 'favorite-app',
  userId: 'favorite-user',
  deviceId: 'favorite-device',
};
const request = { viewer, platform: 'taobao', productKey: 'tb:AbC' };
const platforms: PlatformRecord[] = [
  ['taobao', 'tb'],
  ['jd', 'jd'],
  ['pdd', 'pdd'],
].map(([code, prefix]) => ({
  code: code!,
  key_prefix: prefix!,
  key_stability: 'unverified',
  search_support: 'supported',
  convert_support: 'supported',
  order_sync_support: 'supported',
  stage: 'M',
}));

function setup() {
  const item: UnionItemDetail = {
    platform: 'taobao',
    item_id: 'original-prefix-AbC',
    title: '演示收藏商品',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 2000n,
    quoted_at: NOW,
  };
  const stored: ProductRef = {
    appId: viewer.appId,
    platform: 'taobao',
    productKey: 'tb:AbC',
    rawItemId: 'original-prefix-AbC',
    rawFetchedAt: NOW,
    receivedAt: NOW,
    canonicalUrl: null,
    title: '原收藏标题',
    shopId: null,
    shopType: null,
    source: 'search',
  };
  const detail = vi.fn<(request: ProductDetailRequest) => Promise<UnionItemDetail>>(
    async () => item,
  );
  const register = vi.fn<(input: RegisterLinkInput) => Promise<{ linkId: string }>>(async () => ({
    linkId: 'favorite-link',
  }));
  const registerProductRef = vi.fn<(ref: ProductRef) => Promise<void>>(async () => undefined);
  const read = vi.fn<CatalogProductReader['read']>(async () => ({
    title: '原收藏标题',
    image: 'https://example.com/favorite.png',
    shopName: null,
    shopType: null,
  }));
  const quote = vi.fn(
    async (_item: UnionItemDetail, _viewer: Viewer, context?: CardQuoteContext) => ({
      rebateMinFen: 10n,
      rebateMaxFen: 10n,
      estNetPriceFen: 2980n,
      rebateBasis: context?.rebateBasis ?? 'normal',
    }),
  );
  const issue = vi.fn(() => 'favorite-item-ref');
  const warn = vi.fn();
  const options: FavoriteCardPortOptions = {
    clock: new FixedClock(NOW),
    config: { configValue: async () => null },
    catalog: {
      listPlatforms: async () => platforms,
      readProductRef: async () => stored,
      registerProductRef,
    },
    itemRefs: { verify: () => null, read: () => null, issue },
    upstream: { detail },
    products: { read },
    registrar: { register },
    quoter: { quote },
    sourceLinks: { entrySource: async () => null },
    logger: { warn },
  };
  return { options, item, stored, detail, register, registerProductRef, read, quote, issue, warn };
}

it('[AC-B1-28b#47] 真实取卡组合使用当前用户和原始商品 ID，登记 link 与报价快照', async () => {
  const f = setup();
  const result = await createFavoriteCardPort(f.options).fetch(request);
  expect(result).toMatchObject({
    kind: 'card',
    card: {
      product_key: 'tb:AbC',
      title: '演示收藏商品',
      link_id: 'favorite-link',
      final_price_fen: 2990,
      rebate_min_fen: 10,
      availability: 'ok',
      stale: false,
    },
  });
  expect(f.detail).toHaveBeenCalledExactlyOnceWith({
    appId: viewer.appId,
    platform: 'taobao',
    productKey: 'tb:AbC',
    rawItemId: 'original-prefix-AbC',
    requireRawMatch: true,
  });
  expect(f.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      viewer,
      item: f.item,
      ref: expect.objectContaining({ productKey: 'tb:AbC', receivedAt: NOW }),
      quote: expect.objectContaining({ rebateMinFen: 10n, rebateMaxFen: 10n }),
    }),
  );
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B1-05ze] 收藏卡不带 images：联盟详情有主图与多图时卡上也没有 images 键', async () => {
  const f = setup();
  f.detail.mockResolvedValue({
    ...f.item,
    main_image_url: 'https://img.example.test/favorite/main.jpg',
    image_urls: ['https://img.example.test/favorite/g1.jpg'],
  });
  const result = await createFavoriteCardPort(f.options).fetch(request);
  expect(result.kind).toBe('card');
  expect(result).not.toHaveProperty('card.images');
  expect(favoriteCardView(result).productCard).not.toHaveProperty('images');
});

it('[AC-B1-28b#48] retrieval 价格异常不报价、不发引用、不登记 link，并记录 retrieval 场景', async () => {
  const f = setup();
  f.detail.mockResolvedValue({ ...f.item, price_status: 'anomaly' });
  await expect(createFavoriteCardPort(f.options).fetch(request)).rejects.toMatchObject({
    code: 50303,
  });
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.issue).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'PRICE_ANOMALY', scene: 'retrieval' }),
    expect.any(String),
  );
});

it.each([
  new UnionError('item_unavailable', 'Unavailable product', 'taobao'),
  new DemoUnionError('demo_delisted', 'Delisted demo product', 'taobao'),
])('[AC-B1-28b#49] 商品不可用信号 %s 只读取标题与图，不登记 link', async (error) => {
  const f = setup();
  f.detail.mockRejectedValue(error);
  const result = await createFavoriteCardPort(f.options).fetch(request);
  expect(result).toMatchObject({ kind: 'unavailable' });
  expect(favoriteCardView(result)).toEqual({
    invalid: true,
    productCard: { title: '原收藏标题', image: 'https://example.com/favorite.png' },
  });
  expect(f.read).toHaveBeenCalledExactlyOnceWith({
    appId: viewer.appId,
    platform: 'taobao',
    productKey: 'tb:AbC',
    rawItemId: null,
  });
  expect(f.register).not.toHaveBeenCalled();
  expect(f.registerProductRef).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
});

it('[AC-B1-28b#50] 未知取卡异常交给收藏列表逐项降级，不伪造商品卡', async () => {
  const f = setup();
  const error = new Error('Synthetic read failure');
  f.detail.mockRejectedValue(error);
  await expect(createFavoriteCardPort(f.options).fetch(request)).rejects.toBe(error);
  expect(f.register).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B1-28b#51] 平台与商品前缀不一致时不调用联盟', async () => {
  const f = setup();
  await expect(
    createFavoriteCardPort(f.options).fetch({ ...request, platform: 'jd' }),
  ).rejects.toMatchObject({ code: 20001 });
  expect(f.detail).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it.each([
  { item_id: 'another-prefix-Different' },
  { item_id: 'invalid-' },
  { platform: 'jd' as const, itemId: 'prefix_AbC' },
])('[AC-B1-28b#52] 联盟响应无法派生同一商品身份 %j 时不写引用、不登记 link', async (patch) => {
  const f = setup();
  f.detail.mockResolvedValue({ ...f.item, ...patch });
  await expect(createFavoriteCardPort(f.options).fetch(request)).rejects.toMatchObject({
    code: 30143,
  });
  expect(f.registerProductRef).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-28b#53] 同一取卡端口并发服务两个用户，报价与 link 归属各自保持一致', async () => {
  const f = setup();
  const port = createFavoriteCardPort(f.options);
  const other: Viewer = { ...viewer, userId: 'other-user', deviceId: 'other-device' };
  await Promise.all([port.fetch(request), port.fetch({ ...request, viewer: other })]);
  expect(f.quote.mock.calls.map((call) => call[1])).toEqual(
    expect.arrayContaining([viewer, other]),
  );
  expect(f.register.mock.calls.map((call) => call[0].viewer)).toEqual(
    expect.arrayContaining([viewer, other]),
  );
  expect(f.register).toHaveBeenCalledTimes(2);
});

it('[AC-B1-28b#54] 引用过期时不从商品键推算联盟原始 ID', async () => {
  const f = setup();
  f.options.catalog.readProductRef = async () => ({
    ...f.stored,
    receivedAt: '2031-05-19T04:00:00.000Z',
  });
  await createFavoriteCardPort(f.options).fetch(request);
  expect(f.detail).toHaveBeenCalledExactlyOnceWith({
    appId: viewer.appId,
    platform: 'taobao',
    productKey: 'tb:AbC',
  });
});

it('[AC-B1-28b#55] 报价或 link 登记失败原样交给列表降级', async () => {
  const f = setup();
  const error = new Error('Synthetic registration failure');
  f.register.mockRejectedValue(error);
  await expect(createFavoriteCardPort(f.options).fetch(request)).rejects.toBe(error);
  expect(f.register).toHaveBeenCalledTimes(1);
});
