import { expect, it, vi } from 'vitest';
import type { PoolReader } from '../../../../apps/api/src/modules/catalog/application/pool-read.ts';
import {
  getProduct,
  markCachedDetail,
  markStaleDetail,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import { UnionError, type UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { APP_ID, PRODUCT_KEY, fixture, item, productRef } from '../detail/kit.ts';
import { fixture as searchFixture, candidate } from '../search/kit.ts';
import { MAIN, NINE, ODD, TWELVE, g } from './gallery.ts';

function urls(list: readonly string[]) {
  return list.map((url) => ({ url }));
}

it('[AC-B1-05ze#3] 详情卡带 images：主图 + 12 张多图（2 重复、1 同主图）恰 9 张，主图在首、顺序同联盟、无重复', async () => {
  const f = fixture();
  const gallery = Object.freeze([...TWELVE]);
  f.detail.mockResolvedValue(item({ main_image_url: MAIN, image_urls: gallery }));
  const card = await f.get();
  expect(card.images).toEqual(NINE);
  const seen = (card.images ?? []).map((image) => image.url);
  expect(new Set(seen).size).toBe(seen.length);
  expect(card.image).toBe(MAIN);
  expect(gallery).toEqual(TWELVE);
});

it('[AC-B1-05ze#4] 主图缺省只用多图（3 张原样原序），卡片主图字段仍为 null', async () => {
  const f = fixture();
  f.detail.mockResolvedValue(item({ image_urls: [g(3), ODD, g(1)] }));
  const card = await f.get();
  expect(card.images).toEqual(urls([g(3), ODD, g(1)]));
  expect(card.image).toBeNull();
});

it('[AC-B1-05ze#5] 联盟没给任何图时 images 为 []，键仍在', async () => {
  const f = fixture();
  f.detail.mockResolvedValue(item());
  const card = await f.get();
  expect(Object.hasOwn(card, 'images')).toBe(true);
  expect(card.images).toEqual([]);
  expect(card.image).toBeNull();
});

it.each([
  { name: '命中缓存', mark: markCachedDetail },
  { name: '联盟故障用过期缓存', mark: markStaleDetail },
])('[AC-B1-05ze#6] $name 时同一份详情照样带 images', async ({ mark }) => {
  const f = fixture();
  f.detail.mockImplementation(async () =>
    mark(item({ main_image_url: MAIN, image_urls: [...TWELVE] })),
  );
  const card = await f.get();
  expect(card.images).toEqual(NINE);
  expect(card.image).toBe(MAIN);
});

function poolReader(main: string | undefined): PoolReader {
  return {
    page: vi.fn(async () => null),
    fallbackPoolId: vi.fn(async () => null),
    detail: vi.fn(async (appId: string, productKey: string) => {
      void appId;
      return {
        item: item(main === undefined ? {} : { main_image_url: main }),
        ref: productRef({ productKey, source: 'pool' }),
      };
    }),
  };
}

it.each([
  { name: '池行存了主图', main: MAIN, expected: urls([MAIN]) },
  { name: '池行没有主图', main: undefined, expected: [] },
])('[AC-B1-05ze#7] 联盟查不到走池回退：$name，只用池里的主图，不从别处补', async (row) => {
  const f = fixture();
  const reader = poolReader(row.main);
  f.detail.mockRejectedValue(new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'));
  const card = await getProduct({ product_key: PRODUCT_KEY }, { ...f.options, poolReader: reader });
  expect(card.stale).toBe(true);
  expect(reader.detail).toHaveBeenCalledWith(APP_ID, PRODUCT_KEY);
  expect(Object.hasOwn(card, 'images')).toBe(true);
  expect(card.images).toEqual(row.expected);
  expect(card.image).toBe(row.main ?? null);
});

it('[AC-B1-05ze#8] 带 item_ref 原样透传、带 from_link_id 时 images 照样按同一取法', async () => {
  const f = fixture();
  f.detail.mockResolvedValue(item({ main_image_url: MAIN, image_urls: [...TWELVE] }));
  const token = f.issue();
  const tapped = await f.get({ item_ref: token });
  expect(tapped.item_ref).toBe(token);
  expect(tapped.images).toEqual(NINE);
  const sourced = await f.get({ from_link_id: '01920000-0000-7000-8000-00000000e008' });
  expect(sourced.images).toEqual(NINE);
});

it('[AC-B1-05ze#9] 只有详情卡带 images：同样带多图的搜索卡没有 images 键', async () => {
  const s = searchFixture();
  const base = candidate('gallery');
  const rich: UnionItemDetail = { ...base.item, main_image_url: MAIN, image_urls: [...TWELVE] };
  s.pages.set(1, { items: [{ ...base, item: rich }], hasMore: false });
  const result = await s.run();
  expect(result.items).toHaveLength(1);
  for (const searched of result.items) {
    expect(Object.hasOwn(searched, 'images')).toBe(false);
  }

  const f = fixture();
  f.detail.mockResolvedValue(item({ main_image_url: MAIN, image_urls: [...TWELVE] }));
  const card = await f.get();
  expect(card.images).toEqual(NINE);
});
