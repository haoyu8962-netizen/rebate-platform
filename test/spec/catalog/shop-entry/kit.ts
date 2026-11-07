// B1-05zm rule-test kit (S17-c1, D10-891 ①; 08 BR-PRICE-21 细则「进店」, D10-736 ②「只用不发请求的判据」).
// The detail card's shop_entry is true only when all four hold:
//   ① shop.entry.enabled.<platform> is exactly `true`;
//   ② shop.entry.source.<platform> is configured (non-empty);
//   ③ that platform's adapter declares shopConvertSources and it contains the source (an adapter
//     without the declaration — jd / pdd today — is false);
//   ④ the union detail carries both a non-empty shop_ref and a non-empty shop_name.
// Deciding it asks the union nothing: the governed adapters are handed in (ProductDetailOptions
// .shopAdapters) only to read their declaration, and every adapter method of the double records.
// The detail-extras / detail / hot-rank-upstream kits are reused read only. Synthetic values only.
import { vi } from 'vitest';
import {
  getProduct,
  type ProductDetailOptions,
  type ProductDetailQuery,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import { cacheDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/product-cache.ts';
import type { GovernedUnion } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  FixedClock,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  RegisteredPlatform,
  UnionAdapter,
  UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP_ID,
  ENTRY_SOURCE,
  ENTRY_SWITCH,
  PRODUCT_KEY,
  SHOP_REF,
  detailFixture,
  extrasItem,
} from '../detail-extras/kit.ts';
import { NOW } from '../detail/kit.ts';
import { fakeAdapter, memoryRedis, type FakeAdapter } from '../hot-rank-upstream/kit.ts';

export { APP_ID, ENTRY_SOURCE, ENTRY_SWITCH, PRODUCT_KEY, SHOP_REF };

/** The union's shop name of the synthetic product (B1-04zzg official field, already cleaned). */
export const SHOP_NAME = '合成旗舰店';
/** The source the taobao adapter declares (UnionAdapter.shopConvertSources). */
export const DATAOKE = 'dataoke';

type ShopSources = NonNullable<UnionAdapter['shopConvertSources']>;
const DECLARED: ShopSources = ['dataoke'];

/** A union detail answer with every shop field: shop_ref (detail-extras kit) and shop_name. */
export function shopItem(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return extrasItem({ shop_name: SHOP_NAME, ...overrides });
}

/** A copy of the answer with the key removed (the union gave none). */
export function without(item: UnionItemDetail, key: 'shop_ref' | 'shop_name'): UnionItemDetail {
  const copy: Record<string, unknown> = { ...item };
  delete copy[key];
  return copy as unknown as UnionItemDetail;
}

export interface ShopAdaptersSetup {
  /** false: the taobao adapter declares no shopConvertSources (as jd / pdd today). */
  readonly declared?: boolean;
}

/**
 * The governed adapters of the three platforms, each a call-recording double whose every method
 * refuses. Only the taobao one declares shopConvertSources ['dataoke'] (unless `declared: false`),
 * with a recording convertShop beside it.
 */
export function shopAdapters(setup: ShopAdaptersSetup = {}) {
  const fakes = new Map<RegisteredPlatform, FakeAdapter>(
    (['taobao', 'jd', 'pdd'] as const).map((platform) => [platform, fakeAdapter(platform)]),
  );
  const convertShop = vi.fn(async (): Promise<never> => {
    throw new Error('synthetic adapter: unexpected convertShop');
  });
  const declared = setup.declared !== false;
  const lookups: RegisteredPlatform[] = [];
  const union: Pick<GovernedUnion, 'adapter'> = {
    adapter(platform: RegisteredPlatform): UnionAdapter {
      lookups.push(platform);
      const fake = fakes.get(platform);
      if (fake === undefined) throw new Error(`synthetic union: no adapter for ${platform}`);
      return platform === 'taobao' && declared
        ? { ...fake.adapter, shopConvertSources: DECLARED, convertShop }
        : fake.adapter;
    },
  };
  return {
    union,
    lookups,
    convertShop,
    /** Every adapter method call of every platform (reading a declaration is no call). */
    unionCalls(): number {
      let calls = convertShop.mock.calls.length;
      for (const fake of fakes.values()) calls += fake.otherCalls.length + fake.channelCalls();
      return calls;
    },
  };
}

export interface EntrySetup extends ShopAdaptersSetup {
  /** false: the detail options carry no shopAdapters at all. */
  readonly adapters?: boolean;
}

/**
 * The detail-extras fixture with all four conditions met: shop.entry.enabled.taobao true,
 * shop.entry.source.taobao dataoke, the taobao adapter declaring dataoke, and a union answer with
 * shop_ref and shop_name. Every other switch is left as the base configuration answers (off).
 */
export function entryFixture(setup: EntrySetup = {}) {
  const d = detailFixture();
  d.values.set(ENTRY_SWITCH, true);
  d.values.set(ENTRY_SOURCE, DATAOKE);
  d.detail.mockResolvedValue(shopItem());
  const adapters = shopAdapters(setup);
  const options: ProductDetailOptions =
    setup.adapters === false ? d.options : { ...d.options, shopAdapters: adapters.union };
  return {
    ...d,
    adapters,
    options,
    get(query: Partial<ProductDetailQuery> = {}) {
      return getProduct({ product_key: PRODUCT_KEY, ...query }, options);
    },
  };
}

export type EntryFixture = ReturnType<typeof entryFixture>;

/** A memory Redis namespace that records every read and write key. */
export function watchedRedis() {
  const memory = memoryRedis();
  const reads: string[] = [];
  const writes: string[] = [];
  const redis: RedisNamespace = {
    get: async (key: string) => {
      reads.push(key);
      return memory.redis.get(key);
    },
    set: async (key: string, value: string, ttlSeconds: number) => {
      writes.push(key);
      await memory.redis.set(key, value, ttlSeconds);
    },
    eval: memory.redis.eval,
  };
  return { redis, rows: memory.rows, reads, writes };
}

/**
 * Puts a union detail answer into the detail cache exactly as production does: the real
 * cacheDetailUpstream over an upstream double answering `answer`, key `<app_id>:product:<key>`.
 */
export async function cacheDetail(
  redis: RedisNamespace,
  appId: string,
  productKey: string,
  answer: UnionItemDetail,
): Promise<void> {
  const upstream = cacheDetailUpstream(
    { detail: async () => answer },
    { redis, clock: new FixedClock(NOW), config: { configValue: async () => null } },
  );
  await upstream.detail({ appId, productKey, platform: 'taobao' });
}

/** A product_refs reader double: the given shop_id for (APP_ID, PRODUCT_KEY), null otherwise. */
export function refsWith(shopId: string | null) {
  return {
    shopIdOf: vi.fn(async (appId: string, productKey: string): Promise<string | null> =>
      appId === APP_ID && productKey === PRODUCT_KEY ? shopId : null,
    ),
  };
}
