import { expect, it } from 'vitest';
import { detailCache } from '../cache/kit.ts';
import { item } from '../detail/kit.ts';
import {
  BAD_IMAGE_URLS,
  CARD_FIELDS,
  CATEGORY_ID,
  CATEGORY_NAME,
  DETAIL_KEY,
  FRESH,
  MAIN,
  NINE,
  SHOP,
  TWELVE,
  g,
  oldDetailEntry,
  richDetail,
  storedDetail,
} from './kit.ts';

it('[AC-B1-05zf#1] 详情同一联盟答复：未命中回源与命中缓存出的卡 image、images、shop_name 相同（主图 + 12 张多图仍是同样 9 张）', async () => {
  const f = detailCache();
  f.getItem.mockResolvedValue(richDetail());
  const missed = await f.get();
  const hit = await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(missed.images).toEqual(NINE);
  expect(missed.image).toBe(MAIN);
  expect(missed.shop_name).toBe(SHOP);
  expect(hit.image).toBe(missed.image);
  expect(hit.images).toEqual(missed.images);
  expect(hit.shop_name).toBe(missed.shop_name);
  expect(hit.images).toEqual(NINE);
  // TTL and the hit decision are unchanged.
  expect(f.set.mock.calls.map(([, , ttl]) => ttl)).toEqual([3600]);
});

it('[AC-B1-05zf#2] 详情条目原样存主图、多图（原顺序含重复）、店铺名、一级类目，仍不存卡片、报价与链接', async () => {
  const f = detailCache();
  f.getItem.mockResolvedValue(richDetail());
  await f.get();
  expect(f.rows.size).toBe(1);
  const data = storedDetail(f.rows);
  expect(data['main_image_url']).toBe(MAIN);
  expect(data['image_urls']).toEqual([...TWELVE]);
  expect(data['shop_name']).toBe(SHOP);
  expect(data['category_l1_id']).toBe(CATEGORY_ID);
  expect(data['category_l1_name']).toBe(CATEGORY_NAME);
  const text = [...f.rows.values()].join('\n');
  for (const forbidden of [
    '"images"',
    '"image"',
    'item_ref',
    'link_id',
    'rebate_min_fen',
    'rebate_max_fen',
    'est_net_price_fen',
  ]) {
    expect(text).not.toContain(forbidden);
  }
});

it('[AC-B1-05zf#3] 联盟答复缺的字段不存、读出也不带，不补空串或空数组；有几个存几个', async () => {
  const f = detailCache();
  f.getItem.mockResolvedValue(item());
  await f.get();
  const bare = storedDetail(f.rows);
  expect(bare['title']).toBe('合成详情商品');
  for (const field of CARD_FIELDS) expect(Object.hasOwn(bare, field)).toBe(false);
  const bareHit = await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(bareHit).toMatchObject({ image: null, images: [], shop_name: null });

  f.rows.clear();
  f.getItem.mockResolvedValue(item({ main_image_url: MAIN, category_l1_id: CATEGORY_ID }));
  await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(2);
  const partial = storedDetail(f.rows);
  expect(partial['main_image_url']).toBe(MAIN);
  expect(partial['category_l1_id']).toBe(CATEGORY_ID);
  for (const field of ['image_urls', 'shop_name', 'category_l1_name'] as const) {
    expect(Object.hasOwn(partial, field)).toBe(false);
  }
  const partialHit = await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(2);
  expect(partialHit).toMatchObject({ image: MAIN, images: [{ url: MAIN }], shop_name: null });
});

it('[AC-B1-05zf#4] 只有原字段的旧条目照常命中出卡（images 由主图缺省得 []、shop_name 缺省）；补存过的条目按存的主图与店铺名出卡', async () => {
  const f = detailCache();
  f.rows.set(DETAIL_KEY, oldDetailEntry(f.clock.now().getTime()));
  const old = await f.get();
  expect(f.getItem).not.toHaveBeenCalled();
  expect(old).toMatchObject({
    title: '合成详情商品',
    image: null,
    images: [],
    shop_name: null,
    stale: false,
  });

  f.rows.set(
    DETAIL_KEY,
    oldDetailEntry(f.clock.now().getTime(), { main_image_url: MAIN, shop_name: SHOP }),
  );
  const enriched = await f.get();
  expect(f.getItem).not.toHaveBeenCalled();
  expect(enriched).toMatchObject({ image: MAIN, images: [{ url: MAIN }], shop_name: SHOP });
});

it.each(BAD_IMAGE_URLS)(
  '[AC-B1-05zf#5] 详情条目 image_urls 坏值（$name）按坏条目当未命中：回源出卡并覆盖条目',
  async ({ value }) => {
    const f = detailCache();
    f.rows.set(
      DETAIL_KEY,
      oldDetailEntry(f.clock.now().getTime(), {
        main_image_url: MAIN,
        image_urls: value,
        shop_name: SHOP,
      }),
    );
    f.getItem.mockResolvedValue(
      item({ main_image_url: FRESH, image_urls: [g(1)], shop_name: 'synthetic fresh shop' }),
    );
    const card = await f.get();
    expect(f.getItem).toHaveBeenCalledTimes(1);
    expect(card).toMatchObject({
      image: FRESH,
      images: [{ url: FRESH }, { url: g(1) }],
      shop_name: 'synthetic fresh shop',
    });
    const data = storedDetail(f.rows);
    expect(data['main_image_url']).toBe(FRESH);
    expect(data['image_urls']).toEqual([g(1)]);
  },
);
