import { expect, it } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import {
  checkQueryIdentity,
  feedCursor,
  mapPddGoods,
  parseFeedCursor,
  parseSearchCursor,
  searchCursor,
} from './goods.ts';

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04u-UNIT#1] 搜索游标往返保留页码与 list_id，畸形游标 invalid_dto', () => {
  expect(parseSearchCursor(searchCursor(2, 'unit-list/列表'))).toEqual({
    page: 2,
    listId: 'unit-list/列表',
  });
  expect(parseSearchCursor(searchCursor(3, null))).toEqual({ page: 3, listId: null });
  for (const bad of ['pdd-search:1:', 'pdd-search:0:', 'pdd-search:2:a+b', 'pdd-feed:20', '']) {
    expect(code(() => parseSearchCursor(bad))).toBe('invalid_dto');
  }
});

it('[AC-B1-04u-UNIT#2] 物料游标只接受正偏移', () => {
  expect(parseFeedCursor(feedCursor(40))).toBe(40);
  for (const bad of ['pdd-feed:0', 'pdd-feed:-1', 'pdd-feed:01', 'pdd-search:2:']) {
    expect(code(() => parseFeedCursor(bad))).toBe('invalid_dto');
  }
});

it('[AC-B1-04u-UNIT#3] 查询身份原样透传，非对象或缺字段 invalid_identity', () => {
  expect(checkQueryIdentity({ pid: 'unit-pid', customParameters: '{"uid":"u"}' })).toEqual({
    pid: 'unit-pid',
    custom_parameters: '{"uid":"u"}',
  });
  for (const bad of [null, 'x', { pid: 'unit-pid' }, { customParameters: '{}' }]) {
    expect(code(() => checkQueryIdentity(bad))).toBe('invalid_identity');
  }
});

it('[AC-B1-04zzf-UNIT#1] 商品行图片取 goods_image_url / goods_gallery_urls 并清洗，缩略图与同名字段不用', () => {
  const host = 'https://img.synthetic.invalid';
  const row = {
    goods_id: 1,
    goods_sign: 'unit-sign',
    goods_name: 'unit',
    min_group_price: 1000,
    coupon_discount: 0,
    promotion_rate: 100,
    goods_image_url: `${host}/main.jpg`,
    goods_gallery_urls: [`${host}/a.jpg`, 'http://x/b.jpg', `${host}/a.jpg`],
    goods_thumbnail_url: `${host}/thumb.jpg`,
    main_image_url: `${host}/spoof.jpg`,
    image_urls: [`${host}/spoof.jpg`],
  };
  const now = new Date('2026-11-04T00:00:00Z');
  const mapped = mapPddGoods(row, 'search', now, () => undefined);
  expect(mapped.main_image_url).toBe(`${host}/main.jpg`);
  expect(mapped.image_urls).toEqual([`${host}/a.jpg`]);
  const bare = mapPddGoods(
    { ...row, goods_image_url: null, goods_gallery_urls: undefined },
    'detail',
    now,
    () => undefined,
  );
  expect(Object.hasOwn(bare, 'main_image_url')).toBe(false);
  expect(Object.hasOwn(bare, 'image_urls')).toBe(false);
});

function detailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goods_id: 7,
    goods_sign: 'unit-sign',
    goods_name: 'unit',
    min_group_price: 2000,
    coupon_discount: 300,
    coupon_min_order_amount: 1000,
    coupon_start_time: 1_759_000_000,
    coupon_end_time: 1_760_111_999,
    promotion_rate: 100,
    sales_tip: '2万+',
    mall_img_url: 'https://img.synthetic.invalid/unit/logo.png',
    desc_txt: '高',
    serv_txt: '中',
    lgst_txt: '低',
    mall_id: 4321,
    ...overrides,
  };
}

const unitNow = new Date('2025-10-01T00:00:00Z');

it('[AC-B1-04zzm-UNIT#1] 详情五字段：券结束 +08:00、销量与 logo 原样、三项评分、mall_id 十进制；搜索行不带', () => {
  const mapped = mapPddGoods(detailRow(), 'detail', unitNow, () => undefined);
  expect(mapped.coupon_fen).toBe(300n);
  expect(mapped.coupon_end_at).toBe('2025-10-10T23:59:59+08:00');
  expect(mapped.sales_text).toBe('2万+');
  expect(mapped.shop_logo).toBe('https://img.synthetic.invalid/unit/logo.png');
  expect(mapped.shop_scores).toEqual([
    { key: 'desc', value: '高' },
    { key: 'serv', value: '中' },
    { key: 'lgst', value: '低' },
  ]);
  expect(mapped.shop_ref).toBe('4321');
  const search = mapPddGoods(detailRow(), 'search', unitNow, () => undefined);
  for (const name of ['coupon_end_at', 'sales_text', 'shop_logo', 'shop_scores', 'shop_ref']) {
    expect(Object.hasOwn(search, name), name).toBe(false);
  }
});

it('[AC-B1-04zzm-UNIT#2] 券不计入（门槛不够）时不出结束时刻；空白评分与非正整数 mall_id 不出', () => {
  const mapped = mapPddGoods(
    detailRow({ coupon_min_order_amount: 2500, serv_txt: ' ', mall_id: '4321' }),
    'detail',
    unitNow,
    () => undefined,
  );
  expect(mapped.coupon_fen).toBe(0n);
  expect(Object.hasOwn(mapped, 'coupon_end_at')).toBe(false);
  expect(mapped.shop_scores).toEqual([
    { key: 'desc', value: '高' },
    { key: 'lgst', value: '低' },
  ]);
  expect(Object.hasOwn(mapped, 'shop_ref')).toBe(false);
});

it('[AC-B1-04zzw-UNIT#1] 搜索 / 详情 / 物料流：cat_ids[0] → category_l1_id 十进制字符串，不出一级名称，不用 cat_id', () => {
  for (const source of ['search', 'detail', 'feed'] as const) {
    const mapped = mapPddGoods(
      detailRow({ cat_ids: [8569, 8439, 8581], cat_id: 1234 }),
      source,
      unitNow,
      () => undefined,
    );
    expect(mapped.category_l1_id, source).toBe('8569');
    expect(Object.hasOwn(mapped, 'category_l1_name'), source).toBe(false);
  }
});

it('[AC-B1-04zzw-UNIT#2] cat_ids 缺失、非数组、空、首项不合格 → 不出 category_l1_id，不回退、不告警', () => {
  const bad: readonly unknown[] = [
    undefined,
    null,
    [],
    '8569',
    8569,
    [0, 8439],
    [-1, 8439],
    [1.5, 8439],
    [2 ** 53, 8439],
    ['08569', 8439],
    ['\u00A08569', 8439],
    ['8569\u3000', 8439],
    ['+8569', 8439],
    [null, 8439],
  ];
  for (const cats of bad) {
    const anomalies: unknown[] = [];
    const mapped = mapPddGoods(detailRow({ cat_ids: cats, cat_id: 1234 }), 'search', unitNow, (r) =>
      anomalies.push(r),
    );
    expect(Object.hasOwn(mapped, 'category_l1_id'), String(cats)).toBe(false);
    expect(mapped.price_status).toBe('ok');
    expect(anomalies).toEqual([]);
  }
});
