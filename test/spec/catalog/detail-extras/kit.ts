// B1-05zk rule-test kit (D10-664 S-09 S09b, D10-736; 04 §8.3「商品详情专用字段」; contract CT-26s
// ProductCard coupon_end_at / sales_text / shop_logo / shop_scores / shop_entry, only on
// GET /v1/products/{product_key}). Switches are read through config.configValue(appId, key) and
// count as on only when the value is exactly `true`:
//   detail.coupon_end.enabled.<platform>  off → coupon_end_at null
//   detail.sales.enabled.<platform>       off → sales_text null
//   detail.shop_scores.enabled.<platform> off → shop_scores []
//   shop_logo follows the union (null when it gave none), no switch;
//   shop_entry is false until S-17 (shop link conversion), whatever shop.entry.enabled.<platform>,
//   shop.entry.source.<platform> and the product's shop_ref say.
// The existing detail / cache / search kits are reused read only. Synthetic values only.
import { vi } from 'vitest';
import type { PoolReader } from '../../../../apps/api/src/modules/catalog/application/pool-read.ts';
import {
  getProduct,
  type ProductDetailData,
  type ProductDetailOptions,
  type ProductDetailQuery,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import {
  createFavoriteCardPort,
  type FavoriteCardPortOptions,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/ports.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { APP_ID, PRODUCT_KEY, RAW_ID, fixture, item, productRef } from '../detail/kit.ts';

export { APP_ID, PRODUCT_KEY };

/** End of the selected coupon as the union normalised it (ISO 8601, +08:00). */
export const COUPON_END = '2026-10-31T23:59:59+08:00';
/** The union's sales text, unchanged (pinduoduo sales_tip style). */
export const SALES = '已拼10万+件 合成';
export const LOGO = 'https://img.detail-extras.invalid/shop/Logo%20A.png?v=2';
export const SHOP_REF = '987654321';

type ShopScores = NonNullable<UnionItemDetail['shop_scores']>;

/** Four distinct keys (contract maxItems 4), values as the union gave them. */
export const SCORES: ShopScores = [
  { key: 'desc', value: '高' },
  { key: 'serv', value: '中' },
  { key: 'lgst', value: '低' },
  { key: 'level', value: '5' },
];

/** The five detail-only ProductCard keys. */
export const EXTRA_KEYS = [
  'coupon_end_at',
  'sales_text',
  'shop_logo',
  'shop_scores',
  'shop_entry',
] as const;

/** Switch keys of the taobao detail (the detail kit's product is tb:…, platform code taobao). */
export const COUPON_SWITCH = 'detail.coupon_end.enabled.taobao';
export const SALES_SWITCH = 'detail.sales.enabled.taobao';
export const SCORES_SWITCH = 'detail.shop_scores.enabled.taobao';
export const ENTRY_SWITCH = 'shop.entry.enabled.taobao';
export const ENTRY_SOURCE = 'shop.entry.source.taobao';

/** A union detail answer carrying every field the five card keys are read from. */
export function extrasItem(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return item({
    coupon_end_at: COUPON_END,
    sales_text: SALES,
    shop_logo: LOGO,
    shop_scores: SCORES.map((score) => ({ ...score })),
    shop_ref: SHOP_REF,
    ...overrides,
  });
}

type ConfigValue = NonNullable<Awaited<ReturnType<CatalogConfigReader['configValue']>>>['value'];

/**
 * Configuration of the detail kit's app: `values` answers for APP_ID only (another app reads the
 * base); everything else is the base reader's answer.
 */
export function switchConfig(base: CatalogConfigReader) {
  const values = new Map<string, ConfigValue>();
  const configValue = vi.fn(async (appId: string, key: string) => {
    const value = appId === APP_ID ? values.get(key) : undefined;
    return value === undefined ? base.configValue(appId, key) : { value, version: 1 };
  });
  const config: CatalogConfigReader = { configValue };
  return {
    values,
    config,
    configValue,
    /** Every switch of the five fields on, with a configured shop entry source. */
    allOn() {
      for (const key of [COUPON_SWITCH, SALES_SWITCH, SCORES_SWITCH, ENTRY_SWITCH]) {
        values.set(key, true);
      }
      values.set(ENTRY_SOURCE, 'dataoke');
    },
  };
}

/** The detail kit with its configuration replaced by switchConfig. */
export function detailFixture() {
  const f = fixture();
  const settings = switchConfig(f.options.config);
  const options: ProductDetailOptions = { ...f.options, config: settings.config };
  return {
    ...f,
    ...settings,
    options,
    get(query: Partial<ProductDetailQuery> = {}) {
      return getProduct({ product_key: PRODUCT_KEY, ...query }, options);
    },
  };
}

/** The five keys of a card as read (absent keys read as undefined). */
export function extras(card: object) {
  const fields = card as Record<string, unknown>;
  return Object.fromEntries(EXTRA_KEYS.map((key) => [key, fields[key]]));
}

/** Expected five keys when the three switches are as given and the union gave everything. */
export function expected(on: {
  readonly coupon?: boolean | undefined;
  readonly sales?: boolean | undefined;
  readonly scores?: boolean | undefined;
}) {
  return {
    coupon_end_at: on.coupon === true ? COUPON_END : null,
    sales_text: on.sales === true ? SALES : null,
    shop_logo: LOGO,
    shop_scores: on.scores === true ? SCORES : [],
    shop_entry: false,
  };
}

/** The five keys when nothing is shown (pool fallback, union gave none, old cache entries). */
export const EMPTY = {
  coupon_end_at: null,
  sales_text: null,
  shop_logo: null,
  shop_scores: [],
  shop_entry: false,
} as const;

/** Every one of the five keys is an own property of the card. */
export function ownKeys(card: ProductDetailData): boolean[] {
  return EXTRA_KEYS.map((key) => Object.hasOwn(card, key));
}

/** A pool reader whose detail row is the given item (BR-PRICE-11 fallback, TRADE-12). */
export function poolReader(pooled: UnionItemDetail): PoolReader {
  return {
    page: vi.fn(async () => null),
    fallbackPoolId: vi.fn(async () => null),
    detail: vi.fn(async (appId: string, productKey: string) => {
      void appId;
      return { item: pooled, ref: productRef({ productKey, source: 'pool' }) };
    }),
  };
}

/**
 * A favorite's card (catalog/favorites/card-port.ts over getProduct in retrieval mode) on the
 * detail kit's ports, with the given union answer and configuration. The stored product_refs row
 * carries the raw ID the union fake answers, so the card is priced.
 */
export async function favoriteCard(answer: UnionItemDetail, config: CatalogConfigReader) {
  const d = fixture();
  d.readProductRef.mockResolvedValue(productRef({ rawItemId: RAW_ID }));
  d.detail.mockResolvedValue(answer);
  const { viewerContext, cards, ...detail } = d.options;
  void viewerContext;
  void cards;
  const options: FavoriteCardPortOptions = {
    ...detail,
    config,
    quoter: { quote: d.quote },
    registrar: { register: d.register },
    sourceLinks: { entrySource: d.entrySource },
    logger: { warn: vi.fn() },
    products: {
      read: async () => ({ title: '合成详情商品', image: null, shopName: null, shopType: null }),
    },
  };
  const viewer = await d.current();
  return createFavoriteCardPort(options).fetch({
    viewer,
    platform: 'taobao',
    productKey: PRODUCT_KEY,
  });
}
