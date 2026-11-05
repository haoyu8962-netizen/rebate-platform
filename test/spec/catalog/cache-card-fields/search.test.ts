import { expect, it } from 'vitest';
import { searchCache } from '../cache/kit.ts';
import {
  BAD_IMAGE_URLS,
  CARD_FIELDS,
  CATEGORY_ID,
  CATEGORY_NAME,
  MAIN,
  ODD,
  SHOP,
  g,
  patchSearchItems,
  richSearchItem,
  storedSearchItem,
} from './kit.ts';

it('[AC-B1-05zf#6] 搜索同一页联盟答复：未命中与命中时搜索卡的 image、shop_name 相同', async () => {
  const f = searchCache();
  f.searchItems.mockResolvedValue({ items: [richSearchItem(f.publicItem)], nextCursor: null });
  const missed = await f.run();
  const hit = await f.run();
  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(missed.items).toHaveLength(1);
  expect(missed.items[0]?.image).toBe(MAIN);
  expect(missed.items[0]?.shop_name).toBe(SHOP);
  expect(hit.items).toHaveLength(1);
  expect(hit.items[0]?.image).toBe(missed.items[0]?.image);
  expect(hit.items[0]?.shop_name).toBe(missed.items[0]?.shop_name);
  expect(f.set.mock.calls.every(([, , ttl]) => ttl === 3600)).toBe(true);
});

it('[AC-B1-05zf#7] 搜索页条目原样存五个字段；联盟没给的不出现这些键', async () => {
  const f = searchCache();
  f.searchItems.mockResolvedValue({ items: [richSearchItem(f.publicItem)], nextCursor: null });
  await f.run();
  expect(f.rows.size).toBe(1);
  const stored = storedSearchItem(f.rows);
  expect(stored['main_image_url']).toBe(MAIN);
  expect(stored['image_urls']).toEqual([g(1), ODD, g(2)]);
  expect(stored['shop_name']).toBe(SHOP);
  expect(stored['category_l1_id']).toBe(CATEGORY_ID);
  expect(stored['category_l1_name']).toBe(CATEGORY_NAME);

  const plain = searchCache();
  await plain.run();
  expect(plain.rows.size).toBe(1);
  const bare = storedSearchItem(plain.rows);
  expect(bare['title']).toBe(plain.publicItem.title);
  for (const field of CARD_FIELDS) expect(Object.hasOwn(bare, field)).toBe(false);
});

it.each(BAD_IMAGE_URLS)(
  '[AC-B1-05zf#8] 搜索页条目里 image_urls 坏值（$name）按坏条目当未命中：回源出卡',
  async ({ value }) => {
    const f = searchCache();
    f.searchItems.mockResolvedValue({ items: [richSearchItem(f.publicItem)], nextCursor: null });
    await f.run();
    expect(f.rows.size).toBe(1);
    patchSearchItems(f.rows, { image_urls: value });
    const again = await f.run();
    expect(f.searchItems).toHaveBeenCalledTimes(2);
    expect(again.items[0]).toMatchObject({ image: MAIN, shop_name: SHOP });
    expect(storedSearchItem(f.rows)['image_urls']).toEqual([g(1), ODD, g(2)]);
  },
);
