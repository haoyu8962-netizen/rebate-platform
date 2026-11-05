import { expect, it } from 'vitest';
import { getProduct } from '../../../../apps/api/src/modules/catalog/detail.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionError, UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { APP_ID, NOW, PRODUCT_KEY, RAW_ID, fixture, item, productRef } from './kit.ts';

it('[AC-B1-05e#1] 详情下发券、券后价、报价器返利和原取价时间，每次登记新链接', async () => {
  const f = fixture();
  const first = await f.get();
  f.clock.advanceMs(180_000);
  const second = await f.get();
  expect(first).toMatchObject({
    product_key: PRODUCT_KEY,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    // B1-05zc (D10-641): a detail without a source card quotes one amount on the normal basis.
    rebate_min_fen: 269,
    rebate_max_fen: 269,
    rebate_basis: 'normal',
    quoted_at: NOW,
    age_sec: 0,
    stale: false,
    availability: 'ok',
    item_ref: expect.any(String),
    link_id: expect.any(String),
  });
  expect(second).toMatchObject({ quoted_at: NOW, age_sec: 180, final_price_fen: 2990 });
  expect(second.link_id).not.toBe(first.link_id);
  expect(f.rows.map((row) => row.linkId)).toEqual([first.link_id, second.link_id]);
  expect(f.quote).toHaveBeenCalledTimes(2);
  expect(f.rows[0]).toMatchObject({
    viewer: { appId: APP_ID },
    ref: { productKey: PRODUCT_KEY, rawItemId: RAW_ID, source: 'detail' },
    item: {
      final_price_fen: 2990n,
      coupon_fen: 1000n,
      coupon_ids: 'synthetic-coupon',
      quoted_at: NOW,
    },
    quote: { rebateMinFen: 269n, rebateMaxFen: 269n, rebateBasis: 'normal' },
  });
});

it('[AC-B1-05e#2] 游客不要求登录，签发不带用户身份的商品引用', async () => {
  const f = fixture();
  f.current.mockResolvedValue({ appId: APP_ID, userId: null, deviceId: 'synthetic_guest' });
  const card = await f.get();
  expect(card.link_id).toBe(f.rows[0]?.linkId);
  expect(f.rows[0]?.viewer).toEqual({ appId: APP_ID, userId: null, deviceId: 'synthetic_guest' });
  expect(
    f.itemRefs.verify({ appId: APP_ID, productKey: PRODUCT_KEY, itemRef: card.item_ref }),
  ).toMatchObject({ rawItemId: RAW_ID, productKey: PRODUCT_KEY });
});

it.each([
  { name: '淘宝最后一段', productKey: PRODUCT_KEY, detail: item() },
  { name: '淘宝无分隔符', productKey: PRODUCT_KEY, detail: item({ item_id: 'synthetic001' }) },
  {
    name: '京东 item 模式',
    productKey: 'jd:i_synthetic001',
    detail: item({
      platform: 'jd',
      item_id: null,
      itemId: 'synthetic_synthetic001_tail',
      skuId: 'different_sku',
    }),
  },
  {
    name: '拼多多 goods_id',
    productKey: 'pdd:synthetic001',
    detail: item({
      platform: 'pdd',
      item_id: null,
      goods_id: 'synthetic001',
      goods_sign: 'synthetic-opaque-sign',
    }),
  },
])('[AC-B1-05e#3] 同一派生规则接受 $name，保存完整原串', async ({ productKey, detail }) => {
  const f = fixture();
  f.detail.mockResolvedValue(detail);
  const card = await f.get({ product_key: productKey });
  expect(card.product_key).toBe(productKey);
  const raw =
    detail.platform === 'jd'
      ? detail.itemId
      : detail.platform === 'pdd'
        ? detail.goods_sign
        : detail.item_id;
  expect(f.registerProductRef).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: APP_ID,
      productKey,
      rawItemId: raw,
      source: 'detail',
    }),
    expect.anything(),
  );
  expect(f.rows[0]?.ref.rawItemId).toBe(raw);
});

it('[AC-B1-05e#4] 京东 sku 全平台配置决定派生和原串，不按单条响应选模式', async () => {
  const f = fixture();
  f.detail.mockResolvedValue(
    item({ platform: 'jd', item_id: null, skuId: 'synthetic_sku', itemId: 'synthetic_other_tail' }),
  );
  const card = await getProduct(
    { product_key: 'jd:synthetic_sku' },
    {
      ...f.options,
      config: { configValue: async () => ({ value: 'sku', version: 1 }) },
    },
  );
  expect(card.product_key).toBe('jd:synthetic_sku');
  expect(f.rows[0]?.ref.rawItemId).toBe('synthetic_sku');
});

it.each([
  { name: '派生为另一商品', detail: item({ item_id: 'synthetic-other' }) },
  { name: '空派生结果', detail: item({ item_id: 'synthetic-' }) },
  { name: '缺少派生字段', detail: item({ item_id: null }) },
  { name: '非法字符不转义', detail: item({ item_id: 'synthetic-bad/value' }) },
  { name: '超长字段不截断', detail: item({ item_id: `synthetic-${'a'.repeat(129)}` }) },
  {
    name: '返回别的平台',
    detail: item({ platform: 'jd', item_id: null, itemId: 'synthetic_synthetic001_tail' }),
  },
])('[AC-B1-05e#5] $name 返回 30143，不能报价、登记错误商品或链接', async ({ detail }) => {
  const f = fixture();
  f.detail.mockResolvedValue(detail);
  await expect(f.get()).rejects.toMatchObject({ code: 30143 });
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.registerProductRef).not.toHaveBeenCalled();
});

it.each([
  new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
  new DemoUnionError('demo_delisted', 'synthetic demo off shelf', 'taobao'),
])('[AC-B1-05e#6] 联盟明确下架返回 30141，不冒充引用过期或暂时失败 %s', async (error) => {
  const f = fixture();
  f.detail.mockRejectedValue(error);
  await expect(f.get()).rejects.toMatchObject({ code: 30141 });
  expect(f.rows).toEqual([]);
  expect(f.registerProductRef).not.toHaveBeenCalled();
});

it.each([
  new UnionError('upstream_unavailable', 'synthetic dependency failure', 'taobao'),
  new UnionError('rate_limited', 'synthetic dependency throttled', 'taobao'),
  new GovernanceError('timeout', 'union:taobao:online', 'synthetic timeout'),
  new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic circuit open'),
])('[AC-B1-05e#7] 无缓存且联盟 %s 按暂时查不到返回 50401，不制造商品或快照', async (error) => {
  const f = fixture();
  f.detail.mockRejectedValue(error);
  await expect(f.get()).rejects.toMatchObject({ code: 50401 });
  expect(f.rows).toEqual([]);
  expect(f.registerProductRef).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
});

it.each(['feed', 'pool', 'tlj_pool', 'share'])(
  '[AC-B1-05e#8] 来源卡 %s 经 SourceLinkReader 按 App 范围读取并继承报价口径',
  async (source) => {
    const f = fixture();
    const sourceId = '01920000-0000-7000-8000-00000000d008';
    f.entrySource.mockResolvedValue(source);
    const card = await f.get({ from_link_id: sourceId });
    const normal = source !== null && ['feed', 'pool', 'tlj_pool', 'share'].includes(source);
    expect(f.entrySource).toHaveBeenCalledWith(APP_ID, sourceId);
    expect(card).toMatchObject({
      rebate_basis: normal ? 'normal' : 'price_compare_risk',
      rebate_min_fen: normal ? 269 : 135,
      rebate_max_fen: 269,
    });
    expect(f.rows[0]?.entrySource).toBe(source);
  },
);

// B1-05zc (D10-641): the inherited entry_source is still read and registered, but the sources the
// old table sent to price_compare_risk now quote on the normal basis too (one amount).
it.each(['search', 'parse', 'agent', null])(
  '[AC-B1-05e#8] 来源卡 %s 经 SourceLinkReader 按 App 范围读取并继承登记，报价一律单值',
  async (source) => {
    const f = fixture();
    const sourceId = '01920000-0000-7000-8000-00000000d008';
    f.entrySource.mockResolvedValue(source);
    const card = await f.get({ from_link_id: sourceId });
    expect(f.entrySource).toHaveBeenCalledWith(APP_ID, sourceId);
    expect(card).toMatchObject({
      rebate_basis: 'normal',
      rebate_min_fen: 269,
      rebate_max_fen: 269,
    });
    expect(f.rows[0]?.entrySource).toBe(source);
  },
);

it('[AC-B1-05e#9] 无来源卡详情按 normal 单值报价，来源记 detail、不读来源链接', async () => {
  const f = fixture();
  const card = await f.get();
  expect(card.rebate_basis).toBe('normal');
  expect(card.rebate_min_fen).toBe(card.rebate_max_fen);
  expect(f.quote).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ rebateBasis: 'normal' }),
  );
  expect(f.rows[0]?.entrySource).toBe('detail');
  expect(f.entrySource).not.toHaveBeenCalled();
});

it('[AC-B1-05e#10] 无券仍下发售价与返利，详情不返回已废弃的券失效错误', async () => {
  const f = fixture();
  f.detail.mockResolvedValue(item({ coupon_fen: 0n, final_price_fen: 3990n, coupon_ids: '' }));
  const card = await f.get();
  expect(card).toMatchObject({
    price_fen: 3990,
    coupon_fen: 0,
    final_price_fen: 3990,
    rebate_max_fen: 269,
    availability: 'ok',
  });
  expect(f.rows).toHaveLength(1);
});

it('[AC-B1-05e#11] product_refs 的接收时刻取联盟响应完成时的 Clock', async () => {
  const f = fixture();
  f.detail.mockImplementation(async () => {
    f.clock.advanceMs(2000);
    return item({ quoted_at: '2026-10-08T12:00:02+08:00' });
  });
  await f.get();
  expect(f.registerProductRef).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'detail',
      receivedAt: f.clock.now().toISOString(),
    }),
    expect.anything(),
  );
});

it('[AC-B1-05e#12] 登记失败不能返回未落库的 link_id', async () => {
  const f = fixture();
  const failure = new Error('synthetic registration failure');
  f.register.mockRejectedValue(failure);
  await expect(f.get()).rejects.toBe(failure);
  expect(f.rows).toEqual([]);
});

it('[AC-B1-05e#13] 商品引用记录不是价格缓存，联盟故障不能用它拼装详情', async () => {
  const f = fixture();
  f.readProductRef.mockResolvedValue(productRef());
  f.detail.mockRejectedValue(new UnionError('upstream_unavailable', 'synthetic failure', 'taobao'));
  await expect(f.get()).rejects.toMatchObject({ code: 50401 });
  expect(f.register).not.toHaveBeenCalled();
});
