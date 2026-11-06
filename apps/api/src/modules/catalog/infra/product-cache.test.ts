import { expect, it, vi } from 'vitest';
import { FixedClock, GovernanceError, type RedisNamespace } from '../../platform/index.ts';
import type { UnionItemDetail } from '../../union/index.ts';
import type { ProductDetailUpstream } from '../detail.ts';
import {
  Unreadable,
  cacheDetailUpstream,
  loadItem,
  normalizeKeyword,
  storeItem,
} from './product-cache.ts';

const NOW = '2026-10-08T12:00:00+08:00';

function memory(): RedisNamespace {
  const rows = new Map<string, string>();
  return {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => {
      rows.set(key, value);
    },
    eval: async () => {
      throw new Error('no Lua on the product cache');
    },
  };
}

function item(): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: 'synthetic-raw',
    title: 'synthetic',
    price_fen: 100n,
    coupon_fen: 0n,
    final_price_fen: 100n,
    commission_rate_bp: 1000n,
    quoted_at: NOW,
  };
}

it('[AC-B1-05g] stale_max_age_s 配置超过 3600 时按 3600 计', async () => {
  const clock = new FixedClock(NOW);
  const detail = vi.fn<ProductDetailUpstream['detail']>(async () => item());
  const values = new Map<string, number>([
    ['search.cache_ttl_sec', 1],
    ['search.cache.stale_max_age_s', 7200],
  ]);
  const upstream = cacheDetailUpstream(
    { detail },
    {
      redis: memory(),
      clock,
      config: {
        configValue: async (_app, key) =>
          values.has(key) ? { value: values.get(key)!, version: 1 } : null,
      },
    },
  );
  const request = {
    appId: 'synthetic_app',
    productKey: 'tb:synthetic',
    platform: 'taobao' as const,
    rawItemId: 'synthetic-raw',
  };
  await upstream.detail(request);
  detail.mockRejectedValue(new GovernanceError('circuit_open', 'union.detail', 'synthetic'));
  clock.advanceMs(3_600_000);
  await expect(upstream.detail(request)).resolves.toMatchObject({ title: 'synthetic' });
  clock.advanceMs(1);
  await expect(upstream.detail(request)).rejects.toMatchObject({ code: 'circuit_open' });
});

it('[AC-B1-05g] norm(q)：NFKC、去首尾空白、合并空白、转小写', () => {
  expect(normalizeKeyword('  ＭＩＬＫ\t  Tea  ')).toBe('milk tea');
  expect(normalizeKeyword('合成　纸巾')).toBe('合成 纸巾');
});

it('[AC-B1-05k#5] 详情用例要求原始 ID 一致：同 product_key 换原始 ID 按未命中重查并覆盖，展示读取仍按 product_key 命中', async () => {
  const clock = new FixedClock(NOW);
  const detail = vi.fn<ProductDetailUpstream['detail']>(async () => item());
  const upstream = cacheDetailUpstream(
    { detail },
    { redis: memory(), clock, config: { configValue: async () => null } },
  );
  const base = {
    appId: 'synthetic_app',
    productKey: 'tb:synthetic',
    platform: 'taobao' as const,
  };
  await upstream.detail({ ...base, rawItemId: 'synthetic-raw-a', requireRawMatch: true });
  await upstream.detail({ ...base, rawItemId: 'synthetic-raw-a', requireRawMatch: true });
  expect(detail).toHaveBeenCalledTimes(1);
  await upstream.detail({ ...base, rawItemId: 'synthetic-raw-b', requireRawMatch: true });
  expect(detail).toHaveBeenCalledTimes(2);
  expect(detail).toHaveBeenLastCalledWith(
    expect.objectContaining({ rawItemId: 'synthetic-raw-b' }),
  );
  // The entry now carries raw b: b hits, a misses again.
  await upstream.detail({ ...base, rawItemId: 'synthetic-raw-b', requireRawMatch: true });
  expect(detail).toHaveBeenCalledTimes(2);
  // A display read without the requirement shares the entry whatever its raw ID.
  await upstream.detail({ ...base, rawItemId: 'synthetic-raw-c' });
  expect(detail).toHaveBeenCalledTimes(2);
  await upstream.detail({ ...base, rawItemId: 'synthetic-raw-a', requireRawMatch: true });
  expect(detail).toHaveBeenCalledTimes(3);
});

it('[BR-PROD-07] 重解析写入的条目记住原串：下一次带 product_refs 新原串的请求命中，联盟故障时仍可陈旧作答', async () => {
  const clock = new FixedClock(NOW);
  const detail = vi.fn<ProductDetailUpstream['detail']>(async () => item());
  const upstream = cacheDetailUpstream(
    { detail },
    {
      redis: memory(),
      clock,
      config: {
        configValue: async (_app, key) =>
          key === 'search.cache_ttl_sec' ? { value: 60, version: 1 } : null,
      },
    },
  );
  const base = { appId: 'synthetic_app', productKey: 'tb:synthetic', platform: 'taobao' as const };
  await upstream.detail({ ...base, reparse: { title: 'synthetic', keyPrefix: 'tb' } });
  const next = { ...base, rawItemId: 'synthetic-raw', requireRawMatch: true };
  await upstream.detail(next);
  expect(detail).toHaveBeenCalledTimes(1);
  detail.mockRejectedValue(new GovernanceError('circuit_open', 'union.detail', 'synthetic'));
  clock.advanceMs(60_001);
  await expect(upstream.detail(next)).resolves.toMatchObject({ title: 'synthetic' });
  expect(detail).toHaveBeenCalledTimes(2);
});

const CARD = {
  shop_name: 'synthetic 旗舰店 Ａ&B',
  category_l1_id: '16',
  category_l1_name: 'synthetic category',
  main_image_url: 'https://img.synthetic.invalid/main.JPG?v=2',
  image_urls: [
    'https://img.synthetic.invalid/g1.jpg',
    'https://img.synthetic.invalid/main.JPG?v=2',
    'https://img.synthetic.invalid/g1.jpg',
  ],
} as const;
const CARD_KEYS = Object.keys(CARD);

/** storeItem → JSON text → loadItem, the way the decorators round-trip an entry. */
function roundTrip(input: UnionItemDetail): UnionItemDetail {
  return loadItem(JSON.parse(JSON.stringify(storeItem(input))));
}

it('[AC-B1-05zf#2] storeItem / loadItem 原样存取卡片五字段（多图顺序与重复不变）', () => {
  const rich = { ...item(), ...CARD, image_urls: [...CARD.image_urls] };
  const stored = storeItem(rich);
  for (const key of CARD_KEYS) expect(stored[key]).toEqual(CARD[key as keyof typeof CARD]);
  const loaded = roundTrip(rich);
  expect(loaded).toMatchObject({ ...CARD, image_urls: [...CARD.image_urls], title: 'synthetic' });
  expect(loaded.price_fen).toBe(100n);
});

it('[AC-B1-05zf#3] 联盟没给的卡片字段不存、读出也不带键；只给部分时只存那部分', () => {
  const bare = storeItem(item());
  for (const key of CARD_KEYS) expect(Object.hasOwn(bare, key)).toBe(false);
  const loaded = roundTrip(item());
  for (const key of CARD_KEYS) expect(Object.hasOwn(loaded, key)).toBe(false);
  const partial = roundTrip({ ...item(), main_image_url: CARD.main_image_url, image_urls: [] });
  expect(partial.main_image_url).toBe(CARD.main_image_url);
  expect(partial.image_urls).toEqual([]);
  for (const key of ['shop_name', 'category_l1_id', 'category_l1_name']) {
    expect(Object.hasOwn(partial, key)).toBe(false);
  }
});

it('[AC-B1-05zf#4] 只有原字段的旧条目照常读出', () => {
  const old = {
    platform: 'taobao',
    item_id: 'synthetic-raw',
    title: 'synthetic',
    quoted_at: NOW,
    price_fen: '100',
    coupon_fen: '0',
    final_price_fen: '100',
    commission_rate_bp: '1000',
  };
  const loaded = loadItem(old);
  expect(loaded).toMatchObject({ title: 'synthetic', final_price_fen: 100n });
  for (const key of CARD_KEYS) expect(Object.hasOwn(loaded, key)).toBe(false);
});

const SOME_URL = 'https://img.synthetic.invalid/main.jpg';

it.each<{ name: string; patch: Record<string, unknown> }>([
  { name: 'shop_name 为数字', patch: { shop_name: 7 } },
  { name: 'shop_name 为 null', patch: { shop_name: null } },
  { name: 'category_l1_id 为数字', patch: { category_l1_id: 16 } },
  { name: 'category_l1_name 为对象', patch: { category_l1_name: { name: 'x' } } },
  { name: 'main_image_url 为数组', patch: { main_image_url: [SOME_URL] } },
  { name: 'image_urls 为字符串', patch: { image_urls: SOME_URL } },
  { name: 'image_urls 为 null', patch: { image_urls: null } },
  { name: 'image_urls 为对象', patch: { image_urls: { 0: SOME_URL } } },
  { name: 'image_urls 含数字', patch: { image_urls: [SOME_URL, 7] } },
  { name: 'image_urls 含 null', patch: { image_urls: [null] } },
  { name: 'image_urls 含嵌套数组', patch: { image_urls: [[SOME_URL]] } },
])('[AC-B1-05zf#5] 卡片字段类型不对（$name）按坏条目抛 Unreadable', ({ patch }) => {
  const stored = { ...storeItem(item()), ...patch };
  expect(() => loadItem(stored)).toThrow(Unreadable);
});

it('[AC-B1-05zf#5] 详情条目 image_urls 坏值当未命中：回源并以新答复覆盖条目', async () => {
  const clock = new FixedClock(NOW);
  const rows = new Map<string, string>();
  const redis: RedisNamespace = {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => {
      rows.set(key, value);
    },
    eval: async () => {
      throw new Error('no Lua on the product cache');
    },
  };
  const fresh = { ...item(), image_urls: ['https://img.synthetic.invalid/fresh.jpg'] };
  const detail = vi.fn<ProductDetailUpstream['detail']>(async () => fresh);
  const upstream = cacheDetailUpstream(
    { detail },
    { redis, clock, config: { configValue: async () => null } },
  );
  const key = 'synthetic_app:product:tb:synthetic';
  rows.set(
    key,
    JSON.stringify({
      v: 1,
      fetched_at_ms: clock.now().getTime(),
      data: { ...storeItem(item()), image_urls: ['ok', 7], requested_raw_item_id: null },
    }),
  );
  const request = {
    appId: 'synthetic_app',
    productKey: 'tb:synthetic',
    platform: 'taobao' as const,
  };
  await expect(upstream.detail(request)).resolves.toMatchObject({
    image_urls: ['https://img.synthetic.invalid/fresh.jpg'],
  });
  expect(detail).toHaveBeenCalledTimes(1);
  const written = JSON.parse(rows.get(key)!) as { data: Record<string, unknown> };
  expect(written.data['image_urls']).toEqual(['https://img.synthetic.invalid/fresh.jpg']);
  await upstream.detail(request);
  expect(detail).toHaveBeenCalledTimes(1);
});

const EXTRAS = {
  coupon_end_at: '2026-10-31T23:59:59+08:00',
  sales_text: '已拼 10 万+件',
  shop_logo: 'https://img.synthetic.invalid/shop/logo.png',
  shop_scores: [
    { key: 'desc', value: '高' },
    { key: 'level', value: '5' },
  ],
  shop_ref: '987654321',
} as const satisfies Partial<UnionItemDetail>;
const EXTRA_FIELDS = Object.keys(EXTRAS);

it('[AC-B1-05zk] storeItem / loadItem 原样存取详情专用字段（评分顺序不变），不存 shop_entry', () => {
  const rich: UnionItemDetail = {
    ...item(),
    ...EXTRAS,
    shop_scores: EXTRAS.shop_scores.map((score) => ({ ...score })),
  };
  const stored = storeItem(rich);
  expect(stored).toMatchObject(EXTRAS);
  expect(Object.hasOwn(stored, 'shop_entry')).toBe(false);
  expect(roundTrip(rich)).toMatchObject({ ...EXTRAS, title: 'synthetic' });
});

it('[AC-B1-05zk] 联盟没给的详情专用字段不存、读出也不带键（旧条目照常读出）', () => {
  const stored = storeItem(item());
  for (const key of EXTRA_FIELDS) expect(Object.hasOwn(stored, key)).toBe(false);
  const loaded = roundTrip(item());
  for (const key of EXTRA_FIELDS) expect(Object.hasOwn(loaded, key)).toBe(false);
  expect(loaded.title).toBe('synthetic');
});

it.each<{ name: string; patch: Record<string, unknown> }>([
  { name: 'coupon_end_at 为数字', patch: { coupon_end_at: 1_798_732_799_000 } },
  { name: 'sales_text 为 null', patch: { sales_text: null } },
  { name: 'shop_logo 为数组', patch: { shop_logo: [SOME_URL] } },
  { name: 'shop_ref 为数字', patch: { shop_ref: 987_654_321 } },
  { name: 'shop_scores 为对象', patch: { shop_scores: { key: 'desc', value: '高' } } },
  { name: 'shop_scores 含字符串', patch: { shop_scores: ['高'] } },
  { name: 'shop_scores 的 value 为数字', patch: { shop_scores: [{ key: 'level', value: 5 }] } },
  { name: 'shop_scores 缺 key', patch: { shop_scores: [{ value: '高' }] } },
])('[AC-B1-05zk] 详情专用字段类型不对（$name）按坏条目抛 Unreadable', ({ patch }) => {
  const stored = { ...storeItem(item()), ...patch };
  expect(() => loadItem(stored)).toThrow(Unreadable);
});
