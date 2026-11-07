import { expect, it } from 'vitest';
import {
  one as officialOne,
  searchRow,
  visible,
} from '../taobao-official-search/official-harness.ts';
import { dtkRow, one as dataokeOne } from '../taobao-search/kit.ts';
import { expectNoShopRef, expectShopRef } from './kit.ts';

// 本期淘宝 sellerId 只取大淘客搜索（D10-806 ①）：淘宝官方搜索（searchSource 'official'）不出 shop_ref，
// 即使行里带着同值的卖家 / 店铺键。先过一次大淘客搜索的「有值」对照。

it('[AC-B1-04zzs#7] 只有大淘客搜索出 shop_ref：同一个 sellerId，大淘客搜索带出；淘宝官方搜索行里有同值的卖家 / 店铺键也不出', async () => {
  const seller = '7810000000001';
  const viaDataoke = await dataokeOne(dtkRow(1, { sellerId: seller }));
  expectShopRef(viaDataoke, seller);

  const viaOfficial = await officialOne(
    searchRow(1, {
      basic: { seller_id: 7_810_000_000_001, shop_title: '合成官方店铺' },
      top: { sellerId: seller, seller_id: seller, shop_ref: seller },
    }),
  );
  expectNoShopRef(viaOfficial);
  expect(visible(viaOfficial)).not.toContain(seller);
});
