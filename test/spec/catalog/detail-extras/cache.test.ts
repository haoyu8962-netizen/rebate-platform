// B1-05zk (D10-736 ⑦): the union data behind the five detail-only keys is cached whatever the
// switches say, and only the card blanks it; a hit and a miss under the same switches give the same
// five values (infra/product-cache.ts keeps coupon_end_at, sales_text, shop_logo and shop_scores as
// the union gave them, like the B1-05zf card fields: absent stays absent).
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { detailCache } from '../cache/kit.ts';
import { DETAIL_KEY, oldDetailEntry, storedDetail } from '../cache-card-fields/kit.ts';
import { item } from '../detail/kit.ts';
import {
  COUPON_END,
  COUPON_SWITCH,
  EMPTY,
  ENTRY_SOURCE,
  ENTRY_SWITCH,
  LOGO,
  SALES,
  SALES_SWITCH,
  SCORES,
  SCORES_SWITCH,
  expected,
  extras,
  extrasItem,
  ownKeys,
} from './kit.ts';

const ALL_ON = { coupon: true, sales: true, scores: true } as const;
const ALL_OWN = [true, true, true, true, true];
/** The union fields the detail entry keeps for the five keys (shop_entry is a card decision). */
const STORED_FIELDS = ['coupon_end_at', 'sales_text', 'shop_logo', 'shop_scores'] as const;

function allOn(values: Map<string, string | number | boolean>): void {
  for (const key of [COUPON_SWITCH, SALES_SWITCH, SCORES_SWITCH, ENTRY_SWITCH]) {
    values.set(key, true);
  }
  values.set(ENTRY_SOURCE, 'dataoke');
}

it('[AC-B1-05zk#14] 开关全开：未命中回源与命中缓存出的五个字段相同，都是联盟原样的值', async () => {
  const f = detailCache();
  allOn(f.values);
  f.getItem.mockResolvedValue(extrasItem());
  const missed = await f.get();
  const hit = await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(ownKeys(missed)).toEqual(ALL_OWN);
  expect(extras(missed)).toEqual(expected(ALL_ON));
  expect(ownKeys(hit)).toEqual(ALL_OWN);
  expect(extras(hit)).toEqual(extras(missed));
});

it('[AC-B1-05zk#15] 开关关时联盟数据照常进缓存、只在出卡时置空；之后开关打开，命中同一条目即按存的值出卡，不回源', async () => {
  const f = detailCache();
  f.getItem.mockResolvedValue(extrasItem());
  const off = await f.get();
  expect(extras(off)).toEqual(expected({}));

  const data = storedDetail(f.rows);
  expect(data['coupon_end_at']).toBe(COUPON_END);
  expect(data['sales_text']).toBe(SALES);
  expect(data['shop_logo']).toBe(LOGO);
  expect(data['shop_scores']).toEqual(SCORES);
  expect(Object.hasOwn(data, 'shop_entry')).toBe(false);

  allOn(f.values);
  const on = await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(ownKeys(on)).toEqual(ALL_OWN);
  expect(extras(on)).toEqual(expected(ALL_ON));
});

it('[AC-B1-05zk#16] 联盟没给的字段不存、不补 null 或空数组；命中出卡按缺省给 null / null / null / [] / false', async () => {
  const f = detailCache();
  allOn(f.values);
  f.getItem.mockResolvedValue(item());
  await f.get();
  const bare = storedDetail(f.rows);
  expect(bare['title']).toBe('合成详情商品');
  for (const field of STORED_FIELDS) expect(Object.hasOwn(bare, field)).toBe(false);
  const hit = await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(ownKeys(hit)).toEqual(ALL_OWN);
  expect(extras(hit)).toEqual(EMPTY);
});

it('[AC-B1-05zk#17] 补字段前写下的旧条目照常命中，开关全开也出 null / null / null / [] / false', async () => {
  const f = detailCache();
  allOn(f.values);
  f.rows.set(DETAIL_KEY, oldDetailEntry(f.clock.now().getTime()));
  const card = await f.get();
  expect(f.getItem).not.toHaveBeenCalled();
  expect(card.title).toBe('合成详情商品');
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(EMPTY);
});

it('[AC-B1-05zk#18] 联盟故障用过期缓存出卡（stale）时，五个字段与命中时一样按当时的开关取存下的值', async () => {
  const f = detailCache();
  f.values.set('search.cache.stale_max_age_s', 900);
  f.getItem.mockResolvedValue(extrasItem());
  await f.get();
  f.clock.advanceMs(301_000);
  allOn(f.values);
  f.getItem.mockRejectedValue(new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'));
  const card = await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(2);
  expect(card.stale).toBe(true);
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(expected(ALL_ON));
});
