import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../platform/index.ts';
import {
  UnionError,
  type UnionAdapter,
  type UnionItem,
  type UnionItemDetail,
} from '../union/index.ts';
import type { CardQuoteContext } from './application/card-assembler.ts';
import { createCatalogCardEntry } from './application/card-entry.ts';
import { createItemRefService } from './application/item-ref.ts';
import type { PoolCandidate, PoolReader } from './application/pool-read.ts';
import {
  getProduct,
  markCachedDetail,
  markStaleDetail,
  type ProductDetailOptions,
  type ProductDetailRequest,
} from './detail.ts';
import { CatalogError, isPlatformServed } from './domain/rules.ts';
import type { PlatformRecord, ProductCapabilities, ProductRef } from './domain/types.ts';
import { createUnionDetailUpstream } from './infra/detail-wiring.ts';
import { createProcessItemRefCipher } from './infra/search-wiring.ts';
import type { Viewer } from './ports.ts';

const NOW = '2026-10-08T12:00:00+08:00';
const APP_ID = 'synthetic_detail_unit';
const PRODUCT_KEY = 'tb:synthetic001';
const RAW_ID = 'synthetic-card-prefix-synthetic001';

function platformRows(): PlatformRecord[] {
  return ['taobao', 'jd', 'pdd'].map((code) => ({
    code,
    key_prefix: code === 'taobao' ? 'tb' : code,
    key_stability: 'unverified' as const,
    search_support: 'supported',
    convert_support: 'supported',
    order_sync_support: 'supported',
    stage: 'M',
  })) as PlatformRecord[];
}

function item(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: RAW_ID,
    title: '合成详情商品',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 2000n,
    quoted_at: NOW,
    ...overrides,
  };
}

/** Every runtime switch reads as off: the default state of search.enabled.<platform> (BR-PROD-10). */
function setup(detail: (request: ProductDetailRequest) => Promise<UnionItemDetail>) {
  const clock = new FixedClock(NOW);
  const viewer: Viewer = {
    appId: APP_ID,
    userId: 'synthetic_viewer',
    deviceId: 'synthetic_device',
  } as Viewer;
  const current = async (): Promise<Viewer> => viewer;
  const itemRefs = createItemRefService({ crypto: createProcessItemRefCipher() });
  const rows = platformRows();
  const upstream = vi.fn(detail);
  // Mirrors Catalog.registerProductRef's serving check (30131 when the platform is not served).
  const registerProductRef = vi.fn(async (ref: ProductRef, capabilities: ProductCapabilities) => {
    const record = rows.find((row) => row.code === ref.platform);
    if (record === undefined || !isPlatformServed(record, capabilities)) {
      throw new CatalogError(30131, 'catalog: platform not supported');
    }
  });
  const register = vi.fn(async () => ({ linkId: randomUUID() }));
  const options: ProductDetailOptions = {
    clock,
    viewerContext: { current },
    itemRefs,
    config: { configValue: async () => null },
    catalog: {
      listPlatforms: async () => rows,
      readProductRef: async () => null,
      registerProductRef,
    },
    upstream: { detail: upstream },
    cards: createCatalogCardEntry({
      clock,
      viewerContext: { current },
      itemRefs,
      registrar: { register },
      sourceLinks: { entrySource: async () => null },
      quoter: {
        quote: async (_item: UnionItem, _viewer: Viewer, context?: CardQuoteContext) => {
          const rebateBasis = context?.rebateBasis ?? 'normal';
          return {
            rebateMinFen: rebateBasis === 'normal' ? 269n : 135n,
            rebateMaxFen: 269n,
            estNetPriceFen: null,
            rebateBasis,
          };
        },
      },
      logger: { warn: vi.fn() },
    }),
  };
  const issue = (rawItemId: string) =>
    itemRefs.issue({
      appId: APP_ID,
      platform: 'taobao',
      productKey: PRODUCT_KEY,
      rawItemId,
      fetchedAt: NOW,
    });
  return { options, clock, upstream, registerProductRef, register, issue };
}

async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error: unknown) {
    return error instanceof CatalogError ? { code: error.code } : error;
  }
}

describe('getProduct (B1-05e, round 2)', () => {
  it('[AC-B1-05e] 搜索开关关闭（默认）时详情仍 200，不读 parse.enabled', async () => {
    const f = setup(async () => item());
    const card = await getProduct(
      { product_key: PRODUCT_KEY, item_ref: f.issue(RAW_ID) },
      f.options,
    );
    expect(card.product_key).toBe(PRODUCT_KEY);
    expect(typeof card.link_id).toBe('string');
    expect(f.registerProductRef).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledTimes(1);
  });

  it.each(['upstream_rejected', 'invalid_dto', 'link_unrecognized'] as const)(
    '[AC-B1-05e] 联盟以 %s 拒绝原串 → 30143（引用失效），不登记 link',
    async (code) => {
      const f = setup(async () => {
        throw new UnionError(code, 'synthetic refusal', 'taobao');
      });
      const result = await outcome(
        getProduct({ product_key: PRODUCT_KEY, item_ref: f.issue(RAW_ID) }, f.options),
      );
      expect(result).toEqual({ code: 30143 });
      expect(f.register).not.toHaveBeenCalled();
    },
  );

  it('[AC-B1-05e] 有效令牌作原串来源时原样返回，即使联盟同键换了原串', async () => {
    const f = setup(async () => item({ item_id: 'synthetic-new-prefix-synthetic001' }));
    const issued = f.issue('synthetic-old-raw');
    const card = await getProduct({ product_key: PRODUCT_KEY, item_ref: issued }, f.options);
    expect(f.upstream.mock.calls[0]?.[0].rawItemId).toBe('synthetic-old-raw');
    expect(card.item_ref).toBe(issued);
  });
});

const POOL_QUOTED_AT = '2026-10-08T11:30:00+08:00';

function poolCandidate(): PoolCandidate {
  return {
    item: item({
      title: '合成池标题',
      quoted_at: POOL_QUOTED_AT,
      coupon_fen: 1490n,
      final_price_fen: 2500n,
    }),
    ref: {
      appId: APP_ID,
      platform: 'taobao',
      productKey: PRODUCT_KEY,
      rawItemId: 'synthetic-pool-raw',
      rawFetchedAt: '2026-10-05T12:00:00+08:00',
      receivedAt: '2026-10-05T12:00:00+08:00',
      canonicalUrl: null,
      title: '合成池标题',
      shopId: null,
      shopType: null,
      source: 'pool',
    },
  };
}

/** The real union upstream over a fake adapter; `pooled` is what the pool reader answers. */
function reparseSetup(
  pooled: PoolCandidate | null,
  union: {
    readonly search?: UnionAdapter['searchItems'];
    readonly getItem?: UnionAdapter['getItem'];
  },
) {
  const searchItems = vi.fn<UnionAdapter['searchItems']>(
    union.search ?? (async () => ({ items: [item()], nextCursor: null })),
  );
  const getItem = vi.fn<UnionAdapter['getItem']>(union.getItem ?? (async () => item()));
  const adapter = { searchItems, getItem } as unknown as UnionAdapter;
  const poolDetail = vi.fn<PoolReader['detail']>(async () => pooled);
  const poolReader: PoolReader = {
    page: async () => null,
    fallbackPoolId: async () => null,
    detail: poolDetail,
  };
  const f = setup(async () => item());
  const options: ProductDetailOptions = {
    ...f.options,
    poolReader,
    upstream: createUnionDetailUpstream({ union: { adapter: () => adapter } }),
  };
  const run = () => getProduct({ product_key: PRODUCT_KEY }, options);
  return { ...f, searchItems, getItem, poolDetail, run };
}

describe('getProduct: BR-PROD-05 ③ of a key with a pool row (B1-05r)', () => {
  it('[BR-PROD-05] 无新鲜原串、有合格池行：online 用途按标题重解析，用新原串取详情，正常卡并写 product_refs', async () => {
    const f = reparseSetup(poolCandidate(), {});
    const card = await f.run();
    expect(card).toMatchObject({ product_key: PRODUCT_KEY, stale: false, final_price_fen: 2990 });
    expect(f.searchItems.mock.calls[0]?.[0]).toEqual({ keyword: '合成池标题' });
    expect(f.searchItems.mock.calls[0]?.[1]).toMatchObject({ appId: APP_ID, purpose: 'online' });
    expect(f.getItem.mock.calls[0]?.[0]).toEqual({ platform: 'taobao', item_id: RAW_ID });
    expect(f.registerProductRef.mock.calls[0]?.[0]).toMatchObject({
      rawItemId: RAW_ID,
      source: 'detail',
    });
  });

  it.each([
    ['搜索', { search: () => Promise.reject(new UnionError('rate_limited', 'x', 'taobao')) }],
    ['详情', { getItem: () => Promise.reject(new UnionError('rate_limited', 'x', 'taobao')) }],
  ])(
    '[BR-PRICE-11][TRADE-12] 重解析时%s答不了 → 池价，stale=true，不写 product_refs',
    async (_n, union) => {
      const f = reparseSetup(poolCandidate(), union);
      const card = await f.run();
      expect(card).toMatchObject({ stale: true, final_price_fen: 2500 });
      expect(Date.parse(String(card.quoted_at))).toBe(Date.parse(POOL_QUOTED_AT));
      expect(f.registerProductRef).not.toHaveBeenCalled();
    },
  );

  it('[BR-PRICE-11] 重解析期间池行超龄：回退时按当时的时钟重读，不展示 → 50401', async () => {
    const f = reparseSetup(poolCandidate(), {});
    const startedAt = f.clock.now().getTime();
    f.poolDetail.mockImplementation(async () =>
      f.clock.now().getTime() > startedAt ? null : poolCandidate(),
    );
    f.searchItems.mockImplementation(async () => {
      f.clock.advanceMs(9_600);
      throw new UnionError('rate_limited', 'x', 'taobao');
    });
    expect(await outcome(f.run())).toEqual({ code: 50401 });
    expect(f.poolDetail).toHaveBeenCalledTimes(2);
    expect(f.register).not.toHaveBeenCalled();
  });

  it('[BR-PROD-05] 平台不支持按标题搜（adapter_unimplemented）→ 30143，不问详情、不写 product_refs', async () => {
    const f = reparseSetup(poolCandidate(), {
      search: () => Promise.reject(new UnionError('adapter_unimplemented', 'x', 'taobao')),
    });
    expect(await outcome(f.run())).toEqual({ code: 30143 });
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.registerProductRef).not.toHaveBeenCalled();
  });

  it('[BR-PROD-05] 联盟作答但第 1 页没有同键 → 30143，不问详情', async () => {
    const other = item({ item_id: 'synthetic-card-prefix-other002' });
    const f = reparseSetup(poolCandidate(), {
      search: async () => ({ items: [other], nextCursor: null }),
    });
    expect(await outcome(f.run())).toEqual({ code: 30143 });
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  });

  it('[BR-PROD-05] 没有合格池行 → 30143，一次联盟都不问', async () => {
    const f = reparseSetup(null, {});
    expect(await outcome(f.run())).toEqual({ code: 30143 });
    expect(f.searchItems).not.toHaveBeenCalled();
    expect(f.getItem).not.toHaveBeenCalled();
  });
});

describe('getProduct: card images (B1-05ze, FU-DETAIL-GALLERY)', () => {
  const MAIN = 'https://img.example.test/unit/main.jpg';
  const EXTRA = 'https://img.example.test/unit/extra.jpg';

  it('[AC-B1-05ze] 详情卡带 images：主图在前、多图去重，item_ref 原样透传时仍在', async () => {
    const f = setup(async () => item({ main_image_url: MAIN, image_urls: [EXTRA, MAIN, EXTRA] }));
    const issued = f.issue(RAW_ID);
    const card = await getProduct({ product_key: PRODUCT_KEY, item_ref: issued }, f.options);
    expect(card.item_ref).toBe(issued);
    expect(card.images).toEqual([{ url: MAIN }, { url: EXTRA }]);
  });

  it('[AC-B1-05ze] 池回退只用池行主图：池里的详情即便带多图也不补', async () => {
    const pooled = poolCandidate();
    const f = reparseSetup(
      { ...pooled, item: { ...pooled.item, main_image_url: MAIN, image_urls: [EXTRA] } },
      { search: () => Promise.reject(new UnionError('rate_limited', 'x', 'taobao')) },
    );
    const card = await f.run();
    expect(card.stale).toBe(true);
    expect(card.images).toEqual([{ url: MAIN }]);
  });

  it('[AC-B1-05ze] 池回退池行无主图 → images 为 []', async () => {
    const f = reparseSetup(poolCandidate(), {
      search: () => Promise.reject(new UnionError('rate_limited', 'x', 'taobao')),
    });
    const card = await f.run();
    expect(card.stale).toBe(true);
    expect(card.images).toEqual([]);
  });

  it('[AC-B1-05ze] images: false 的调用方（非详情路由）卡上没有 images 键', async () => {
    const f = setup(async () => item({ main_image_url: MAIN, image_urls: [EXTRA] }));
    const card = await getProduct({ product_key: PRODUCT_KEY }, { ...f.options, images: false });
    expect(Object.hasOwn(card, 'images')).toBe(false);
  });
});

describe('getProduct: detail-only card keys (B1-05zk, D10-736)', () => {
  const EXTRAS = {
    coupon_end_at: '2026-10-31T23:59:59+08:00',
    sales_text: '已拼 10 万+件',
    shop_logo: 'https://img.example.test/unit/logo.png',
    shop_scores: [{ key: 'desc', value: '高' }],
    shop_ref: '987654321',
  } as const satisfies Partial<UnionItemDetail>;
  const SWITCHES = [
    'detail.coupon_end.enabled.taobao',
    'detail.sales.enabled.taobao',
    'detail.shop_scores.enabled.taobao',
  ];

  const KEYS = ['coupon_end_at', 'sales_text', 'shop_logo', 'shop_scores', 'shop_entry'];

  function switches(values: Record<string, string | number | boolean>) {
    const map = new Map(Object.entries(values));
    return vi.fn(async (_appId: string, key: string) => {
      const value = map.get(key);
      return value === undefined ? null : { value, version: 1 };
    });
  }

  function pick(card: object) {
    const fields = card as Record<string, unknown>;
    return Object.fromEntries(KEYS.map((key) => [key, fields[key]]));
  }

  it('[AC-B1-05zk] 三个开关都为 true：联盟字段原样上卡，shop_entry 为 false；按商品平台读开关', async () => {
    const f = setup(async () => item(EXTRAS));
    const configValue = switches(Object.fromEntries(SWITCHES.map((key) => [key, true])));
    const card = await getProduct(
      { product_key: PRODUCT_KEY },
      { ...f.options, config: { configValue } },
    );
    expect(pick(card)).toEqual({
      coupon_end_at: EXTRAS.coupon_end_at,
      sales_text: EXTRAS.sales_text,
      shop_logo: EXTRAS.shop_logo,
      shop_scores: [{ key: 'desc', value: '高' }],
      shop_entry: false,
    });
    for (const key of SWITCHES) expect(configValue).toHaveBeenCalledWith(APP_ID, key);
  });

  it('[AC-B1-05zk] 开关缺省或不是严格 true：coupon_end_at / sales_text 为 null、shop_scores 为 []，shop_logo 照联盟', async () => {
    const f = setup(async () => item(EXTRAS));
    const configValue = switches({
      'detail.coupon_end.enabled.taobao': 'true',
      'detail.sales.enabled.taobao': 1,
    });
    const card = await getProduct(
      { product_key: PRODUCT_KEY },
      { ...f.options, config: { configValue } },
    );
    expect(pick(card)).toEqual({
      coupon_end_at: null,
      sales_text: null,
      shop_logo: EXTRAS.shop_logo,
      shop_scores: [],
      shop_entry: false,
    });
  });

  it('[AC-B1-05zk] 池回退：五个键为 null / null / null / [] / false', async () => {
    const pooled = poolCandidate();
    const f = reparseSetup(
      { ...pooled, item: { ...pooled.item, ...EXTRAS } },
      { search: () => Promise.reject(new UnionError('rate_limited', 'x', 'taobao')) },
    );
    const card = await f.run();
    expect(card.stale).toBe(true);
    expect(pick(card)).toEqual({
      coupon_end_at: null,
      sales_text: null,
      shop_logo: null,
      shop_scores: [],
      shop_entry: false,
    });
  });

  it('[AC-B1-05zk] detailExtras: false 的调用方卡上没有这五个键，也不读详情开关', async () => {
    const f = setup(async () => item(EXTRAS));
    const configValue = switches({});
    const card = await getProduct(
      { product_key: PRODUCT_KEY },
      { ...f.options, config: { configValue }, detailExtras: false },
    );
    for (const key of KEYS) expect(Object.hasOwn(card, key)).toBe(false);
    for (const key of SWITCHES) expect(configValue).not.toHaveBeenCalledWith(APP_ID, key);
  });
});

describe('getProduct: pinduoduo price_spec_hint from the union detail (B1-04zzn, D10-728 ②)', () => {
  const PDD_KEY = 'pdd:synthetic001';
  const PDD_SIGN = 'synthetic-unit-sign';

  function pddItem(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
    // A pinduoduo answer carries goods_id / goods_sign, not taobao's item_id.
    return {
      platform: 'pdd',
      goods_id: 'synthetic001',
      goods_sign: PDD_SIGN,
      title: '合成拼多多详情商品',
      price_fen: 3990n,
      coupon_fen: 1000n,
      final_price_fen: 2990n,
      commission_rate_bp: 2000n,
      quoted_at: NOW,
      ...overrides,
    };
  }

  it('[AC-B1-04zzn] 拼多多联盟详情（新鲜、缓存命中、stale）→ price_from', async () => {
    for (const answer of [
      () => pddItem(),
      () => markCachedDetail(pddItem()),
      () => markStaleDetail(pddItem()),
    ]) {
      const f = setup(async () => answer());
      const card = await getProduct({ product_key: PDD_KEY }, f.options);
      expect(card.product_key).toBe(PDD_KEY);
      expect(card.price_spec_hint).toBe('price_from');
    }
  });

  it('[AC-B1-04zzn] 淘宝联盟详情仍 spec_uncertain', async () => {
    const f = setup(async () => item());
    const card = await getProduct({ product_key: PRODUCT_KEY }, f.options);
    expect(card.price_spec_hint).toBe('spec_uncertain');
  });

  it('[AC-B1-04zzn] 拼多多池回退（50401 用池行）仍 spec_uncertain', async () => {
    const pooled: PoolCandidate = {
      item: pddItem({ quoted_at: POOL_QUOTED_AT }),
      ref: {
        ...poolCandidate().ref,
        platform: 'pdd',
        productKey: PDD_KEY,
        rawItemId: PDD_SIGN,
      },
    };
    const f = setup(() => Promise.reject(new UnionError('upstream_unavailable', 'x', 'pdd')));
    const poolReader: PoolReader = {
      page: async () => null,
      fallbackPoolId: async () => null,
      detail: async () => pooled,
    };
    const card = await getProduct({ product_key: PDD_KEY }, { ...f.options, poolReader });
    expect(card.stale).toBe(true);
    expect(card.price_spec_hint).toBe('spec_uncertain');
  });

  it('[AC-B1-04zzn] 收藏卡（images / detailExtras 为 false 的非详情路由调用方）仍 spec_uncertain', async () => {
    for (const optOut of [
      { images: false, detailExtras: false },
      { images: false },
      { detailExtras: false },
    ] as const) {
      const f = setup(async () => pddItem());
      const card = await getProduct({ product_key: PDD_KEY }, { ...f.options, ...optOut });
      expect(card.price_spec_hint).toBe('spec_uncertain');
    }
  });
});
