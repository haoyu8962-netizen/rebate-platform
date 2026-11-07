// B1-04zzn (S-19, D10-728 ②, BR-PROD-04): GET /v1/products/{product_key} through getProduct. A
// pinduoduo card priced from the union product-detail answer — fresh, a detail cache hit, or a stale
// entry served while the union is down (all the same UnionItemDetail) — carries price_spec_hint
// price_from. The detail's pool fallback (50401 → pool row, no union detail) keeps spec_uncertain;
// taobao and jd item-mode details keep spec_uncertain; a jd sku-mode detail keeps null.
import { expect, it } from 'vitest';
import {
  markCachedDetail,
  markStaleDetail,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import { APP_ID, item } from '../detail/kit.ts';
import {
  JD_ITEM_KEY,
  JD_SKU_KEY,
  PDD_KEY,
  PDD_SIGN,
  TB_KEY,
  expectHint,
  jdItemDetail,
  jdSkuDetail,
  outage,
  pddDetail,
  pddFixture,
  pddPool,
} from './kit.ts';

it('[AC-B1-04zzn#10][BR-PROD-04] 拼多多商品详情（联盟详情新鲜答复）→ price_spec_hint = price_from', async () => {
  const f = pddFixture();
  const card = await f.getPdd();
  expect(card.product_key).toBe(PDD_KEY);
  expect(card.platform).toBe('pdd');
  expect(card.stale).toBe(false);
  expect(f.detail).toHaveBeenCalledTimes(1);
  expectHint(card, 'price_from');
});

it('[AC-B1-04zzn#11][BR-PROD-04] 拼多多详情缓存命中（同一份联盟详情）→ price_from', async () => {
  const f = pddFixture();
  f.detail.mockImplementation(async () => markCachedDetail(pddDetail()));
  const card = await f.getPdd();
  expect(card.stale).toBe(false);
  expect(f.registerProductRef).not.toHaveBeenCalled();
  expectHint(card, 'price_from');
});

it('[AC-B1-04zzn#12][BR-PROD-04] 联盟熔断时返回的旧详情缓存（stale=true，仍是联盟详情）→ price_from', async () => {
  const f = pddFixture();
  f.detail.mockImplementation(async () =>
    markStaleDetail(pddDetail({ quoted_at: '2026-10-08T11:57:00+08:00' })),
  );
  const card = await f.getPdd();
  expect(card.stale).toBe(true);
  expectHint(card, 'price_from');
});

it('[AC-B1-04zzn#13][BR-PROD-04] 拼多多详情走池回退（50401 改读商品池行，不是联盟详情）→ spec_uncertain；联盟恢复后同一商品详情 → price_from', async () => {
  const f = pddFixture();
  const pool = pddPool();
  f.detail.mockRejectedValueOnce(outage());
  const pooled = await f.getPdd({}, { poolReader: pool.reader });
  expect(pooled.product_key).toBe(PDD_KEY);
  expect(pooled.stale).toBe(true);
  expect(pool.detail).toHaveBeenCalledWith(APP_ID, PDD_KEY);
  expectHint(pooled, 'spec_uncertain');

  const recovered = await f.getPdd({}, { poolReader: pool.reader });
  expect(recovered.stale).toBe(false);
  expectHint(recovered, 'price_from');
});

it('[AC-B1-04zzn#14][BR-PROD-04] 只收窄拼多多：淘宝详情、京东 item 模式详情 spec_uncertain，京东 sku 模式详情 null；拼多多详情 price_from', async () => {
  const f = pddFixture();

  f.detail.mockResolvedValueOnce(jdItemDetail());
  const jdItem = await f.getAt(JD_ITEM_KEY);
  expect(jdItem.product_key).toBe(JD_ITEM_KEY);
  expectHint(jdItem, 'spec_uncertain');

  f.detail.mockResolvedValueOnce(jdSkuDetail());
  const jdSku = await f.getAt(
    JD_SKU_KEY,
    {},
    { config: { configValue: async () => ({ value: 'sku', version: 1 }) } },
  );
  expect(jdSku.product_key).toBe(JD_SKU_KEY);
  expectHint(jdSku, null);

  f.detail.mockResolvedValueOnce(item());
  const taobao = await f.getAt(TB_KEY);
  expect(taobao.product_key).toBe(TB_KEY);
  expectHint(taobao, 'spec_uncertain');

  const pdd = await f.getPdd();
  expectHint(pdd, 'price_from');
});

it('[AC-B1-04zzn#15][BR-PROD-04] 带来源链接（from_link_id，来源是池 / 搜索卡）的拼多多详情：价格仍取自联盟详情 → price_from', async () => {
  const f = pddFixture();
  f.entrySource.mockResolvedValue('pool');
  const card = await f.getPdd({ from_link_id: 'synthetic-source-link' });
  expect(f.entrySource).toHaveBeenCalledTimes(1);
  expectHint(card, 'price_from');
});

it('[AC-B1-04zzn#16][BR-PROD-04] 带有效 item_ref 的拼多多详情（原样透传引用）→ price_from', async () => {
  const f = pddFixture();
  const itemRef = f.issue({ platform: 'pdd', productKey: PDD_KEY, rawItemId: PDD_SIGN });
  const card = await f.getPdd({ item_ref: itemRef });
  expect(card.item_ref).toBe(itemRef);
  expect(f.detail).toHaveBeenCalledWith(expect.objectContaining({ rawItemId: PDD_SIGN }));
  expectHint(card, 'price_from');
});

it('[AC-B1-04zzn#17][BR-PROD-04] 标题、券、价格不参与：无券、标题写明规格与「起」的拼多多详情也是 price_from', async () => {
  const f = pddFixture();
  f.detail.mockResolvedValue(
    pddDetail({
      title: '合成牛奶 250ml*24 盒 ¥45 起',
      price_fen: 4500n,
      coupon_fen: 0n,
      final_price_fen: 4500n,
    }),
  );
  const card = await f.getPdd();
  expect(card.coupon_fen).toBe(0);
  expectHint(card, 'price_from');
});

it('[AC-B1-04zzn#18][BR-PROD-04] 同一取数器交替出详情：拼多多联盟详情、池回退、淘宝详情、拼多多联盟详情逐次各自判定，不沿用上一次', async () => {
  const f = pddFixture();
  const pool = pddPool();
  const hints: unknown[] = [];
  const run = async (load: () => Promise<object>) => {
    const card = await load();
    expect(card).toHaveProperty('price_spec_hint');
    hints.push((card as Readonly<Record<string, unknown>>)['price_spec_hint']);
  };
  await run(() => f.getPdd());
  f.detail.mockRejectedValueOnce(outage());
  await run(() => f.getPdd({}, { poolReader: pool.reader }));
  f.detail.mockResolvedValueOnce(item());
  await run(() => f.getAt(TB_KEY));
  await run(() => f.getPdd());
  expect(hints).toEqual(['price_from', 'spec_uncertain', 'spec_uncertain', 'price_from']);
});
