// B1-05zf (FU-DETAIL-CACHE-IMAGES) rule-test samples: synthetic addresses only (no real host).
import type { UnionItem, UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { APP_ID, PRODUCT_KEY, RAW_ID } from '../cache/kit.ts';
import { NOW, item } from '../detail/kit.ts';

export const MAIN = 'https://img.cache-card.invalid/p/main.jpg';
export const FRESH = 'https://img.cache-card.invalid/p/fresh.jpg';

export function g(n: number): string {
  return `https://img.cache-card.invalid/p/g${n}.jpg`;
}

/** Must come back character for character (case, query, encoding). */
export const ODD = 'https://img.cache-card.invalid/p/Odd%20Name.JPG?size=800x800&v=2';

/** 12 extra images: two repeats (g(1), g(2)) and one equal to the main image. */
export const TWELVE: readonly string[] = [
  g(1),
  g(2),
  MAIN,
  ODD,
  g(1),
  g(4),
  g(5),
  g(2),
  g(6),
  g(7),
  g(8),
  g(9),
];

/** Detail card images of MAIN + TWELVE (B1-05ze): main first, deduplicated before the cut, 9. */
export const NINE: readonly { url: string }[] = [
  { url: MAIN },
  { url: g(1) },
  { url: g(2) },
  { url: ODD },
  { url: g(4) },
  { url: g(5) },
  { url: g(6) },
  { url: g(7) },
  { url: g(8) },
];

export const SHOP = '合成 旗舰店 Ａ&B';
export const CATEGORY_ID = '16';
export const CATEGORY_NAME = '合成类目';

/** The five fields the cache now keeps for the cards. */
export const CARD_FIELDS = [
  'main_image_url',
  'image_urls',
  'shop_name',
  'category_l1_id',
  'category_l1_name',
] as const;

/** A detail answer carrying all five fields. */
export function richDetail(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return item({
    main_image_url: MAIN,
    image_urls: [...TWELVE],
    shop_name: SHOP,
    category_l1_id: CATEGORY_ID,
    category_l1_name: CATEGORY_NAME,
    ...overrides,
  });
}

/** A search answer item carrying all five fields. */
export function richSearchItem(base: UnionItem): UnionItemDetail {
  return {
    ...base,
    main_image_url: MAIN,
    image_urls: [g(1), ODD, g(2)],
    shop_name: SHOP,
    category_l1_id: CATEGORY_ID,
    category_l1_name: CATEGORY_NAME,
  };
}

/** BR-PROD-07 detail key the decorator writes: `<app_id>:product:<product_key>`. */
export const DETAIL_KEY = `${APP_ID}:product:${PRODUCT_KEY}`;

/**
 * A detail entry in the format written before B1-05zf: the original union fields only (amounts as
 * decimal strings), plus whatever `extra` adds to `data`.
 */
export function oldDetailEntry(fetchedAtMs: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    fetched_at_ms: fetchedAtMs,
    data: {
      platform: 'taobao',
      item_id: RAW_ID,
      title: '合成详情商品',
      quoted_at: NOW,
      coupon_ids: 'synthetic-coupon',
      price_fen: '3990',
      coupon_fen: '1000',
      final_price_fen: '2990',
      commission_rate_bp: '2000',
      requested_raw_item_id: RAW_ID,
      ...extra,
    },
  });
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(text: string | undefined): Json {
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return {};
  const data = parsed['data'];
  return isRecord(data) ? data : {};
}

/** `data` of the stored detail entry ({} when there is none, so assertions fail plainly). */
export function storedDetail(rows: ReadonlyMap<string, string>): Json {
  return dataOf(rows.get(DETAIL_KEY));
}

/** The stored `item` of the first candidate of the only search page entry ({} when absent). */
export function storedSearchItem(rows: ReadonlyMap<string, string>): Json {
  const texts = [...rows.values()];
  if (texts.length !== 1) return {};
  const items = dataOf(texts[0])['items'];
  if (!Array.isArray(items)) return {};
  const first: unknown = items[0];
  if (!isRecord(first)) return {};
  const stored = first['item'];
  return isRecord(stored) ? stored : {};
}

/** Overwrites fields of every stored search candidate item in place (same key, same fetched_at). */
export function patchSearchItems(rows: Map<string, string>, patch: Json): void {
  for (const [key, text] of rows) {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) continue;
    const data = parsed['data'];
    if (!isRecord(data)) continue;
    const items = data['items'];
    if (!Array.isArray(items)) continue;
    for (const entry of items as unknown[]) {
      if (!isRecord(entry)) continue;
      const stored = entry['item'];
      if (isRecord(stored)) Object.assign(stored, patch);
    }
    rows.set(key, JSON.stringify(parsed));
  }
}

/** Bad stored image_urls: not an array, or an array whose entries are not all strings. */
export const BAD_IMAGE_URLS: readonly { readonly name: string; readonly value: unknown }[] = [
  { name: '字符串', value: MAIN },
  { name: 'null', value: null },
  { name: '对象', value: { 0: MAIN } },
  { name: '含数字', value: [MAIN, 7] },
  { name: '含 null', value: [MAIN, null] },
  { name: '含嵌套数组', value: [[MAIN]] },
];
