// B1-05zm (S17-c1): catalog's read-only port shopOf(appId, productKey, itemRef?) → { shopRef,
// shopName } | null, exported from catalog/index.ts for linking. First the detail cache (an entry
// counts only with both shop_ref and shop_name), then product_refs (shop_id; product_refs keeps no
// shop name, so a row alone answers null). Never the union (the port is given none), never a
// write, and another app's product of the same key is not visible. Cache entries are written by
// the real cacheDetailUpstream (kit.ts cacheDetail), so the stored format is production's.
import { expect, it } from 'vitest';
import { createShopOf } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP_ID,
  PRODUCT_KEY,
  SHOP_NAME,
  SHOP_REF,
  cacheDetail,
  refsWith,
  shopItem,
  watchedRedis,
  without,
} from './kit.ts';

const ANSWER = { shopRef: SHOP_REF, shopName: SHOP_NAME };
const OTHER_APP = 'synthetic_detail_other';

it('[AC-B1-05zm#13] 详情缓存里同时有 shop_ref 与店名：答 { shopRef, shopName }；带不带 item_ref 一样，只读不写', async () => {
  const cache = watchedRedis();
  await cacheDetail(cache.redis, APP_ID, PRODUCT_KEY, shopItem());
  const written = cache.writes.length;
  const refs = refsWith(null);
  const shopOf = createShopOf({ cache: cache.redis, refs });
  expect(await shopOf(APP_ID, PRODUCT_KEY)).toEqual(ANSWER);
  expect(await shopOf(APP_ID, PRODUCT_KEY, 'synthetic-item-ref')).toEqual(ANSWER);
  expect(cache.reads).toContain(`${APP_ID}:product:${PRODUCT_KEY}`);
  expect(cache.writes).toHaveLength(written);
});

it.each<{ readonly name: string; readonly cached: UnionItemDetail }>([
  { name: '缓存只有 shop_ref 没有店名', cached: without(shopItem(), 'shop_name') },
  { name: '缓存只有店名没有 shop_ref', cached: without(shopItem(), 'shop_ref') },
  { name: '缓存两样都没有', cached: without(without(shopItem(), 'shop_ref'), 'shop_name') },
])(
  '[AC-B1-05zm#14] $name：缓存不算数，product_refs 只有 shop_id 没有店名，答 null',
  async ({ cached }) => {
    const cache = watchedRedis();
    await cacheDetail(cache.redis, APP_ID, PRODUCT_KEY, cached);
    const shopOf = createShopOf({ cache: cache.redis, refs: refsWith(SHOP_REF) });
    expect(await shopOf(APP_ID, PRODUCT_KEY)).toBeNull();
  },
);

it('[AC-B1-05zm#15] 没有缓存条目或没有 Redis：product_refs 有 shop_id 也答 null（没有店名），不报错', async () => {
  const empty = watchedRedis();
  const missing = createShopOf({ cache: empty.redis, refs: refsWith(SHOP_REF) });
  expect(await missing(APP_ID, PRODUCT_KEY)).toBeNull();
  expect(empty.writes).toHaveLength(0);
  const noRedis = createShopOf({ cache: null, refs: refsWith(SHOP_REF) });
  expect(await noRedis(APP_ID, PRODUCT_KEY)).toBeNull();
  const nothing = createShopOf({ cache: null, refs: refsWith(null) });
  expect(await nothing(APP_ID, PRODUCT_KEY)).toBeNull();
});

it('[AC-B1-05zm#16] 按 app 隔离：同一 product_key 在别的 app 的缓存条目不可见', async () => {
  const cache = watchedRedis();
  await cacheDetail(cache.redis, OTHER_APP, PRODUCT_KEY, shopItem());
  const shopOf = createShopOf({ cache: cache.redis, refs: refsWith(SHOP_REF) });
  expect(await shopOf(APP_ID, PRODUCT_KEY)).toBeNull();
  expect(await shopOf(OTHER_APP, PRODUCT_KEY)).toEqual(ANSWER);
  expect(await shopOf(OTHER_APP, 'tb:synthetic002')).toBeNull();
});

it('[AC-B1-05zm#17] 缓存条目读不懂（不是 JSON、版本不对、形状不对）按没有，答 null 不报错', async () => {
  const cache = watchedRedis();
  const key = `${APP_ID}:product:${PRODUCT_KEY}`;
  const shopOf = createShopOf({ cache: cache.redis, refs: refsWith(null) });
  for (const text of [
    'not-json',
    JSON.stringify({
      v: 999,
      fetched_at_ms: 0,
      data: { shop_ref: SHOP_REF, shop_name: SHOP_NAME },
    }),
    JSON.stringify({ v: 1, fetched_at_ms: 0, data: { shop_ref: 7, shop_name: SHOP_NAME } }),
  ]) {
    cache.rows.set(key, text);
    expect(await shopOf(APP_ID, PRODUCT_KEY)).toBeNull();
  }
});
