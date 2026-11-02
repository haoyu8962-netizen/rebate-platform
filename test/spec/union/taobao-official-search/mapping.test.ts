import { expect, it, vi } from 'vitest';
import type {
  PriceAnomalyReason,
  TaobaoPriceOptions,
} from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import { mapTaobaoDetail } from '../../../../apps/api/src/modules/union/infra/taobao/goods.ts';
import {
  ALLOWED_ITEM_KEYS,
  couponIdOf,
  ctx,
  detailItemId,
  instant,
  mainPicOf,
  one,
  priceFields,
  promotion,
  search,
  searchBody,
  searchRow,
  searchRows,
  setup,
  shortTitleOf,
  smallPicsOf,
  titleOf,
  visible,
  type PromotionWindow,
  type Row,
  type RowParts,
} from './official-harness.ts';

// 映射（BR-PRICE-01、BR-PRICE-02、BR-PRICE-11）：逐字段挑，不 spread；三价走 mapTaobaoPrice，与
// mapTaobaoDetail 结果一致（含优惠时间窗与金额解析）；quoted_at 是收到搜索响应时的注入时钟；click_url、
// coupon_share_url、commission_amount 不外露。

const NOW = new Date(instant);
const NOW_MS = NOW.getTime();

/** A 13-digit millisecond string `offset` ms after the injected clock. */
function at(offset: number): string {
  return String(NOW_MS + offset);
}

/** The BR-PRICE-02 example: discount 39.90, one promotion of 5.00, promotion final 34.90. */
function windowed(title: string, window: PromotionWindow): RowParts {
  return {
    price: { zk_final_price: '39.90', final_promotion_price: '34.90' },
    promotions: [promotion(title, '5.00', 'syn-window-a', window)],
  };
}

it('[AC-B1-04zx#14] 一条完整映射：详情口径 item_id、title、三价、佣金 bp、类目、quoted_at、图片；只含允许的键', async () => {
  const item = await one(searchRow(1));
  expect(item).toMatchObject({
    platform: 'taobao',
    item_id: detailItemId(1),
    title: titleOf(1),
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    coupon_ids: couponIdOf(1),
    commission_rate_bp: 2050n,
    quoted_at: instant,
    price_status: 'ok',
    category_l1_id: '50008090',
    category_l1_name: '合成一级类目',
    main_image_url: mainPicOf(1),
    image_urls: smallPicsOf(1),
  });
  for (const key of Object.keys(item)) expect(ALLOWED_ITEM_KEYS.has(key), key).toBe(true);
  expect(item.title).not.toBe(shortTitleOf(1));
});

it('[AC-B1-04zx#15] 上游没给类目 → 不填类目字段，该行照常返回', async () => {
  const item = await one(
    searchRow(2, {
      basic: { level_one_category_id: undefined, level_one_category_name: undefined },
    }),
  );
  expect(item.item_id).toBe(detailItemId(2));
  expect(Object.hasOwn(item, 'category_l1_id')).toBe(false);
  expect(Object.hasOwn(item, 'category_l1_name')).toBe(false);
});

it.each([
  [
    '无优惠',
    { price: { zk_final_price: '25.80', final_promotion_price: '25.80' }, promotions: [] },
    2580n,
    0n,
  ],
  [
    '只有商品券',
    {
      price: { zk_final_price: '59.90', final_promotion_price: '49.90' },
      promotions: [promotion('商品券', '10.00', 'syn-coupon-a')],
    },
    5990n,
    1000n,
  ],
  [
    '只有 88VIP（加回）',
    {
      price: { zk_final_price: '59.90', final_promotion_price: '54.90' },
      promotions: [promotion('88VIP', '5.00', 'syn-member-a')],
    },
    5990n,
    0n,
  ],
  [
    '券 + 平台立减',
    {
      price: { zk_final_price: '100.00', final_promotion_price: '70.00' },
      promotions: [
        promotion('商品券', '20.00', 'syn-coupon-b'),
        promotion('百亿补贴', '10.00', 'syn-subsidy-b'),
      ],
    },
    9000n,
    2000n,
  ],
  [
    '两张券',
    {
      price: { zk_final_price: '30.00', final_promotion_price: '22.00' },
      promotions: [
        promotion('店铺券', '3.00', 'syn-coupon-z'),
        promotion('商品券', '5.00', 'syn-coupon-c'),
      ],
    },
    3000n,
    800n,
  ],
] as [string, Parameters<typeof searchRow>[1], bigint, bigint][])(
  '[AC-B1-04zx#16] %s：三价与 mapTaobaoDetail 对同样字段的结果相等（price %s、coupon %s）',
  async (_label, parts, price, coupon) => {
    const row = searchRow(3, parts);
    const item = await one(row);
    expect(item.price_status).toBe('ok');
    expect(item.price_fen).toBe(price);
    expect(item.coupon_fen).toBe(coupon);
    expect(item.final_price_fen).toBe(price - coupon);
    expect(priceFields(item)).toEqual(
      priceFields(mapTaobaoDetail(row, detailItemId(3), NOW, undefined)),
    );
  },
);

it.each([
  [
    '字段都合法但对不上账',
    searchRow(4, { price: { zk_final_price: '59.90', final_promotion_price: '40.00' } }),
    'calc_diff',
  ],
  [
    '未识别的优惠名',
    searchRow(4, {
      price: { zk_final_price: '59.90', final_promotion_price: '49.90' },
      promotions: [promotion('合成未知优惠', '10.00', 'syn-unknown-a')],
    }),
    'unknown_promo',
  ],
] as [string, Row, string][])(
  '[AC-B1-04zx#17] %s：不算非法行，与详情一样照样返回 price_status = anomaly（%s）、三价 0',
  async (_label, row, reason) => {
    const item = await one(row);
    expect(item).toMatchObject({
      item_id: detailItemId(4),
      price_status: 'anomaly',
      price_anomaly_reason: reason,
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
    });
    expect(priceFields(item)).toEqual(
      priceFields(mapTaobaoDetail(row, detailItemId(4), NOW, undefined)),
    );
  },
);

it('[AC-B1-04zx#18] 价格配置：搜索按 ctx.appId 读 BR-PRICE-02 配置，同样配置下与详情结果相等', async () => {
  const settings: TaobaoPriceOptions = { unknown_promo: 'add_back' };
  const read = vi.fn<(appId: string) => Promise<TaobaoPriceOptions>>(async () => settings);
  const row = searchRow(5, {
    price: { zk_final_price: '59.90', final_promotion_price: '49.90' },
    promotions: [promotion('合成未知优惠', '10.00', 'syn-unknown-b')],
  });
  const item = await one(row, { priceSettings: { read } });
  expect(read).toHaveBeenCalledWith(ctx.appId);
  expect(item.price_status).toBe('ok');
  expect(item.final_price_fen).toBe(5990n);
  expect(priceFields(item)).toEqual(
    priceFields(mapTaobaoDetail(row, detailItemId(5), NOW, settings)),
  );
});

it('[AC-B1-04zx#19] 金额是 JSON number 时先转最短十进制字符串再解析（BR-PRICE-01），结果与同值字符串一致', async () => {
  const asNumbers = searchRow(6, {
    price: { zk_final_price: 59.9, final_promotion_price: 59.9 },
    promotions: [],
  });
  const asStrings = searchRow(6, {
    price: { zk_final_price: '59.90', final_promotion_price: '59.90' },
    promotions: [],
  });
  const fromNumbers = await one(asNumbers);
  const fromStrings = await one(asStrings);
  expect(fromNumbers.price_status).toBe('ok');
  expect(fromNumbers.price_fen).toBe(5990n);
  expect(priceFields(fromNumbers)).toEqual(priceFields(fromStrings));
});

it.each([
  ['19.99', 19.99, 1999n],
  ['0.07', 0.07, 7n],
  ['1.1', 1.1, 110n],
] as [string, number, bigint][])(
  '[AC-B1-04zx#54] 金额是 JSON number %s：走同一解析，不用浮点乘 100',
  async (_label, amount, fen) => {
    const row = searchRow(6, {
      price: { zk_final_price: amount, final_promotion_price: amount },
      promotions: [],
    });
    const item = await one(row);
    expect(item.price_status).toBe('ok');
    expect(item.price_fen).toBe(fen);
    expect(item.final_price_fen).toBe(fen);
    expect(priceFields(item)).toEqual(
      priceFields(mapTaobaoDetail(row, detailItemId(6), NOW, undefined)),
    );
  },
);

it.each([
  ['zk_final_price', { price: { zk_final_price: 59.905 } }],
  ['final_promotion_price', { price: { final_promotion_price: 44.905 } }],
  ['promotion_fee', { promotions: [promotion('商品券', 10.005, 'syn-coupon-long')] }],
] as [string, RowParts][])(
  '[AC-B1-04zx#55] %s 是超两位小数的 JSON number：同详情判缺失，不舍入，该行 anomaly',
  async (_label, parts) => {
    const row = searchRow(6, parts);
    const item = await one(row);
    expect(item).toMatchObject({
      item_id: detailItemId(6),
      price_status: 'anomaly',
      price_anomaly_reason: 'missing_field',
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
    });
    expect(priceFields(item)).toEqual(
      priceFields(mapTaobaoDetail(row, detailItemId(6), NOW, undefined)),
    );
  },
);

it.each([
  ['商品券已过期（BR-PRICE-02 的例子）', '商品券', { end: at(-1) }, 'expired_item'],
  ['商品券结束时刻恰是取数时刻（右开）', '商品券', { end: at(0) }, 'expired_item'],
  ['商品券未开始', '商品券', { start: at(1) }, 'expired_item'],
  ['平台立减已过期', '秒杀直降', { end: at(-1) }, 'expired_item'],
  ['起止时间格式非法', '商品券', { end: '2026-11-01 00:00:00' }, 'missing_field'],
] as [string, string, PromotionWindow, PriceAnomalyReason][])(
  '[AC-B1-04zx#56] %s：不单独剔除该项，整行价格异常，与详情一致',
  async (_label, title, window, reason) => {
    const row = searchRow(6, windowed(title, window));
    const item = await one(row);
    expect(item).toMatchObject({
      item_id: detailItemId(6),
      price_status: 'anomaly',
      price_anomaly_reason: reason,
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
    });
    expect(priceFields(item)).toEqual(
      priceFields(mapTaobaoDetail(row, detailItemId(6), NOW, undefined)),
    );
  },
);

it.each([
  ['商品券在有效期内', '商品券', { start: at(-1000), end: at(1000) }, 3990n, 500n, 3490n],
  ['商品券开始时刻恰是取数时刻（左闭）', '商品券', { start: at(0) }, 3990n, 500n, 3490n],
  ['会员项已过期不影响（会员项不计入）', '88VIP', { end: at(-1) }, 3990n, 0n, 3990n],
] as [string, string, PromotionWindow, bigint, bigint, bigint][])(
  '[AC-B1-04zx#57] %s：三价正常，与详情一致',
  async (_label, title, window, price, coupon, final) => {
    const row = searchRow(6, windowed(title, window));
    const item = await one(row);
    expect(item).toMatchObject({
      price_status: 'ok',
      price_fen: price,
      coupon_fen: coupon,
      final_price_fen: final,
    });
    expect(priceFields(item)).toEqual(
      priceFields(mapTaobaoDetail(row, detailItemId(6), NOW, undefined)),
    );
  },
);

it('[AC-B1-04zx#58] 时间窗按收到搜索响应的时刻判（与 quoted_at 同一时刻）：发请求前未开始、换算时已结束都不算', async () => {
  const received = '2026-11-01T04:05:09.250Z';
  const converted = '2026-11-01T04:05:12.500Z';
  const h = setup({
    page: () =>
      searchBody(
        [
          searchRow(8, {
            price: { zk_final_price: '39.90', final_promotion_price: '34.90' },
            promotions: [
              promotion('商品券', '5.00', 'syn-window-b', {
                start: String(Date.parse(received)),
                end: String(Date.parse(converted)),
              }),
            ],
          }),
        ],
        1,
      ),
    onSearchSend: (clock) => clock.set(received),
    onDetailSend: (clock) => clock.set(converted),
  });
  const page = await search(h);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    quoted_at: received,
    price_status: 'ok',
    price_fen: 3990n,
    coupon_fen: 500n,
    final_price_fen: 3490n,
  });
});

it.each([
  ['2050', 2050n],
  ['1', 1n],
  ['0', 0n],
  ['10000', 10_000n],
] as [string, bigint][])(
  '[AC-B1-04zx#20] commission_rate 万分比串 %j → commission_rate_bp %s',
  async (rate, bp) => {
    const item = await one(searchRow(7, { income: { commission_rate: rate } }));
    expect(item.commission_rate_bp).toBe(bp);
  },
);

it('[AC-B1-04zx#21] quoted_at = 收到搜索响应时的注入时钟（不是请求前，也不是换算响应时）', async () => {
  const received = '2026-11-01T04:05:09.250Z';
  const h = setup({
    page: () => searchBody([searchRow(8)], 1),
    onSearchSend: (clock) => clock.set(received),
    onDetailSend: (clock) => clock.set('2026-11-01T04:05:12.500Z'),
  });
  const page = await search(h);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.quoted_at).toBe(received);
});

it('[AC-B1-04zx#22] click_url、coupon_share_url、commission_amount、short_title、volume 不映射不外露（任何字段、序列化与打印都看不到）', async () => {
  const { page } = await searchRows([searchRow(1), searchRow(2)]);
  expect(page.items).toHaveLength(2);
  const shown = visible(page);
  for (const marker of ['synthetic-click', 'synthetic-share', '7.77', '合成短标题']) {
    expect(shown, marker).not.toContain(marker);
  }
  for (const item of page.items) {
    for (const key of Object.keys(item)) expect(ALLOWED_ITEM_KEYS.has(key), key).toBe(true);
  }
});

it('[AC-B1-04zx#23] 标题、图片、价格、佣金取搜索条目，不取换算详情里的同名字段', async () => {
  const item = await one(searchRow(9));
  expect(item.title).toBe(titleOf(9));
  expect(item.main_image_url).toBe(mainPicOf(9));
  expect(visible(item)).not.toContain('TOP-only');
  expect(item.price_fen).toBe(5990n);
  expect(item.commission_rate_bp).toBe(2050n);
});
